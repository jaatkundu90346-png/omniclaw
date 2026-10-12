// Smoke test for SkillRegistry frontmatter parsing + match precision.
// Run: node scripts/skill-registry-smoke.mjs
import SkillRegistry from "../src/core/skill-registry.js";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}`); }
}

const reg = new SkillRegistry({ rootDir: path.join(os.tmpdir(), `omni-skill-smoke-${Date.now()}`), agentName: "main" });

// ── Frontmatter parsing ─────────────────────────────────────────────
// Block-style YAML lists (the previously-broken case)
const block = reg.parseSkillMetadata(
  `---\nname: pdf-tools\ndescription: Work with PDF files\ntriggers:\n  - pdf\n  - extract text\ntags:\n  - documents\n  - office\n---\n# PDF Tools\n`,
  "fallback",
);
ok(block.name === "pdf-tools", "block: name parsed");
ok(block.description === "Work with PDF files", "block: description parsed");
ok(JSON.stringify(block.triggers) === JSON.stringify(["pdf", "extract text"]), `block: triggers parsed (got ${JSON.stringify(block.triggers)})`);
ok(JSON.stringify(block.tags) === JSON.stringify(["documents", "office"]), `block: tags parsed (got ${JSON.stringify(block.tags)})`);

// Inline-array still works (regression)
const inline = reg.parseSkillMetadata(
  `---\nname: x\ndescription: y\ntriggers: [a, b, c]\ntags: [t1, t2]\n---\n`,
  "fb",
);
ok(JSON.stringify(inline.triggers) === JSON.stringify(["a", "b", "c"]), "inline: triggers parsed");
ok(JSON.stringify(inline.tags) === JSON.stringify(["t1", "t2"]), "inline: tags parsed");

// Comma scalar + quoted description + CRLF
const mixed = reg.parseSkillMetadata(
  `---\r\nname: "Quoted Name"\r\ndescription: 'has spaces'\r\ntriggers: one, two\r\n---\r\n`,
  "fb",
);
ok(mixed.name === "Quoted Name", "quoted name unquoted");
ok(mixed.description === "has spaces", "quoted description unquoted");
ok(JSON.stringify(mixed.triggers) === JSON.stringify(["one", "two"]), `comma-scalar triggers (got ${JSON.stringify(mixed.triggers)})`);

// Heading fallback when no description
const noDesc = reg.parseSkillMetadata(`---\nname: z\n---\n# The Heading\n`, "fb");
ok(noDesc.description === "The Heading", "heading fallback description");

// ── match() precision ───────────────────────────────────────────────
reg.getAll = () => ([
  { id: "pdf", name: "pdf-tools", description: "Work with PDF files and extract text", tags: ["documents"], triggers: ["pdf"] },
  { id: "generic", name: "helper", description: "use this to make and get the file with your code and all that", tags: [], triggers: [] },
]);

// A PDF request should rank the pdf skill first (trigger boost), and the generic
// stopword-heavy skill should NOT out-score it on a PDF message.
const m1 = reg.match("can you extract text from this pdf file");
ok(m1.length > 0 && m1[0].id === "pdf", `pdf message -> pdf skill first (got ${m1.map((s) => s.id).join(",")})`);

// A message of pure filler must NOT match the stopword-heavy generic skill.
const m2 = reg.match("please make and get the file");
ok(!m2.some((s) => s.id === "generic" && s.score > 2), `filler doesn't strongly match generic skill (scores: ${JSON.stringify(m2.map((s) => [s.id, s.score]))})`);

// Block-parsed triggers actually drive matching now (the core bug fix payoff).
reg.getAll = () => ([{ id: "pdf", name: "pdf-tools", description: "docs", tags: [], triggers: block.triggers }]);
const m3 = reg.match("I need to extract text from a scan");
ok(m3.length === 1 && m3[0].score >= 5, `block triggers fire the boost (got ${m3[0] && m3[0].score})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
