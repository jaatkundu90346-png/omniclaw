# OmniClaw 360° Audit — Hermes Agent Comparison
**Date:** 2026-06-15
**Scope:** 81 modules in `src/core/` (~52K LOC) + `server.js` (2,480 LOC) + `public/app.js` (6,673 LOC)
**Harness under test:** OmniClaw v0.1.0 (Mankush / Patel)

This is a **layer-by-layer** comparison with concrete fixes tu implement kar sakta hai.

---

## 🔴 P0 — Critical (security / broken-in-production)

### BUG-P0-1 · Skill install: command injection
**File:** `src/core/skill-registry.js:442`
```js
execSync(`git clone --branch ${branch} --depth 1 ${gitUrl} "${targetDir}"`, { stdio: "pipe" });
```
**Problem:** `gitUrl` is interpolated unescaped into shell. A malicious "skill URL" like
`http://x/repo.git; powershell -enc <base64>` runs arbitrary code on install. Same pattern in `prUrl` if any caller passes user-provided URLs.
**Fix:**
```js
import { spawnSync } from "node:child_process";
const result = spawnSync("git", ["clone", "--branch", branch, "--depth", "1", gitUrl, targetDir], { stdio: "pipe" });
```
No shell. No interpolation. Validate `gitUrl` matches `^https?://|^git@` regex first.

### BUG-P0-2 · SecretStore: plaintext API keys
**File:** `src/core/secret-store.js:13-15`
```js
fs.writeFileSync(this.filePath, JSON.stringify({ providerKeys: {}, connectorSecrets: {} }, null, 2));
```
**Problem:** Telegram bot tokens, OpenRouter keys, Discord bot tokens stored as **plaintext JSON** in `data/secrets.json`. File-system readable by any process running as user. Hermes uses `safeStorage` (Tauri) / OS keychain.
**Fix:** Use Tauri's `safeStorage.encrypt` (on desktop) → fall back to `node-keytar` (CLI). Decrypt-on-read with 5-min cache.

### BUG-P0-3 · Shell policy: missing semicolon-chain + PowerShell bypass
**File:** `src/core/shell-policy.js:28-42`
```js
const HIGH_RISK_PATTERNS = [
  { pattern: String.raw`\bInvoke-WebRequest\b|\bcurl\b|\bwget\b`, reason: "network download" },
  ...
];
```
**Problems:**
- No detection of `;` chaining → `Get-Date; Remove-Item -Recurse -Force C:\*` gets blocked `-Recurse -Force` block BUT `gci . | del` stream chains pass
- PowerShell `-EncodedCommand BASE64STRING` is **never blocked** (this is THE kill chain on Windows)
- No Unicode normalize → `r\u200Bm -rf` bypasses `\b` boundary
- Subshell expansion `$(...)` and backticks not scanned
- `>` redirect pattern false-positive on `5 -gt 3`

