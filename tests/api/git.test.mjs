// B1 step 4: /api/git/* routes against the isolated instance (:3200, R11).
// Seeds its own git repo; the live :3147 server is never touched.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { startTestServer, stopTestServer, apiJson, seedGitRepo, tmpDir } from "./_helpers.mjs";

const PORT = 3200;
const DATA = "./.tmp-test-data/git";
let ctx = null;
let seed = "";

describe("git routes", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
    seed = seedGitRepo(path.join(tmpDir("oc-git-"), "ws"));
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("status reports branch + modified + untracked files", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", `/api/git/status`);
    // Default path = test instance workspace (not a repo) → isRepo:false shape.
    assert.equal(status, 200);
    assert.equal(data.isRepo, false);
  });

  it("status on the seeded repo", async () => {
    // Select the seeded repo as the test instance workspace (test instance only).
    const sel = await apiJson(ctx.base, "POST", "/api/workspace/select", { path: seed });
    assert.equal(sel.status, 200);
    const { status, data } = await apiJson(ctx.base, "GET", "/api/git/status");
    assert.equal(status, 200);
    assert.equal(data.isRepo, true);
    assert.ok(typeof data.branch === "string" && data.branch.length > 0);
    const byName = Object.fromEntries(data.files.map((f) => [f.path, f]));
    assert.equal(byName["hello.txt"].status, "M");
    assert.equal(byName["hello.txt"].staged, false);
    assert.equal(byName["fresh.txt"].status, "?");
    assert.ok(data.summary.added >= 1);
  });

  it("diff shows the modified hunk", async () => {
    const { status, data } = await apiJson(
      ctx.base, "GET", `/api/git/diff?path=${encodeURIComponent("hello.txt")}`,
    );
    assert.equal(status, 200);
    assert.match(data.patch, /more/);
    assert.ok(data.added >= 1);
    assert.equal(data.binary, false);
  });

  it("diff returns untracked files whole as added lines", async () => {
    const { status, data } = await apiJson(
      ctx.base, "GET", `/api/git/diff?path=${encodeURIComponent("fresh.txt")}`,
    );
    assert.equal(status, 200);
    assert.match(data.patch, /untracked/);
    assert.ok(data.added >= 1);
  });

  it("diff on a non-repo path errors ENOTGIT", async () => {
    const other = tmpDir("oc-nogit-");
    const sel = await apiJson(ctx.base, "POST", "/api/workspace/select", { path: other });
    assert.equal(sel.status, 200);
    const { status, data } = await apiJson(ctx.base, "GET", "/api/git/diff?path=x.txt");
    assert.equal(status, 409);
    assert.equal(data.code, "ENOTGIT");
    await apiJson(ctx.base, "POST", "/api/workspace/select", { path: seed });
  });

  it("stage then unstage flips the staged flag", async () => {
    const st = await apiJson(ctx.base, "POST", "/api/git/stage", { path: "fresh.txt" });
    assert.equal(st.status, 200);
    let cur = await apiJson(ctx.base, "GET", "/api/git/status");
    assert.equal(cur.data.files.find((f) => f.path === "fresh.txt").staged, true);
    const un = await apiJson(ctx.base, "POST", "/api/git/unstage", { path: "fresh.txt" });
    assert.equal(un.status, 200);
    cur = await apiJson(ctx.base, "GET", "/api/git/status");
    assert.equal(cur.data.files.find((f) => f.path === "fresh.txt").staged, false);
  });

  it("revert requires confirm:true and restores content", async () => {
    const noConfirm = await apiJson(ctx.base, "POST", "/api/git/revert", { path: "hello.txt" });
    assert.equal(noConfirm.status, 400);
    const yes = await apiJson(ctx.base, "POST", "/api/git/revert", { path: "hello.txt", confirm: true });
    assert.equal(yes.status, 200);
    // Windows git autocrlf may restore CRLF — normalize before comparing.
    assert.equal(fs.readFileSync(path.join(seed, "hello.txt"), "utf8").replace(/\r\n/g, "\n"), "hello\n");
    const cur = await apiJson(ctx.base, "GET", "/api/git/status");
    assert.ok(!cur.data.files.some((f) => f.path === "hello.txt"));
  });

  it("revert rejects paths outside the workspace", async () => {
    const evil = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hostname";
    const { status, data } = await apiJson(ctx.base, "POST", "/api/git/revert", { path: evil, confirm: true });
    assert.ok([400, 403].includes(status));
    assert.ok(["EINVAL", "EPERM"].includes(data.code));
  });
});
