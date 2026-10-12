// Tool Forge — ADA-style self-tool-building for OmniClaw.
//
// The power (Mankush): "agar user ke task ke liye tool nahi hai, toh agent
// khud tool BUILD kare, TEST kare, aur use kare." The model calls build_tool
// with plain JS; the forge:
//   1. guard-scans the code (skills-guard threat patterns + forge-specific
//      bans like child_process/process.env access),
//   2. runs the tool's SELF-TEST cases in a vm sandbox — a tool that fails
//      its own test is rejected with the failure output so the model iterates,
//   3. persists manifest + code under workspace/tools/<name>/ (survives
//      restarts) and registers it LIVE as a model-callable tool.
//
// Sandbox contract for tool authors (the model):
//   Define  async function run(input, api) { ... return result; }
//   api.fetch(url, opts)        — real network fetch; resolves to a PLAIN
//                                 object {ok, status, headers, body(=text),
//                                 json(), text(), bytes} — never a stream
//   api.readFile(relPath)       — read inside the PROJECT root only
//   api.writeFile(relPath, txt) — write inside workspace/ only
//   api.listFiles(relPath)      — list inside the project root
//   api.log(...)                — captured logs, returned with the result
//   Also in scope: JSON, Math, Date, URL, URLSearchParams, Buffer, Promise,
//   setTimeout/clearTimeout, AbortSignal, TextEncoder/TextDecoder, crypto.
//   NOT available (by design): require/import, process, child_process, raw fs.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { scanSkillText, determineVerdict, formatFindings } from "./skills-guard.js";

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
const DEFAULT_NETWORK_POLICY = Object.freeze({
  enabled: true,
  timeoutMs: 20_000,
  maxResponseBytes: 5 * 1024 * 1024,
  allowedHosts: [],
});

function normalizeNetworkPolicy(network = {}) {
  const raw = network && typeof network === "object" ? network : {};
  return {
    enabled: raw.enabled !== false,
    timeoutMs: Math.max(1_000, Math.min(Number(raw.timeoutMs || DEFAULT_NETWORK_POLICY.timeoutMs), 120_000)),
    maxResponseBytes: Math.max(1_024, Math.min(Number(raw.maxResponseBytes || DEFAULT_NETWORK_POLICY.maxResponseBytes), 25 * 1024 * 1024)),
    allowedHosts: Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean)
      : DEFAULT_NETWORK_POLICY.allowedHosts,
  };
}

