// Live demo: run OmniClaw's real write_file + multi_edit against a temp workspace.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

let step = "init";
const wall = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 25000);
wall.unref?.();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-tool-demo-"));
for (const dir of ["config", "workspace"]) {
  const src = path.join(repoRoot, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(rootDir, dir), { recursive: true, force: true });
}

const agent = new OmniClawAgent({ rootDir });
const ctx = { agentId: "main", sessionId: "tool-demo", runId: "tool-demo" };
const run = (tool, input) => agent.tools.run(tool, input, ctx);

function show(label, value) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify(value, null, 2));
}

try {
  step = "write_file (new file)";
  const rel = "data/generated/tool-demo/hello.txt";
  const w1 = await run("write_file", { path: rel, content: "Hello from OmniClaw write_file!\nLine 2.\n" });
  show("write_file NEW", w1);
  const abs = path.join(rootDir, rel);
  console.log("on disk:", JSON.stringify(fs.readFileSync(abs, "utf8")));

  step = "write_file (overwrite existing)";
  const w2 = await run("write_file", { path: rel, content: "Overwritten content v2.\n" });
  show("write_file OVERWRITE", w2);
  console.log("on disk:", JSON.stringify(fs.readFileSync(abs, "utf8")));

  step = "multi_edit (several finds in one file)";
  const rel2 = "data/generated/tool-demo/config.json";
  await run("write_file", { path: rel2, content: JSON.stringify({ name: "omniclaw", env: "dev", debug: false }, null, 2) });
  const me = await run("multi_edit", {
    path: rel2,
    edits: [
      { find: '"env": "dev"', replace: '"env": "prod"' },
      { find: '"debug": false', replace: '"debug": true' },
      { find: '"name": "omniclaw"', replace: '"name": "omniclaw-demo"' },
    ],
  });
  show("multi_edit", me);
  console.log("on disk:", fs.readFileSync(path.join(rootDir, rel2), "utf8"));

  step = "multi_edit (missing find — should fail cleanly)";
  const meBad = await run("multi_edit", { path: rel2, edits: [{ find: "THIS_TEXT_DOES_NOT_EXIST", replace: "x" }] });
  show("multi_edit BAD FIND", meBad);

  step = "write_file empty args (guard)";
  const wEmpty = await run("write_file", {});
  show("write_file EMPTY {}", wEmpty);

  const ok1 = w1.path === rel && !w1.error;
  const ok2 = w2.path === rel && !w2.error;
  const ok3 = me.edited === true && !me.error;
  const ok4 = meBad.error === true;
  const ok5 = Boolean(wEmpty.error || wEmpty.blocked || wEmpty.message);
  console.log(`\nRESULTS write_new=${ok1} write_overwrite=${ok2} multi_edit=${ok3} multi_edit_bad_find_blocked=${ok4} empty_args_blocked=${ok5}`);
  if (!(ok1 && ok2 && ok3 && ok4 && ok5)) process.exitCode = 1;
} catch (err) {
  console.error("DEMO ERROR:", err);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
  clearTimeout(wall);
  process.exit(process.exitCode || 0);
}
