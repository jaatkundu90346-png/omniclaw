// Network bootstrap — must run BEFORE anything issues an outbound request.
//
// Field-diagnosed failure (2026-07-31, Mankush's Windows box): every call to
// api.telegram.org died with `fetch failed / Connect Timeout Error (attempted
// addresses: 149.154.166.110:443, 64:ff9b::959a:a66e:443, timeout: 10000ms)`
// while a raw `net.connect` to that very same IPv4 succeeded in under a second.
//
// Cause: the resolver hands back an IPv4 address AND a NAT64-synthesised IPv6
// one (the `64:ff9b::/96` prefix is a translation address, not a real route).
// This network has no NAT64 gateway, so the v6 leg black-holes. Node enables
// Happy Eyeballs (`autoSelectFamily`) by default since v20, undici races both
// legs, the v6 leg never fails fast, and the whole connect burns its 10s budget
// and gives up — even though the v4 leg was fine. Hosts that only publish A
// records (example.com) kept working, which is why this looked like "Telegram
// is blocked" rather than a stack-wide bug.
//
// Symptoms this fixes:
//   - Telegram channel/adapter never connects ("fetch failed", 0 updates)
//   - build_tool / Tool Forge tools report "no network access"
//   - any provider or MCP host whose DNS returns a NAT64 v6 address
//
// Escape hatches (in precedence order):
//   OMNICLAW_NETWORK_FAMILY=auto   — leave Node's defaults completely alone
//   OMNICLAW_NETWORK_FAMILY=ipv6   — prefer IPv6 (true dual-stack networks)
//   OMNICLAW_NETWORK_FAMILY=ipv4   — force the fix on (default)

import dns from "node:dns";
import net from "node:net";

let applied = null;

export function applyNetworkBootstrap({ family = process.env.OMNICLAW_NETWORK_FAMILY } = {}) {
  const mode = String(family || "ipv4").trim().toLowerCase();

  if (mode === "auto") {
    applied = { mode: "auto", resultOrder: "node-default", autoSelectFamily: net.getDefaultAutoSelectFamily?.() ?? true };
    return applied;
  }

  const resultOrder = mode === "ipv6" ? "ipv6first" : "ipv4first";
  dns.setDefaultResultOrder(resultOrder);

  // The decisive half. Leaving Happy Eyeballs on means a dead NAT64 leg still
  // eats the connect timeout no matter which family we sort first — the
  // measured failure above already had the IPv4 address listed first.
  net.setDefaultAutoSelectFamily?.(false);

  applied = { mode, resultOrder, autoSelectFamily: false };
  return applied;
}

export function getNetworkBootstrap() {
  return applied;
}

// Self-apply on import. ESM evaluates every import before the importing
// module's own body, so a plain `applyNetworkBootstrap()` call in server.js
// would land AFTER sibling modules have already initialised. Importing this
// file first is the only ordering that reliably beats them to the socket.
applyNetworkBootstrap();

export default applyNetworkBootstrap;
