// network-egress-smoke — guards the NAT64/Happy-Eyeballs regression.
//
// 2026-07-31: Telegram and every Tool Forge fetch failed with "fetch failed /
// Connect Timeout Error" because the resolver returns a dead `64:ff9b::` NAT64
// address alongside a perfectly good IPv4 one, and Node's default
// autoSelectFamily races them without failing the v6 leg fast. See
// src/core/network-bootstrap.js. This smoke fails loudly if that bootstrap ever
// stops being applied or stops working.
//
//   node scripts/network-egress-smoke.mjs

import "../src/core/network-bootstrap.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { getNetworkBootstrap } from "../src/core/network-bootstrap.js";
import { ToolForge } from "../src/core/tool-forge.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. The bootstrap actually ran and disabled Happy Eyeballs.
const boot = getNetworkBootstrap();
check("network bootstrap applied", Boolean(boot), JSON.stringify(boot));
check(
  "autoSelectFamily disabled",
  net.getDefaultAutoSelectFamily?.() === false,
  `got ${net.getDefaultAutoSelectFamily?.()}`,
);

// 2. A dual-stack host whose v6 leg is NAT64-synthesised must resolve+connect.
//    Telegram is the exact host that regressed, and /getMe with a bogus token
//    is a free, unauthenticated-safe endpoint that returns a definite 401.
async function probe(label, url, expectStatus) {
  const started = Date.now();
  try {
    const res = await fetch(url);
    check(label, res.status === expectStatus, `HTTP ${res.status} in ${Date.now() - started}ms`);
  } catch (error) {
    check(label, false, `${error.message} (${error.cause?.message || error.cause?.code || "-"}) after ${Date.now() - started}ms`);
  }
}

await probe("telegram api reachable", "https://api.telegram.org/bot0:INVALID/getMe", 401);
await probe("plain https reachable", "https://example.com", 200);

// 3. The sandbox a forged tool actually runs in must see the same network.
const forge = new ToolForge({ rootDir });
try {
  const { result } = await forge.execute(
    `async function run(input, api) {
       const res = await api.fetch("https://api.telegram.org/bot0:INVALID/getMe");
       return { status: res.status, ok: res.body.includes("Unauthorized") };
     }`,
    {},
  );
  check("forged tool has network access", result?.status === 401 && result?.ok === true, JSON.stringify(result));
} catch (error) {
  check("forged tool has network access", false, error.message);
}

console.log(failures === 0 ? "\nnetwork-egress-smoke: all checks passed" : `\nnetwork-egress-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
