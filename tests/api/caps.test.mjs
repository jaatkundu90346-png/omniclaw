// B1 steps 8+9: capabilities map, fs/read tweaks, git root (R11: :3205).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { startTestServer, stopTestServer, apiJson, seedGitRepo, tmpDir } from "./_helpers.mjs";

const PORT = 3205;
const DATA = "./.tmp-test-data/caps";
let ctx = null;
let seed = "";

describe("capabilities and tweaks", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
    seed = seedGitRepo(path.join(tmpDir("oc-caps-"), "ws"));
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("GET /api/capabilities returns the documented shape", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/capabilities");
    assert.equal(status, 200);
    for (const key of ["fs", "git", "systemOpen", "terminal", "attachments", "toolCallId",
      "sessionsSearch", "memorySearch", "mcp", "harness", "version"]) {
      assert.ok(key in data, `missing capability: ${key}`);
    }
    assert.equal(data.fs, true);
    assert.equal(typeof data.git, "boolean");
    assert.equal(data.systemOpen.reveal, process.platform === "win32");
    assert.equal(data.terminal, false);
    assert.equal(data.attachments, false);
    assert.equal(data.toolCallId, true);
    assert.equal(typeof data.version, "string");
  });

  it("fs/read honors maxBytes and reports lines", async () => {
    const file = path.join(seed, "hello.txt");
    const full = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(file)}`);
    assert.equal(full.status, 200);
    assert.ok(full.data.lines >= 1);
    const part = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(file)}&maxBytes=3`);
    assert.equal(part.status, 200);
    assert.ok(Buffer.byteLength(part.data.content, "utf8") <= 3);
    const bad = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(file)}&maxBytes=99999999`);
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, "EINVAL");
  });

  it("git/status includes the repo root", async () => {
    await apiJson(ctx.base, "POST", "/api/workspace/select", { path: seed });
    const { status, data } = await apiJson(ctx.base, "GET", "/api/git/status");
    assert.equal(status, 200);
    assert.equal(data.isRepo, true);
    assert.ok(typeof data.root === "string" && data.root.length > 0);
    // Compare via git itself: temp dirs may be 8.3 short names either side.
    const { execFileSync } = await import("node:child_process");
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: seed, encoding: "utf8" }).trim().replace(/\//g, path.sep);
    assert.equal(data.root.toLowerCase(), top.toLowerCase());
  });
});