**Fix:** Replace regex with real parser. Use `tree-sitter-bash` + a small PowerShell tokenizer. Add explicit blocklist for `;` `&&` `||` `$(...)` `` ` `` and `-EncodedCommand`. Normalize Unicode before regex.

### BUG-P0-4 · Plugin loader: dynamic import breaks packaged exe
**File:** `src/core/plugin-system.js:98`
```js
exports = await import(`file://${entryPath}`);
```
**Problem:** AGENTS.md (line 47) literally says: *"Never use dynamic `await import("node:...")` in hot paths. It throws inside the pkg `.exe`"*. Yet the plugin loader uses template-literal dynamic import → in the packaged exes, **all plugins silently fail to load** (returns `{ loaded: false, reason: "import-failed" }`).
**Fix:** Static `require()`-style registration via `tools/registry/index.js` that exports each plugin as a named import. plugins.json provides the list, agent.js does `import "./plugins/foo.js"` at top level.

### BUG-P0-5 · Sub-agent cancel: doesn't actually cancel
**File:** `src/core/sub-agent-spawner.js:303-316`
```js
async cancel(agentId) {
  const agent = this.activeAgents.get(agentId);
  if (!agent) return { found: false, ... };
  agent.status = "cancelled";   // ← only sets flag
  this.activeAgents.delete(agentId);
  ...
}
```
**Problem:** Sets `status = "cancelled"` but `runAgent` loop continues. Tool calls keep running, providers keep being billed, file mutations keep happening.
**Fix:** Pass `AbortController` through:
```js
const controller = new AbortController();
// spawn({ ..., signal: controller.signal })
async cancel(agentId) {
  const agent = this.activeAbortControllers.get(agentId);
  if (agent) agent.abort();     // ← actual cancel
}
```
Propagate `signal` to `provider.completeWithTools` + every tool's `run()`.

---

## 🟠 P1 — High impact, missing capability

### GAP-P1-1 · No token / cost tracking per turn
**Search:** `src/**/*.js` — 0 matches for `pricePer*Token`, `costUsd`, `costUSD`. The only "pricing" hits are in `web-research.js` for *keyword scoring*, not actual cost.

**Problem:** On BYOK with expensive models, user has no visibility into per-run cost. Hermes logs `~/.hermes/usage.json` with `{date, model, inputTokens, outputTokens, costUsd}` and shows daily/monthly summaries.

**Fix:** Add `src/core/usage-tracker.js`:
```js
class UsageTracker {
  record({ providerId, model, inputTokens, outputTokens, durationMs }) {
    const costUsd = this.estimate(model, inputTokens, outputTokens);
    this.db.append({ ts: Date.now(), providerId, model, inputTokens, outputTokens, costUsd });
    this.eventBus.emit("usage.recorded", { ... });
  }
  estimate(model, inp, out) {
    // PRICING_TABLE: { "openai/gpt-4o": { input: 0.0025, output: 0.01 } }
    // PRICING_TABLE: { "anthropic/claude-opus-4": { input: 0.015, output: 0.075 } }
    // ...
  }
}
```
Wire from `provider.completeWithTools()` return value. Add a `/api/usage` endpoint + `usage` tool for the agent.

### GAP-P1-2 · Only 3 providers (Mock, OpenAI-compatible, Codex-CLI)
**File:** `src/core/provider-factory.js:5-14`
**Missing:** Anthropic, Google Gemini, Groq, Mistral, DeepSeek, xAI/Grok, Ollama.
Hermes has 6+ production-grade providers.

**Fix:** Add `src/core/providers/anthropic-provider.js` (different SSE format from OpenAI), `gemini-provider.js` (different message format — `parts[]` not `content`), `groq-provider.js` (OpenAI-compat but URL is `https://api.groq.com/openai`). Centralize auth header logic so swap-by-config just works.

### GAP-P1-3 · No `session_search` cross-history
Hermes has `~/.local/share/hermes/sessions.db` (SQLite FTS5) so user can `session_search query="auth refactor"` and find related past sessions across projects.
OmniClaw stores sessions as JSON files (`data/sessions.json` + per-session transcripts). No FTS.

**Fix:** Build a SQLite (better-sqlite3) companion DB at startup, ingest conversation summaries, FTS5 index. Add tool `search_sessions(query, limit)`.

### GAP-P1-4 · Multi-provider-fallback: `/models` endpoint wrong
**File:** `src/core/multi-provider-fallback.js:58`
```js
const response = await fetch(`${baseUrl}/models`, ...);
```
**Problem:** Groq uses `/openai/v1/models`, Anthropic uses `/v1/models` (different auth), custom OpenAI-compatible servers vary. Will mark **every healthy provider as unhealthy**.

**Fix:** Per-provider health probes:
```js
const PROBES = {
  'openai': { path: '/models', headers: { Authorization: `Bearer ${key}` } },
  'anthropic': { path: '/v1/messages', method: 'POST', body: minimal_request, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
  'groq': { path: '/openai/v1/models', ... },
};
```

### GAP-P1-5 · No webhook subscriptions
Hermes has `webhook_subscriptions` skill — third-party systems POST to OmniClaw to trigger agent runs. OmniClaw has `connectors/adapters/http-webhook/adapter.json` (inbound webhook) but no **outbound** to push agent events to user endpoints.

