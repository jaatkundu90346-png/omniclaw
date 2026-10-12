// Smoke test for the skill lifecycle curator (Hermes curator.py parity):
// provenance guard, pinning, stale -> archive transitions, use-rescue,
// LLM umbrella consolidation, weekly throttle.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };

const DAY = 24 * 60 * 60 * 1000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-skillcur-"));
// SkillRegistry writes global skills under $HOME/.mavis — keep it sandboxed.
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { SkillRegistry } = await import("../src/core/skill-registry.js");
const { SkillCurator } = await import("../src/core/skill-curator.js");

const registry = new SkillRegistry({ rootDir: tmp });
const events = [];
const curator = new SkillCurator({
  rootDir: tmp,
  skills: registry,
  gateway: { addEvent: (type, payload) => events.push({ type, payload }) },
});

const agentSkills = [
  ["deploy-vercel-next", "Deploy a Next.js app to Vercel", ["vercel next"]],
  ["deploy-vercel-vite", "Deploy a Vite app to Vercel", ["vercel vite"]],
  ["deploy-netlify", "Deploy a static site to Netlify", ["netlify"]],
  ["git-bisect-debug", "Find a regression commit with git bisect", ["bisect"]],
  ["deploy-cloudflare", "Deploy a worker to Cloudflare", ["cloudflare"]],
];
for (const [name, description, triggers] of agentSkills) {
  registry.createSkill(name, { description, triggers, content: `## Steps for ${name}\n\n1. do the thing` });
  curator.recordCreated(name);
}
// Agent-created but PINNED — must be untouchable.
registry.createSkill("pinned-important", { description: "Critical pinned workflow", content: "never archive me" });
curator.recordCreated("pinned-important");
const pinnedFile = path.join(tmp, ".mavis", "skills", "pinned-important", "SKILL.md");
fs.writeFileSync(pinnedFile, fs.readFileSync(pinnedFile, "utf8").replace("---\n\n#", "pinned: true\n---\n\n#"), "utf8");
// User-authored (no provenance record) — must be invisible to the curator.
registry.createSkill("user-authored", { description: "Hand-written skill", content: "hands off" });

// ── 1. provenance + pinning guards ──────────────────────────────────────────
{
  const curatable = curator.curatableSkills(curator.readState());
  const names = curatable.map((skill) => skill.name).sort();
  assert.deepEqual(names, agentSkills.map(([n]) => n).sort(), "exactly the unpinned agent-created skills are curatable");
  assert.ok(!names.includes("user-authored"), "user-authored skill invisible to curator");
  assert.ok(!names.includes("pinned-important"), "pinned skill invisible to curator");
  ok("provenance + pinning guards keep non-agent and pinned skills off-limits");
}

// ── 2. stale transition + use-rescue ────────────────────────────────────────
{
  const state = curator.readState();
  state.skills["git-bisect-debug"].lastUsedAt = new Date(Date.now() - 40 * DAY).toISOString();
  state.skills["pinned-important"].lastUsedAt = new Date(Date.now() - 200 * DAY).toISOString();
  curator.writeState(state);
  const result = curator.runLifecycle();
  assert.deepEqual(result.staled, ["git-bisect-debug"], "40d-unused agent skill goes stale");
  assert.deepEqual(result.archived, [], "nothing archived yet");
  assert.equal(curator.readState().skills["pinned-important"].status, "active", "pinned skill never staled");
  assert.ok(fs.existsSync(path.join(tmp, ".mavis", "skills", "git-bisect-debug", "SKILL.md")), "stale skill stays on disk");

  curator.recordUsed(["git-bisect-debug"]);
  const after = curator.readState().skills["git-bisect-debug"];
  assert.equal(after.status, "active", "used-again stale skill rescued to active");
  assert.equal(after.useCount, 1, "use counter bumped");
  ok("stale transition fires at 30d and usage rescues the skill");
}

// ── 3. archive transition (move, never delete) ──────────────────────────────
{
  const state = curator.readState();
  state.skills["deploy-netlify"].lastUsedAt = new Date(Date.now() - 100 * DAY).toISOString();
  curator.writeState(state);
  const result = curator.runLifecycle();
  assert.deepEqual(result.archived, ["deploy-netlify"], "100d-unused skill archived");
  const listed = registry.getAll({ scope: "all" }).map((skill) => skill.name);
  assert.ok(!listed.includes("deploy-netlify"), "archived skill gone from the catalog");
  const archiveDir = path.join(tmp, ".mavis", "skills", ".archive", "deploy-netlify");
  assert.ok(fs.existsSync(path.join(archiveDir, "SKILL.md")), "archived skill dir moved (recoverable), not deleted");
  ok("archive transition moves the dir to .archive and out of the catalog");
}

