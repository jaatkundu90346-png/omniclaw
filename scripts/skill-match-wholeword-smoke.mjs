// Smoke test: skill matching uses whole-word overlap, not substring (iteration 17).
// Bug: text.includes(token) let a description word ("art", "cat") score on
// unrelated message words ("start", "category") — the wrong skill got injected.
// Fix: score on message word-set membership. Triggers stay substring (curated).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { SkillRegistry } = await import(pathToFileURL(path.join(ROOT, "src/core/skill-registry.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-skill-"));
const reg = new SkillRegistry({ rootDir: tmp, agentName: "main" });

// Controlled skill set (bypass the filesystem scan).
const skills = [
  { id: "artwork", name: "artwork", description: "generate art and illustrations for creative projects", tags: ["art", "creative"], triggers: ["make art"] },
  { id: "catalog", name: "catalog", description: "build a product cat listing", tags: ["cat"], triggers: [] },
  { id: "deploy", name: "deploy", description: "deploy and release builds to production", tags: ["deploy", "release"], triggers: ["deploy the app"] },
  { id: "pdf", name: "pdf", description: "create edit merge PDF documents", tags: ["pdf"], triggers: ["pdf"] },
];
reg.getAll = () => skills.map((s) => ({ ...s }));

// ── 1. Substring false positives are gone ───────────────────────────────────
let m = reg.match("start the server now");
check("'start' does NOT match artwork skill (art⊄start as word)", !m.some((s) => s.id === "artwork"), JSON.stringify(m.map((s) => s.id)));
m = reg.match("show me the category page");
check("'category' does NOT match catalog skill (cat as word)", !m.some((s) => s.id === "catalog"), JSON.stringify(m.map((s) => s.id)));

// ── 2. Legit whole-word matches still work ──────────────────────────────────
m = reg.match("deploy and release the production build");
check("'deploy'/'release' match the deploy skill", m.length > 0 && m[0].id === "deploy", JSON.stringify(m.map((s) => ({ id: s.id, score: s.score }))));

m = reg.match("make art for my poster");
const art = m.find((s) => s.id === "artwork");
check("whole-word 'art' + trigger 'make art' matches artwork", Boolean(art) && art.score >= 6, JSON.stringify(art && art.score));

// ── 3. Triggers remain substring (curated, forgiving) ───────────────────────
m = reg.match("merge my pdfs into one");
check("pdf skill matches on 'merge'/'pdf documents' words", m.some((s) => s.id === "pdf"), JSON.stringify(m.map((s) => ({ id: s.id, score: s.score }))));

// ── 4. Empty / no-match paths ───────────────────────────────────────────────
check("empty message returns nothing", reg.match("   ").length === 0);
check("unrelated message returns nothing", reg.match("xyzzy plugh").length === 0, JSON.stringify(reg.match("xyzzy plugh").map((s) => s.id)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