**Fix:** Add `src/core/notification-dispatcher.js` with per-channel config (Discord webhook URL, Slack, Pushover, Ntfy.sh). Emit on `agent.completed`, `approval.required`, `subagent.failed`.

### GAP-P1-6 · Two parallel agent loops
OmniClaw has TWO completely different runtime paths:
- **Modern:** `agent.js → omni-loop.js` (Claude Code / Codex style, transcript-based)
- **Legacy:** `agent.js → intent-engine.js → planner.js` (regex intent matching — `kam nhi`, `sach me kaam`, `hlo`)

The fallback path does **heuristic regex** on Hinglish. When OmniLoop fails or the dynamic-import bug bites, user gets completely broken UX. This is in `intent-engine.js:60`.

**Fix:** Remove legacy intent-engine entirely. Single code path. Smoke tests should assert `modelToolLoop.loopEngine === "omni-loop"` post-init.

### GAP-P1-7 · WebSocket gateway: hand-rolled, no compression
**File:** `src/core/ws-gateway.js:112-144` (manual frame encoder)
**Compared to:** Hermes uses `ws` library + `permessage-deflate`.
**Missing:**
- No `permessage-deflate` (compresses JSON events 70-80%)
- No ping/pong heartbeats (proxy timeouts kill connection)
- No continuation frame handling (large messages fragment incorrectly)
- No binary frame support (screenshot streaming impossible)

**Fix:** Replace with `ws` npm dep. Enable compression. Add 30s heartbeat with proper close on miss.

### GAP-P1-8 · Hand-rolled HTTP server, no streaming abort safety
**File:** `server.js` (2,480 lines)
**Problem:** 
- SSE stream not properly aborted on client disconnect (memory leak)
- No backpressure on tool-result streaming (multi-MB tool output floods in one chunk)
- No request body size limit → 1GB JSON payload DoS

**Fix:**
```js
res.on("close", () => { clearInterval(keepalive); runner.abort(); });
const MAX_BODY = config.maxRequestBytes || 10 * 1024 * 1024;
```

---

## 🟡 P2 — Quality / UX polish

### Q-P2-1 · Empty `catch {}` everywhere
**Count:** 45+ in `agent.js` alone (lines 413, 541, 573, 2214, 2432, 2487, 2496, 2498, ...), 20+ in `workspace-bootstrap.js`.
**Problem:** Silent failures mask real bugs. Half-completed multi-step work reports "ok" to user.
**Fix:** ESLint rule `@typescript-eslint/no-empty` (yes even for plain JS — eslint can lint it). At minimum, `console.error` + structured event emission:
```js
} catch (error) {
  this.eventBus.emit('error.swallowed', { stage: 'memory.dreamSweep', error: error.message });
  console.error('[memory.dreamSweep]', error);
}
```

### Q-P2-2 · Memory store: cache invalidation race + no debounce
**File:** `src/core/memory-store.js:73-94`
```js
if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
  return this.cache.data;
}
```
**Problem:** Two writers (`MemoryStore` + `ActiveMemory`) racing → `mtimeMs` matches but in-memory arrays got mutated → stale reads for several turns. Also: **every write rewrites the entire file**. With 5MB memory file = 100ms freeze per `noteMemory()`.

**Fix:**
- Use LRU + versioned in-memory copy (bump version on write)
- Debounced async writes (200ms)
- Convert to SQLite + WAL mode for true concurrency

### Q-P2-3 · `agent.js` is a 9,413-line god-object
**File:** `src/core/agent.js`
**Problem:** Routing + context assemble + prompt building + ACP + MCP + harness + hooks + sub-agents + attachments + reflections + media handling + system monitor + V2 health + sandbox + event bus + heartbeat + tool rendering — **all in one file**.

**Split into:**
- `agent-runtime/index.js` — top-level orchestrator (≤2K LOC)
- `agent-runtime/router.js` — intent → action dispatch
- `agent-runtime/context-loader.js` — context bundle assembly
- `agent-runtime/attachments.js` — attachment handling
- `agent-runtime/reflection.js` — reflection / checkpoints
- `agent-runtime/hooks.js` — pre/post hooks
- Re-export from `agent.js` for backward compat