// ── 4. umbrella consolidation via maybeRun (LLM pass + event) ───────────────
{
  const provider = {
    complete: async () => ({
      text: JSON.stringify({
        merges: [{
          umbrella: "deploy-vercel",
          description: "Deploy any frontend app to Vercel",
          content: "## Next.js\n\nsteps A\n\n## Vite\n\nsteps B",
          triggers: ["vercel"],
          absorb: ["deploy-vercel-next", "deploy-vercel-vite"],
        }],
      }),
    }),
  };
  const result = await curator.maybeRun({ provider });
  assert.equal(result.acted, true, "first maybeRun acts");
  assert.equal(result.merges.length, 1, "one merge applied");
  assert.deepEqual(result.merges[0].absorbed.sort(), ["deploy-vercel-next", "deploy-vercel-vite"], "both narrow skills absorbed");
  const listed = registry.getAll({ scope: "all" }).map((skill) => skill.name);
  assert.ok(listed.includes("deploy-vercel"), "umbrella skill exists in the catalog");
  assert.ok(!listed.includes("deploy-vercel-next") && !listed.includes("deploy-vercel-vite"), "absorbed skills out of the catalog");
  const umbrella = registry.getSkill("deploy-vercel", "global");
  assert.ok(umbrella.content.includes("## Next.js") && umbrella.content.includes("## Vite"), "umbrella carries a labeled subsection per absorbed skill");
  const state = curator.readState();
  assert.equal(state.skills["deploy-vercel-next"].status, "absorbed", "absorbed status recorded");
  assert.equal(state.skills["deploy-vercel-next"].absorbedInto, "deploy-vercel", "forwarding target recorded");
  assert.equal(state.skills["deploy-vercel"].provenance, "agent", "umbrella is itself curatable next cycle");
  assert.ok(events.some((e) => e.type === "learning.skill_curated"), "gateway event emitted");
  ok("consolidation merges narrow skills into an umbrella and archives them");
}

// ── 5. weekly throttle ──────────────────────────────────────────────────────
{
  const again = await curator.maybeRun({ provider: { complete: async () => ({ text: '{"merges":[]}' }) } });
  assert.equal(again.acted, false, "second run within the interval is throttled");
  assert.equal(again.reason, "not-due", "throttle reason reported");
  ok("weekly throttle blocks a second run");
}

// ── 6. post-run skill review (Hermes background-review parity) ──────────────
{
  const { OmniLoop } = await import("../src/core/omni-loop.js");
  const loop = Object.create(OmniLoop.prototype);
  let providerReply = "";
  loop.runtime = {
    rootDir: tmp,
    skills: registry,
    provider: { complete: async () => ({ text: providerReply }) },
    config: { getConfig: () => ({ runtime: { skillReview: { minGapHours: 0 } } }) },
    gateway: { addEvent: (type, payload) => events.push({ type, payload }) },
  };
  const toolOutputs = [
    { tool: "write_file", input: { path: "site/index.html" }, output: { path: "site/index.html" } },
    { tool: "exec", input: { command: "npx vercel deploy" }, output: {} },
  ];
  const baseReport = () => ({ finalReady: true, stoppedReason: "model-final-ready", toolCallCount: 10, codeEdited: true });

  // Below the iteration interval: no review, but iterations accumulate.
  const first = await loop.maybeRunSkillReview("deploy the site", baseReport(), toolOutputs);
  assert.equal(first.acted, false, "below interval: no review");
  assert.equal(first.reason, "not-due", "reports not-due");
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "data", "skill-review-state.json"), "utf8")).itersSinceReview, 10, "iterations accumulated");

  // Crossing the interval triggers a review that authors a new skill.
  providerReply = JSON.stringify({
    action: "create",
    name: "deploy-static-vercel",
    description: "Deploy a static site to Vercel via CLI",
    triggers: ["vercel deploy"],
    content: "## When to use\n\nStatic site needs deploying to Vercel.\n\n## Steps\n\n1. npx vercel deploy\n2. verify the URL loads",
    reason: "reusable deploy workflow",
  });
  const report = { ...baseReport(), toolCallCount: 25 };
  const second = await loop.maybeRunSkillReview("deploy the site", report, toolOutputs);
  assert.equal(second.action, "created", "review created the skill");
  assert.equal(report.skillReviewAction, "created", "report records the action");
  const listed = registry.getAll({ scope: "all" }).map((skill) => skill.name);
  assert.ok(listed.includes("deploy-static-vercel"), "authored skill is in the catalog");
  assert.equal(curator.readState().skills["deploy-static-vercel"].provenance, "agent", "authored skill is provenance-marked for the curator");
  assert.ok(events.some((e) => e.type === "learning.skill_review" && e.payload.action === "created"), "review event emitted");
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "data", "skill-review-state.json"), "utf8")).itersSinceReview, 0, "counter reset after review");

  // Never patches a skill the agent doesn't own (user-authored/bundled).
  providerReply = JSON.stringify({ action: "update", name: "user-authored", description: "hijacked description", triggers: [], content: "## hijack attempt\n\nthis content is long enough to pass the quality gate but it must never be written onto a skill the agent does not own, because bundled and user-authored skills are off-limits" });
  const hijack = await loop.maybeRunSkillReview("another task", { ...baseReport(), toolCallCount: 40 }, toolOutputs);
  assert.equal(hijack.action, "skipped-not-owned", "update to non-agent skill refused");
  assert.ok(!registry.getSkill("user-authored", "global").content.includes("hijack"), "user-authored skill untouched");

  // Most sessions produce no skill.
  providerReply = JSON.stringify({ action: "none" });
  const none = await loop.maybeRunSkillReview("small task", { ...baseReport(), toolCallCount: 40 }, toolOutputs);
  assert.equal(none.action, "none", "none is accepted quietly");
  ok("post-run skill review authors provenance-marked skills, refuses hijacks, throttles");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nskill-curator-smoke: ${passed} checks passed, 0 failed`);
