// Skill lifecycle curator — Hermes agent/curator.py parity, right-sized.
//
// Problem it solves (same as Hermes issue #7816): every time the agent solves a
// novel problem and saves a skill via create_skill, that skill lives forever.
// Without maintenance you end up with dozens of narrow near-duplicates that
// pollute skill matching and waste prompt tokens.
//
// What it does, in Hermes's order:
//   1. Deterministic transitions (no LLM): agent-created skills unused for
//      staleAfterDays become "stale"; unused for archiveAfterDays are MOVED to
//      a sibling `.archive/` directory (recoverable — never deleted).
//   2. LLM consolidation (best-effort): when enough agent-created skills are
//      active, one bounded model pass proposes umbrella merges; the harness
//      applies at most maxMergesPerRun and archives the absorbed narrow skills.
//
// Hard rules ported from Hermes:
//   - NEVER touch bundled/vendor skills — only skills recorded here as
//     provenance "agent" (written by create_skill) are curated.
//   - NEVER delete — archiving is the maximum destructive action.
//   - NEVER touch skills whose frontmatter says `pinned: true`.
import fs from "node:fs";
import path from "node:path";

const DAY = 24 * 60 * 60 * 1000;

function normalizeSkillId(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function parseJsonBlock(text = "") {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

export class SkillCurator {
  constructor({ rootDir, skills, gateway = null, options = {} } = {}) {
    this.rootDir = rootDir;
    this.skills = skills; // SkillRegistry
    this.gateway = gateway;
    this.intervalDays = Number(options.intervalDays ?? 7);
    this.staleAfterDays = Number(options.staleAfterDays ?? 30);
    this.archiveAfterDays = Number(options.archiveAfterDays ?? 90);
    this.minSkillsForConsolidation = Number(options.minSkillsForConsolidation ?? 4);
    this.maxMergesPerRun = Number(options.maxMergesPerRun ?? 2);
  }

  statePath() {
    return path.join(this.rootDir, "data", "skill-curator-state.json");
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.statePath(), "utf8")); } catch { return {}; }
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
    fs.writeFileSync(this.statePath(), JSON.stringify(state, null, 2));
  }

  // Called by the create_skill tool path — this provenance mark is what makes a
  // skill curatable at all. Skills without it (bundled, hand-written, imported)
  // are permanently off-limits, mirroring Hermes's agent-created-only rule.
  recordCreated(name) {
    const id = normalizeSkillId(name);
    if (!id) return;
    const state = this.readState();
    const skills = state.skills || {};
    const now = new Date().toISOString();
    skills[id] = {
      ...(skills[id] || {}),
      provenance: "agent",
      createdAt: skills[id]?.createdAt || now,
      lastUsedAt: skills[id]?.lastUsedAt || now,
      useCount: skills[id]?.useCount || 0,
      status: "active",
    };
    this.writeState({ ...state, skills });
  }

  // Called when matched skills are injected into a run's context — the
  // OmniClaw equivalent of Hermes's use-counter. Tracks every skill (cheap
  // analytics) but only provenance:"agent" entries drive lifecycle decisions.
  recordUsed(names = []) {
    const ids = (Array.isArray(names) ? names : [names]).map(normalizeSkillId).filter(Boolean);
    if (ids.length === 0) return;
    const state = this.readState();
    const skills = state.skills || {};
    const now = new Date().toISOString();
    for (const id of ids.slice(0, 20)) {
      skills[id] = {
        ...(skills[id] || { provenance: "unknown", createdAt: now, useCount: 0 }),
        lastUsedAt: now,
        useCount: (skills[id]?.useCount || 0) + 1,
      };
      // A stale skill that gets used again has proven itself — rescue it.
      if (skills[id].status === "stale") skills[id].status = "active";
    }
    // Bounded: drop the oldest-by-lastUsedAt unknown-provenance entries first.
    const entries = Object.entries(skills);
    if (entries.length > 300) {
      const keep = entries
        .sort((a, b) => {
          // Consistent comparator: agent-provenance entries always outrank
          // unknowns (the old ternary returned -1 for two agent entries, which
          // is an inconsistent comparator and can drop agent entries at the cap).
          const aAgent = a[1].provenance === "agent" ? 1 : 0;
          const bAgent = b[1].provenance === "agent" ? 1 : 0;
          if (aAgent !== bAgent) return bAgent - aAgent;
          return String(b[1].lastUsedAt || "").localeCompare(String(a[1].lastUsedAt || ""));
        })
        .slice(0, 300);
      this.writeState({ ...state, skills: Object.fromEntries(keep) });
      return;
    }
    this.writeState({ ...state, skills });
  }

  // Agent-created, unpinned, still-on-disk skills — the only curatable set.
  curatableSkills(state) {
    const tracked = state.skills || {};
    const listed = this.skills?.getAll?.({ scope: "all" }) || [];
    return listed.filter((skill) => {
      const meta = tracked[normalizeSkillId(skill.id || skill.name)];
      if (!meta || meta.provenance !== "agent") return false;
      if (skill.pinned) return false;
      if (skill.source === "bundled") return false; // double safety
      return true;
    });
  }

  archiveSkillDir(skill, state, { reason, absorbedInto = "" } = {}) {
    const archiveDir = path.join(path.dirname(skill.path), ".archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    let target = path.join(archiveDir, path.basename(skill.path));
    if (fs.existsSync(target)) target = `${target}-${Date.now().toString(36)}`;
    fs.renameSync(skill.path, target);
    const id = normalizeSkillId(skill.id || skill.name);
    state.skills[id] = {
      ...(state.skills[id] || {}),
      status: absorbedInto ? "absorbed" : "archived",
      archivedAt: new Date().toISOString(),
      archivePath: target,
      ...(absorbedInto ? { absorbedInto } : {}),
      ...(reason ? { reason } : {}),
    };
    return target;
  }

  // Phase 1 — deterministic active → stale → archived transitions.
  runLifecycle(now = Date.now()) {
    const state = this.readState();
    state.skills = state.skills || {};
    const staled = [];
    const archived = [];
    for (const skill of this.curatableSkills(state)) {
      const id = normalizeSkillId(skill.id || skill.name);
      const meta = state.skills[id];
      const lastTouch = new Date(meta.lastUsedAt || meta.createdAt || skill.modifiedAt || 0).getTime();
      const idleDays = (now - lastTouch) / DAY;
      if (idleDays >= this.archiveAfterDays) {
        try {
          this.archiveSkillDir(skill, state, { reason: `unused ${Math.floor(idleDays)}d` });
          archived.push(skill.name);
        } catch { /* locked dir etc — retry next cycle */ }
      } else if (idleDays >= this.staleAfterDays && meta.status !== "stale") {
        meta.status = "stale";
        staled.push(skill.name);
      }
    }
    this.writeState(state);
    return { staled, archived };
  }

  // Phase 2 — one bounded LLM pass proposing umbrella consolidations
  // (Hermes's "would a maintainer write N skills or ONE skill with N labeled
  // subsections?" bar). Applies at most maxMergesPerRun.
  async runConsolidation(provider) {
    if (typeof provider?.complete !== "function") return { merges: [], reason: "no-provider" };
    const state = this.readState();
    state.skills = state.skills || {};
    const active = this.curatableSkills(state).filter((skill) => state.skills[normalizeSkillId(skill.id || skill.name)]?.status !== "absorbed");
    if (active.length < this.minSkillsForConsolidation) return { merges: [], reason: "too-few-skills" };

    const catalog = active.slice(0, 20).map((skill) => {
      let head = "";
      try { head = fs.readFileSync(skill.skillFile, "utf8").slice(0, 400).replace(/\s+/g, " "); } catch { /* listing is enough */ }
      return `- name: ${skill.name}\n  description: ${skill.description || ""}\n  triggers: ${(skill.triggers || []).join(", ")}\n  content-head: ${head}`;
    }).join("\n");

    const response = await provider.complete([
      { role: "system", content: "You are a skill-library maintainer. You consolidate narrow, overlapping agent-written skills into class-level umbrella skills. Judge overlap on CONTENT. The bar: would a human maintainer write these as N separate skills, or ONE skill with N labeled subsections? Reply with JSON only." },
      { role: "user", content: `Agent-created skills:\n${catalog}\n\nPropose consolidations as JSON: {"merges":[{"umbrella":"<new-or-existing-skill-name>","description":"<one line>","content":"<full merged SKILL.md body with a labeled subsection per absorbed skill>","triggers":["..."],"absorb":["<name>","<name>"]}]}. Rules: max ${this.maxMergesPerRun} merges; only merge skills that clearly serve one umbrella class; each absorb list needs >= 2 skills unless merging INTO an existing broader skill; if nothing should merge, reply {"merges":[]}.` },
    ], { maxTokens: 1200, timeoutMs: 45000 });

    const parsed = parseJsonBlock(response?.text || response?.content || "");
    const proposals = Array.isArray(parsed?.merges) ? parsed.merges.slice(0, this.maxMergesPerRun) : [];
    const applied = [];
    const activeByName = new Map(active.map((skill) => [normalizeSkillId(skill.name), skill]));

    for (const merge of proposals) {
      const umbrellaName = String(merge?.umbrella || "").trim();
      const absorb = (Array.isArray(merge?.absorb) ? merge.absorb : [])
        .map((name) => activeByName.get(normalizeSkillId(name)))
        .filter(Boolean)
        // The umbrella itself must never be archived by its own merge.
        .filter((skill) => normalizeSkillId(skill.name) !== normalizeSkillId(umbrellaName));
      if (!umbrellaName || !String(merge?.content || "").trim() || absorb.length === 0) continue;
      try {
        const umbrellaExists = activeByName.has(normalizeSkillId(umbrellaName));
        if (umbrellaExists) {
          this.skills.updateSkill(umbrellaName, {
            scope: "global",
            content: merge.content,
            description: merge.description || undefined,
            triggers: Array.isArray(merge.triggers) ? merge.triggers : undefined,
          });
        } else {
          this.skills.createSkill(umbrellaName, {
            scope: "global",
            description: merge.description || umbrellaName,
            content: merge.content,
            triggers: Array.isArray(merge.triggers) ? merge.triggers : [],
          });
          // Record provenance in the LOCAL state object — calling
          // recordCreated() here would be clobbered by the writeState below.
          const now = new Date().toISOString();
          state.skills[normalizeSkillId(umbrellaName)] = { provenance: "agent", createdAt: now, lastUsedAt: now, useCount: 0, status: "active" };
        }
        for (const skill of absorb) {
          this.archiveSkillDir(skill, state, { absorbedInto: umbrellaName });
        }
        applied.push({ umbrella: umbrellaName, absorbed: absorb.map((skill) => skill.name) });
      } catch { /* one bad merge must not kill the rest */ }
    }
    this.writeState(state);
    return { merges: applied };
  }

  // Entry point — weekly throttle, stamp-first (concurrent runs can't double-
  // curate), lifecycle always, consolidation only when a provider is available.
  async maybeRun({ provider = null, now = Date.now() } = {}) {
    const state = this.readState();
    if (now - new Date(state.lastRunAt || 0).getTime() < this.intervalDays * DAY) {
      return { acted: false, reason: "not-due" };
    }
    this.writeState({ ...state, lastRunAt: new Date(now).toISOString() });

    const lifecycle = this.runLifecycle(now);
    let consolidation = { merges: [] };
    try { consolidation = await this.runConsolidation(provider); } catch { /* best-effort */ }

    const summary = {
      staled: lifecycle.staled,
      archived: lifecycle.archived,
      merges: consolidation.merges,
    };
    if (lifecycle.staled.length || lifecycle.archived.length || consolidation.merges.length) {
      this.gateway?.addEvent?.("learning.skill_curated", {
        ...summary,
        message: `skill curator: ${lifecycle.staled.length} stale, ${lifecycle.archived.length} archived, ${consolidation.merges.length} merged`,
      });
    }
    return { acted: true, ...summary };
  }
}

export default SkillCurator;