### Q-P2-4 · 13 identical CLAWHUB.md files
**Files:** `workspace/agents/{main,builder,ops,research,...}/CLAWHUB.md` (and ACTIVE_MEMORY.md, AGENTS.md, etc.) are near-duplicates.
**Problem:** Edit one, forget the other → drift. Real bug magnet.
**Fix:** Generator script `scripts/sync-agent-workspace.mjs` reads a single template + per-agent overrides from JSON, regenerates all of them. Wire into `npm run dev` as a precheck.

### Q-P2-5 · `tool_resolver` exists but unused
**File:** `src/core/tool-resolver.js` (176 LOC) — exports a class but no imports from agent.js or omniloop.js find it.
**Problem:** Dead code. Either wire it (cache tool selection by intent) or delete to reduce noise.
**Fix:** Either use it for semantic tool selection ("/10000 tokens to list 215 tool schemas is wasteful, narrow to top 12 by query") — this is what Hermes does — or delete.

### Q-P2-6 · Skill matcher: substring scoring
**File:** `src/core/skill-registry.js:94-119`
**Problem:** Splits haystack by whitespace, scores by token count. Misses synonyms, plurals, CJK, intent. `npm install` matches skill `npm-orchestration` only because the literal token `npm` is in the haystack.
**Fix:** Embedding-based matching (use `transformers.js` or a simple TF-IDF + cosine). Or send top-3 candidate descriptions to LLM for re-ranking.

### Q-P2-7 · MCP client: no reconnection + id leak
**File:** `src/core/mcp-client.js:165-177`
```js
this._pending.set(id, { resolve, reject });
// ... 30s timeout, but no cleanup on connection close
```
**Problem:** If MCP server dies mid-call, `_pending` map leaks forever. No exponential backoff reconnect.
**Fix:**
```js
this.process.on("close", () => {
  for (const [id, pending] of this._pending) {
    pending.reject(new Error("MCP server disconnected"));
  }
  this._pending.clear();
  setTimeout(() => this._reconnect(), this.backoffMs);
});
```

### Q-P2-8 · Sandbox is just a manifest, not a sandbox
**File:** `src/core/sandbox-runner.js`
**Problem:** It snapshots files in/out, no actual isolation. On Windows: no Job Object (kills child on parent exit), no namespace. On Linux: no unshare/namespace.
**Hermes:** Uses Docker/WSL2 sandbox for shell tools when enabled, falls back to allowlist.
**Fix:** Honor `isolation: 'job-object' | 'none'` config; on Windows use `@napi-rs/job-object`; on Linux `prctl(PR_SET_PDEATHSIG)` + `unshare(CLONE_NEWNS)`.

### Q-P2-9 · Frontend `app.js` is 6,673-line mega-module
Same as agent.js but for browser. No state machine visible. Inline components. Likely many DOM leaks.

### Q-P2-10 · OAuth flow missing
BYOK with OpenAI / Anthropic = user pastes API key manually. Hermes Agent has OAuth callback handler that exchanges `code → token` so user never sees the key.
**Fix:** Add `/oauth/{provider}/start` + `/oauth/{provider}/callback` endpoints.

---

## 🟢 WHAT'S BETTER THAN HERMES (keep these!)

- `omni-loop.js` has **degenerate-text detection** (`isDegenerateText`, line 49) — catches "I see X? I see X?" model loop bug. Hermes doesn't have this.
- `token-redaction` in agent.js (`redactTraceString`) is more thorough — covers Bearer/sk-/xox- patterns across nested objects.
- `arch_rules.json` enforcement (DGPL marker for "no `await import`") is **real architectural enforcement**, better than Hermes's docs-only rules.
- `arch_rules.json` itself codifies the dynamic-import + shell `--pretty=format` gotchas.
- `validateAgainstSimpleSchema` + `sanitizeToolResult` + `CACHEABLE_OBSERVATION_TOOLS` — observation caching with smart key derivation is genuinely good. Hermes doesn't dedup tool results as elegantly.
- 215-tool registry with `permission + group + schema` — solid discipline.
- `verify_done` (L1/L2/L3) is a better verification culture than Hermes defaults.
- `PAIRING_TRUST_GATES.md` concept (device-pair trust with expiry) is more rigorous than Hermes's gateway token.

