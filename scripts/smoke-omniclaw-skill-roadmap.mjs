// Smoke test for the omniclaw-roadmap skill package.
// Verifies the skill package is wired correctly (files exist + key content present).
// Exits 1 on any failure, 0 when all checks pass.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail });
  if (!cond) console.error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  else console.log(`PASS: ${name}`);
}

// 1. SKILL.md exists with triggers + entry procedure
const skillPath = resolve(ROOT, 'workspace/agents/main/skills/omniclaw-roadmap/SKILL.md');
check('SKILL.md exists', existsSync(skillPath));
if (existsSync(skillPath)) {
  const s = readFileSync(skillPath, 'utf8');
  check('SKILL.md has triggers', /triggers:/.test(s), 'missing triggers block');
  check('SKILL.md has Procedure', /## Procedure/.test(s), 'missing Procedure section');
  check('SKILL.md points to roadmap', s.includes('OMNICLAW_SKILL_ROADMAP.md'));
}

// 2. day01-baseline.md exists
const day1 = resolve(ROOT, 'workspace/agents/main/skills/omniclaw-roadmap/day01-baseline.md');
check('day01-baseline.md exists', existsSync(day1));

// 3. tracker.json valid + has currentDay
const trackerPath = resolve(ROOT, 'workspace/agents/main/skills/omniclaw-roadmap/tracker.json');
check('tracker.json exists', existsSync(trackerPath));
if (existsSync(trackerPath)) {
  try {
    const t = JSON.parse(readFileSync(trackerPath, 'utf8'));
    check('tracker.json has currentDay', typeof t.currentDay === 'number', 'currentDay missing/not number');
    check('tracker.json has phaseNames', t.phaseNames && Object.keys(t.phaseNames).length >= 5);
  } catch (e) {
    check('tracker.json parses', false, e.message);
  }
}

// 4. Full roadmap exists
const roadmap = resolve(ROOT, 'workspace/agents/main/OMNICLAW_SKILL_ROADMAP.md');
check('OMNICLAW_SKILL_ROADMAP.md exists', existsSync(roadmap));
if (existsSync(roadmap)) {
  const r = readFileSync(roadmap, 'utf8');
  check('roadmap has Phase 0-4', /Phase 0/.test(r) && /Phase 4/.test(r));
  check('roadmap has 30-day fast track', /30-Day Fast Track/.test(r));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
