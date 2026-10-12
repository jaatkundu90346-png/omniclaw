// Shared harness for B1 API route tests (R11/R13): each file spins its OWN
// isolated instance (separate port + data dir) so node --test can run files
// in parallel without collisions. Empty data dir, no secrets, no model.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");

export async function startTestServer({ port, dataDir, env = {}, host = null, seedConfig = null }) {
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  // Seed the USER config before boot: provider wiring (mock baseUrl, key env
  // name) has to exist at startup or createProvider() picks the wrong backend
  // and the run dies before it is ever observable.
  if (seedConfig) {
    const dataSub = path.join(dataDir, "data");
    fs.mkdirSync(dataSub, { recursive: true });
    fs.writeFileSync(path.join(dataSub, "config.json"), JSON.stringify(seedConfig, null, 2));
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      OMNICLAW_DATA_DIR: dataDir,
      PORT: String(port),
      ...(host ? { OMNICLAW_HOST: host } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { child, base };
    } catch {}
    if (Date.now() > deadline) {
      try { child.kill("SIGTERM"); } catch {}
      throw new Error(`test server on :${port} did not come up`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function stopTestServer(child) {
  try { child.kill("SIGTERM"); } catch {}
}

export async function apiJson(base, method, p, body) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  return { status: r.status, data };
}

// Seed workspace: tiny git repo (one commit, one modified + one untracked file).
export function seedGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000, windowsHide: true });
  git(["init"]);
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
  fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
  git(["add", "."]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"]);
  fs.appendFileSync(path.join(dir, "hello.txt"), "more\n");
  fs.writeFileSync(path.join(dir, "fresh.txt"), "untracked\n");
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254]));
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(1200000));
  return dir;
}

export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function lanIp() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a && a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}