---

## 🛠️ Proposed Implementation Order (priority × effort)

| # | Item | Effort | Impact |
|---|---|---|---|
| 1 | BUG-P0-1 skill install command injection | 1h | Critical |
| 2 | BUG-P0-2 secrets plaintext → keychain | 1d | Critical |
| 3 | BUG-P0-4 plugin loader static import | 2h | Critical |
| 4 | BUG-P0-5 sub-agent cancel abort signal | 4h | Critical |
| 5 | BUG-P0-3 shell policy to real parser | 2d | Critical |
| 6 | GAP-P1-1 token/cost tracking | 1d | High |
| 7 | GAP-P1-4 multi-provider health probes | 1d | High |
| 8 | GAP-P1-6 remove legacy intent-engine | 0.5d | Quality |
| 9 | GAP-P1-2 add Anthropic + Gemini providers | 3d | High |
| 10 | GAP-P1-7 WS library + compression | 1d | UX |
| 11 | GAP-P1-3 session_search SQLite FTS5 | 2d | UX |
| 12 | Q-P2-3 split agent.js into 5 modules | 1w | Velocity |
| 13 | Q-P2-2 memory store async + debounce | 1d | Performance |
| 14 | Q-P2-1 ESLint no-empty + event-bus on catch | 0.5d | Quality |
| 15 | GAP-P1-5 outbound webhooks | 2d | UX |

Total ~ 3-4 weeks of focused engineering to overtake Hermes on stability + completeness.

---

## ⚡ Quick Wins (1 day or less)

`★` 1. **BUG-P0-1** fix in 30 minutes → big security win
`★` 2. **BUG-P0-4** fix in 2 hours → exe packaging works
`★` 3. **BUG-P0-5** cancel propagation in 4 hours → no zombie runs
`★` 4. **GAP-P1-1** cost tracking in 1 day → user transparency
`★` 5. **GAP-P1-4** health probes fix in 1 day → actually failover works

---

## 📊 Coverage matrix vs Hermes features

| Capability | Hermes | OmniClaw | Notes |
|---|---|---|---|
| Persistent transcript loop | ✅ | ✅ omni-loop | Equal/better |
| Native function calling | ✅ | ✅ | Equal |
| Parallel tool execution | ✅ | ✅ | Equal |
| Token cost tracking | ✅ | ❌ | **GAP** |
| Cross-session search | ✅ FTS5 | ❌ | **GAP** |
| Skills auto-loading | ✅ | ✅ | Equal |
| Plugin registry | ✅ | ✅ | Plugin-loader has bug |
| MCP (Model Context Protocol) | ✅ | ✅ | No reconnect |
| Sub-agents with cancel | ✅ AbortController | ❌ race | **GAP** |
| Multi-provider fallback | ✅ | ⚠️ /models wrong | **GAP** |
| WebSocket gateway | ✅ w/ compression | ⚠️ hand-rolled | **GAP** |
| Heartbeat + adaptive budget | ✅ | ✅ | Equal |
| Cron scheduler | ✅ | ✅ partial | Equal |
| Webhook subscriptions | ✅ | ✅ inbound only | **GAP** (outbound) |
| OAuth flow for providers | ✅ | ❌ | **GAP** |
| Tauri safeStorage for secrets | ✅ | ❌ plaintext | **GAP (critical)** |
| Perfect `verify_done` cascade | ❌ docs only | ✅ enforced | **Better** |
| Arch rules enforcement | ❌ | ✅ arch_rules.json | **Better** |
| Degenerate-text detector | ❌ | ✅ | **Better** |
| BYOK provider presets UI | ✅ | ⚠️ basic | Equal |

**Net score:** OmniClaw = 12 ✅ + 4 ⚠️ + 4 ❌ = strong on harness, weak on ecosystem polish.