function assertNetworkUrl(url, policy) {
  if (!policy.enabled) {
    throw new Error("Network access is disabled for self-built tools. Enable tools.toolForge.network.enabled in config.");
  }
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`Invalid network URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Only HTTP(S) network URLs are allowed in self-built tools: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (policy.allowedHosts.length && !policy.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new Error(`Network host is not allowed for self-built tools: ${host}`);
  }
  return parsed;
}

async function readResponseBytes(response, maxResponseBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new Error(`Network response exceeds the ${maxResponseBytes}-byte sandbox limit.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

// Forge-specific bans on top of skills-guard: the sandbox doesn't expose these
// anyway, but a tool that TRIES deserves a clear rejection, not a runtime error.
const FORGE_BANNED = [
  [/\brequire\s*\(/, "require() is not available in the tool sandbox — use api.fetch/api.readFile/api.writeFile"],
  [/\bimport\s*\(/, "dynamic import() is not available in the tool sandbox"],
  [/\bprocess\s*\./, "process.* is not available in the tool sandbox"],
  [/child_process|execSync|spawnSync/, "shell execution is not available in the tool sandbox — tools are pure JS + fetch + workspace files"],
  [/\bglobalThis\s*\.\s*(process|require)/, "sandbox escape attempt"],
];

function assertSafeToolCode(name, code) {
  const source = String(code || "");
  if (!source.trim()) throw new Error("Tool code is empty.");
  if (source.length > 64 * 1024) throw new Error("Tool code larger than 64KB — split the logic or trim it.");
  for (const [re, why] of FORGE_BANNED) {
    const match = source.match(re);
    if (match) throw new Error(`Tool code rejected: ${why} (found "${match[0]}").`);
  }
  const findings = scanSkillText(source, { file: `${name}/tool.mjs` });
  if (determineVerdict(findings) === "dangerous") {
    throw new Error(`Tool code blocked by skills guard: ${formatFindings(findings)}`);
  }
  if (!/function\s+run\s*\(|run\s*=\s*(async\s*)?\(/.test(source)) {
    throw new Error('Tool code must define `async function run(input, api) { ... }`.');
  }
}

function safeResolve(rootDir, scopeDir, relPath) {
  const cleaned = String(relPath || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(scopeDir, cleaned);
  const scope = path.resolve(scopeDir);
  if (abs !== scope && !abs.startsWith(scope + path.sep)) {
    throw new Error(`Path escapes the allowed scope: ${relPath}`);
  }
  // Defense-in-depth: even inside the project root, forged tools must not read
  // credential material (secrets are encrypted at rest, but don't hand out the
  // envelope either) or the device-trust store.
  const rel = path.relative(path.resolve(rootDir), abs).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(abs).toLowerCase();
  if (base === ".env" || base.startsWith(".env.") || rel === "data/secrets.json" || rel === "data/device-trust.json") {
    throw new Error(`Access to credential files is not allowed in the tool sandbox: ${relPath}`);
  }
  return abs;
}

export class ToolForge {
  constructor({ rootDir, network } = {}) {
    this.rootDir = rootDir || process.cwd();
    this.network = normalizeNetworkPolicy(network);
  }

  toolsDir() {
    return path.join(this.rootDir, "workspace", "tools");
  }

  toolDir(name) {
    return path.join(this.toolsDir(), name);
  }

  // ── Sandbox execution ────────────────────────────────────────────────────

  buildApi(logs) {
    const rootDir = this.rootDir;
    const workspaceDir = path.join(rootDir, "workspace");
    return {
      // Model-friendly fetch: returns a PLAIN object, not a WHATWG Response.
      // Field-tested failure: the model read `res.body` expecting a string,
      // got a ReadableStream, and silently fell back to mock data. Buffer the
      // body once and expose every idiom models actually write:
      //   res.ok / res.status / res.headers  — plain values
      //   res.body                            — body TEXT (string)
      //   await res.json() / await res.text() — also work
      fetch: async (url, options = {}) => {
        assertNetworkUrl(url, this.network);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error(`Network request timed out after ${this.network.timeoutMs}ms`)), this.network.timeoutMs);
        const externalSignal = options?.signal;
        const abortFromCaller = () => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted) abortFromCaller();
        else externalSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
        let response;
        try {
          response = await globalThis.fetch(url, { ...options, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted && !externalSignal?.aborted) {
            throw new Error(`Network request timed out after ${this.network.timeoutMs}ms: ${url}`);
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          externalSignal?.removeEventListener?.("abort", abortFromCaller);
        }
        const bytes = await readResponseBytes(response, this.network.maxResponseBytes);
        const bodyText = bytes.toString("utf8");
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          body: bodyText,
          bytes,
          text: async () => bodyText,
          json: async () => JSON.parse(bodyText),
        };
      },
      readFile: (relPath) => fs.readFileSync(safeResolve(rootDir, rootDir, relPath), "utf8"),
      writeFile: (relPath, content) => {
        const abs = safeResolve(rootDir, workspaceDir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content), "utf8");
        return path.relative(rootDir, abs).replace(/\\/g, "/");
      },
      listFiles: (relPath = ".") => fs.readdirSync(safeResolve(rootDir, rootDir, relPath)),
      log: (...args) => {
        logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
        if (logs.length > 200) logs.shift();
      },
    };
  }

  async execute(code, input = {}, { timeoutMs = 30000 } = {}) {
    const logs = [];
    const api = this.buildApi(logs);
    // Track every timer the tool creates so a forgotten setInterval (or a
    // pending setTimeout) can't keep running in the host process after the
    // tool returns or times out.
    const liveTimers = new Set();
    const trackedSetTimeout = (fn, ms, ...args) => {
      const id = setTimeout((...a) => { liveTimers.delete(id); fn(...a); }, ms, ...args);
      liveTimers.add(id);
      return id;
    };
    const trackedSetInterval = (fn, ms, ...args) => {
      const id = setInterval(fn, ms, ...args);
      liveTimers.add(id);
      return id;
    };
    const trackedClear = (id) => { liveTimers.delete(id); clearTimeout(id); clearInterval(id); };
    const context = vm.createContext({
      input,
      api,
      console: { log: api.log, error: api.log, warn: api.log },
      JSON, Math, Date, URL, URLSearchParams, Buffer, Promise,
      setTimeout: trackedSetTimeout, clearTimeout: trackedClear,
      setInterval: trackedSetInterval, clearInterval: trackedClear,
      AbortSignal, AbortController, TextEncoder, TextDecoder,
      fetch: api.fetch,
      crypto: { randomUUID: () => crypto.randomUUID(), createHash: (...a) => crypto.createHash(...a) },
    });
    const script = new vm.Script(
      `(async () => {\n${code}\n;\nif (typeof run !== "function") throw new Error("run(input, api) is not defined");\nreturn await run(input, api);\n})()`,
      { filename: "custom-tool.mjs" },
    );
    const resultPromise = script.runInContext(context, { timeout: 5000 });
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);
      return { result, logs };
    } finally {
      clearTimeout(timer);
      for (const id of liveTimers) { clearTimeout(id); clearInterval(id); }
      liveTimers.clear();
    }
  }

  // ── Build / test / persist lifecycle ─────────────────────────────────────

  /**
   * Build a tool: guard-scan → self-test → persist. Throws with the concrete
   * failure (test output included) so the model can fix and retry.
   */
  async buildTool({ name, description, schema, code, tests = [] } = {}) {
    const id = String(name || "").trim().toLowerCase();
    if (!NAME_RE.test(id)) {
      throw new Error(`Tool name must match ${NAME_RE} (got "${name}").`);
    }
    if (!String(description || "").trim()) {
      throw new Error("Tool description is required — the model picks tools by description.");
    }
    assertSafeToolCode(id, code);

    // Compile-check FIRST — a syntax error ("Unexpected token ')'") is a hard
    // fail no matter what, and the message points at the real problem instead
    // of masquerading as a self-test failure.
    try {
      // eslint-disable-next-line no-new
      new vm.Script(`(async () => {\n${code}\n})`, { filename: `${id}.mjs` });
    } catch (error) {
      throw new Error(`Tool code has a SYNTAX ERROR: ${error.message}. Fix the JS and call build_tool again.`);
    }

    // Self-test policy (the key reliability fix):
    //   - tests PROVIDED  -> every case must pass (ADA-style hard verification).
    //   - NO tests given  -> run once with empty input just to smoke it, but a
    //     THROW is NON-FATAL: many real tools legitimately require input
    //     (input.url, input.action, ...), and failing them on `{}` was the #1
    //     reason build_tool spun in a retry loop. The tool still registers; the
    //     result flags that it wasn't behavior-verified.
    const provided = Array.isArray(tests) && tests.length ? tests.slice(0, 5) : [];
    const testResults = [];
    const cases = provided.length ? provided : [{ input: {}, __smoke: true }];
    for (const [index, testCase] of cases.entries()) {
      const label = testCase.__smoke ? "smoke (empty input)" : `test ${index + 1}/${cases.length}`;
      try {
        const { result, logs } = await this.execute(code, testCase.input || {}, { timeoutMs: 30000 });
        const rendered = typeof result === "string" ? result : JSON.stringify(result);
        if (testCase.expect !== undefined) {
          const expected = typeof testCase.expect === "string" ? testCase.expect : JSON.stringify(testCase.expect);
          if (!String(rendered ?? "").includes(expected)) {
            throw new Error(`expected output to contain ${JSON.stringify(expected)} but got: ${String(rendered).slice(0, 400)}`);
          }
        }
        testResults.push({ label, ok: true, output: String(rendered ?? "").slice(0, 400), logs: logs.slice(-5) });
      } catch (error) {
        if (testCase.__smoke) {
          // Non-fatal: register anyway, but tell the model to add real tests.
          testResults.push({ label, ok: false, unverified: true, output: `threw on empty input: ${error.message}` });
          continue;
        }
        throw new Error(`Self-test failed (${label}): ${error.message}. Fix the code and call build_tool again.`);
      }
    }

    const dir = this.toolDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      name: id,
      description: String(description).trim().slice(0, 500),
      schema: schema && typeof schema === "object" ? schema : { type: "object", properties: {}, additionalProperties: true },
      createdAt: fs.existsSync(path.join(dir, "tool.json"))
        ? (JSON.parse(fs.readFileSync(path.join(dir, "tool.json"), "utf8")).createdAt || new Date().toISOString())
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tests: cases,
      builtBy: "agent",
    };
    fs.writeFileSync(path.join(dir, "tool.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "tool.mjs"), String(code), "utf8");
    return { name: id, manifest, testResults };
  }

  loadAll() {
    const dir = this.toolsDir();
    if (!fs.existsSync(dir)) return [];
    const loaded = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, entry.name, "tool.json"), "utf8"));
        const code = fs.readFileSync(path.join(dir, entry.name, "tool.mjs"), "utf8");
        if (!NAME_RE.test(manifest.name || "")) continue;
        // Re-scan at load: a tampered tool.mjs must not come back alive.
        assertSafeToolCode(manifest.name, code);
        loaded.push({ ...manifest, code });
      } catch { /* skip broken/unsafe tool dirs */ }
    }
    return loaded;
  }

  get(name) {
    const id = String(name || "").trim().toLowerCase();
    if (!NAME_RE.test(id)) throw new Error(`Invalid tool name: ${name}`);
    const dir = this.toolDir(id);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "tool.json"), "utf8"));
    const code = fs.readFileSync(path.join(dir, "tool.mjs"), "utf8");
    return { ...manifest, code };
  }

  remove(name) {
    const id = String(name || "").trim().toLowerCase();
    if (!NAME_RE.test(id)) throw new Error(`Invalid tool name: ${name}`);
    const dir = this.toolDir(id);
    if (!fs.existsSync(dir)) throw new Error(`Custom tool not found: ${id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: id };
  }
}

export default ToolForge;
