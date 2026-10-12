// B1 step 3: /api/fs/* routes against the isolated instance (:3199, R11).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { startTestServer, stopTestServer, apiJson, seedGitRepo, tmpDir } from "./_helpers.mjs";

const PORT = 3199;
const DATA = "./.tmp-test-data/fs";
let ctx = null;
let seed = "";

describe("fs routes", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
    seed = seedGitRepo(path.join(tmpDir("oc-fs-"), "ws"));
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("tree lists the workspace", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/tree?path=${encodeURIComponent(seed)}&depth=2`);
    assert.equal(status, 200);
    const names = data.entries.map((e) => e.name);
    assert.ok(names.includes("hello.txt"));
    assert.ok(names.includes("fresh.txt"));
    assert.ok(data.entries.every((e) => typeof e.mtime === "number"));
  });

  it("tree denies traversal outside allowed roots", async () => {
    const blocked = process.platform === "win32"
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/shadow";
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/tree?path=${encodeURIComponent(blocked)}`);
    assert.equal(status, 403);
    assert.equal(data.code, "EPERM");
  });

  it("read returns text + mtime", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(path.join(seed, "hello.txt"))}`);
    assert.equal(status, 200);
    assert.match(data.content, /hello/);
    assert.equal(data.encoding, "utf8");
    assert.ok(typeof data.mtime === "number");
  });

  it("read flags binary files", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(path.join(seed, "blob.bin"))}`);
    assert.equal(status, 200);
    assert.equal(data.binary, true);
  });

  it("read enforces the 1MB cap", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(path.join(seed, "big.txt"))}`);
    assert.equal(status, 413);
    assert.equal(data.code, "ETOOBIG");
  });

  it("read requires path and 404s missing files", async () => {
    const missing = await apiJson(ctx.base, "GET", "/api/fs/read");
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, "EINVAL");
    const gone = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(path.join(seed, "nope.txt"))}`);
    assert.equal(gone.status, 404);
    assert.equal(gone.data.code, "ENOENT");
  });

  it("search finds files by name", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/fs/search?q=hello&limit=50`);
    // No path given: searches the test instance workspace (empty) — shape only.
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.entries));
    const hit = await apiJson(ctx.base, "GET", `/api/fs/search?q=hello&path=${encodeURIComponent(seed)}`);
    assert.equal(hit.status, 200);
    assert.ok(hit.data.entries.some((e) => e.name === "hello.txt"));
  });

  it("write saves, read-back matches, mtime lock works", async () => {
    const target = path.join(seed, "edited.md");
    const w1 = await apiJson(ctx.base, "POST", "/api/fs/write", { path: target, content: "# v1\n" });
    assert.equal(w1.status, 200);
    assert.ok(w1.data.ok);
    const r1 = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(target)}`);
    assert.equal(r1.data.content, "# v1\n");
    const stale = await apiJson(ctx.base, "POST", "/api/fs/write", {
      path: target, content: "# v2\n", expectedMtime: r1.data.mtime + 9999,
    });
    assert.equal(stale.status, 409);
    const w2 = await apiJson(ctx.base, "POST", "/api/fs/write", {
      path: target, content: "# v2\n", expectedMtime: r1.data.mtime,
    });
    assert.equal(w2.status, 200);
    const r2 = await apiJson(ctx.base, "GET", `/api/fs/read?path=${encodeURIComponent(target)}`);
    assert.equal(r2.data.content, "# v2\n");
    fs.rmSync(target, { force: true });
  });

  it("write rejects oversize content", async () => {
    // Bodies past security.maxRequestBytes (1MB) die in parseBody
    // (server.js:629-633 socket destroy) before the route's own 2MB cap —
    // either outcome proves the size guard fires.
    let rejected = false;
    try {
      const { status, data } = await apiJson(ctx.base, "POST", "/api/fs/write", {
        path: path.join(seed, "huge.md"), content: "y".repeat(3 * 1024 * 1024),
      });
      rejected = status === 413 && data && data.code === "ETOOBIG";
    } catch {
      rejected = true; // ECONNRESET from the parseBody size guard.
    }
    assert.ok(rejected, "oversize write must be rejected");
    assert.ok(!fs.existsSync(path.join(seed, "huge.md")));
  });
});
