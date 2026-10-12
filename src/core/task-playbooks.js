/**
 * TaskPlaybooks — OmniClaw's "gets stronger with use" system (Hermes-inspired).
 *
 * Hermes grows via agent-created skills + a background curator. OmniClaw's
 * version is automatic: every completed run is classified into a TASK TYPE
 * (website-build, react-app, research, debugging, ...) and that type's
 * PLAYBOOK — a compact "how WE do this task well" note distilled from the
 * agent's own past runs — is refined. The next time a task of the same type
 * arrives, the playbook is injected into the system prompt, so the agent
 * starts with everything it already learned: approach, pitfalls, and the
 * verification that worked. Repetition makes it stronger, failures teach it
 * pitfalls, and a daily curator keeps the collection lean (decay + prune,
 * never grows unbounded).
 *
 * All classification/injection is deterministic (no LLM call on the hot
 * path); only the post-run refinement uses the cheap compaction model,
 * fire-and-forget.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { redactSecrets } from "./secret-redact.js";

// Ordered, deterministic task-type rules (first match wins). Hinglish + English
// triggers, because that's how this user actually talks to the agent.
const TYPE_RULES = [
  { type: "react-app", re: /\breact\b|\bjsx\b|\bvite\b|\bnext\.?js\b|\bcomponent\b|\btailwind\b/i },
  { type: "website-build", re: /\bwebsite\b|\bweb ?site\b|\blanding\b|\bportfolio\b|\bhomepage\b|\bhtml\b|\bcss\b|site bana|page bana|\bwebpage\b/i },
  // Hinglish typos included on purpose (vedio, iamge, gernate/genrate) — that's
  // how the user actually types these asks.
  { type: "media", re: /\b(image|iamge|photo|picture|logo|poster|thumbnail|wallpaper|banner)\b[^.?!]{0,40}\b(bana|banao|generate|gernate|genrate|create|draw)|\b(video|vedio|reel|clip)\b[^.?!]{0,40}\b(bana|banao|generate|gernate|genrate|create)|\b(generate|gernate|genrate|create|make)\b[^.?!]{0,30}\b(image|iamge|video|vedio|logo|poster)\b|(image|iamge|photo|pic|screenshot) ?(ko|ye|yeh)? ?(dekh|dakh|check kar|analyze)/i },
  // Channel/messaging setup. Requires a platform word AND an intent word, so
  // "telegram bot ka bug fix karo" still classifies as debugging. Hinglish
  // typos ("conect") are deliberate — that is how the user types it.
  // "bot" is deliberately NOT an intent word — "telegram bot" is just a noun,
  // and treating it as intent stole "telegram bot ka bug fix karo" from
  // debugging.
  { type: "messaging", re: /\b(telegram|whatsapp|discord|slack|signal|matrix)\b[^.?!]{0,40}\b(conn?ect|link|setup|set up|configure|token|send|message|msg|bhej|jod|chalu)\b|\b(conn?ect|link|setup|configure)\b[^.?!]{0,30}\b(telegram|whatsapp|discord|slack|signal|matrix)\b/i },
  { type: "debugging", re: /\bfix\b|\bbug\b|\berror\b|not working|nahi chal|nhi chal|\bcrash\b|theek kar|thik kar|\bbroken\b|\bdebug\b|fail ho/i },
  { type: "research", re: /\bresearch\b|search kar|find out|pata kar|\blatest\b|\bcompare\b|\binvestigate\b|khoj|\bsummari[sz]e\b|analysis kar/i },
  { type: "data-scripting", re: /\bscript\b|\bautomate\b|\bcsv\b|\bexcel\b|\bscrape\b|\bparse\b|\bdataset\b|data nikaal/i },
  { type: "file-ops", re: /\b(folder|file|files)\b.*\b(move|rename|organi[sz]e|delete|clean|sort)\b|organize kar|saaf kar/i },
  { type: "deployment", re: /\bdeploy\b|\bbuild\b.*\bexe\b|\bpublish\b|\brelease\b|\bpackage\b/i },
  { type: "writing", re: /\bwrite\b.*\b(article|blog|essay|report|README|docs?)\b|likh(?:o|na|\b)/i },
];

// Fallback classification from what the run actually DID (tool signals).
function classifyFromSignals(report = {}) {
  if (report.htmlEdited) return "website-build";
  if (report.codeEdited) return "coding";
  return "";
}

export function classifyTask(message = "", report = null) {
  const text = String(message || "");
  for (const rule of TYPE_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return report ? classifyFromSignals(report) : "";
}

export class TaskPlaybooks {
  constructor({ rootDir }) {
    this.filePath = path.join(rootDir || ".", "data", "playbooks.json");
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (error) {
      // Was `catch { return [] }` — a missing file is normal on first run, but a
      // CORRUPT playbooks.json was indistinguishable from "no playbooks", so the
      // agent silently lost every learned playbook.
      if (error?.code !== "ENOENT") {
        console.warn("[memory] task-playbooks load: playbooks.json unreadable:", error.message);
      }
      return [];
    }
  }

  save(list) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Atomic (temp + rename): a truncated playbooks.json was unrecoverable.
      atomicWriteFileSync(this.filePath, JSON.stringify(list, null, 2));
    } catch (error) {
      console.warn("[memory] task-playbooks save:", error.message);
    }
  }

  get(type) {
    if (!type) return null;
    return this.load().find((p) => p.type === type) || null;
  }

  // Prompt section for a matched task type — injected BEFORE the run starts.
  buildSection(type) {
    const entry = this.get(type);
    if (!entry || !String(entry.playbook || "").trim()) return "";
    const record = `used ${entry.uses || 0}x, ${entry.successes || 0} succeeded${entry.failures ? `, ${entry.failures} failed` : ""}`;
    return [
      `## Learned Playbook: ${entry.type} (from YOUR past runs — ${record})`,
      "",
      "How this agent has successfully done this kind of task before. Follow it unless the user asks otherwise; it encodes hard-won lessons (including past failures).",
      String(entry.playbook).slice(0, 1800),
    ].join("\n");
  }

  // Record that a playbook was injected for a run and how that run ended —
  // this is the reinforcement signal that makes often-used playbooks rank up.
  recordOutcome(type, { success = false } = {}) {
    if (!type) return;
    const list = this.load();
    const entry = list.find((p) => p.type === type);
    if (!entry) return;
    entry.uses = (entry.uses || 0) + 1;
    if (success) entry.successes = (entry.successes || 0) + 1;
    else entry.failures = (entry.failures || 0) + 1;
    entry.lastUsedAt = new Date().toISOString();
    this.save(list);
  }

  // Post-run refinement (fire-and-forget from the loop): merge this run's
  // lessons into the type's playbook using the cheap compaction model.
  async learnFromRun({ type, message, outcome, workSummary, provider, model = "", timeoutMs = 25000 }) {
    if (!type || !provider?.complete) return { learned: false, reason: "no-type-or-provider" };
    const existing = this.get(type);
    const prior = existing?.playbook || "";
    const completion = await provider.complete([
      {
        role: "system",
        content: "You maintain a compact PLAYBOOK for an AI agent for ONE recurring task type — 'how we do this task well', distilled from the agent's own runs. Merge the lessons of the LATEST run into the existing playbook. Rules: max 10 bullet lines; imperative and GENERALIZABLE (never this run's specific filenames/paths); cover (1) recommended approach/steps, (2) pitfalls to avoid — especially from failures, (3) exactly how to verify the result. Keep proven old lines unless contradicted. Output ONLY the playbook bullet lines, no heading, no preamble.",
      },
      {
        role: "user",
        content: `Task type: ${type}\nLatest run outcome: ${outcome}\nUser ask (for context): ${String(message || "").slice(0, 400)}\nWhat the run actually did:\n${String(workSummary || "(no tool work recorded)").slice(0, 2500)}\n\nExisting playbook (may be empty):\n${prior.slice(0, 1800)}\n\nUpdated playbook:`,
      },
    ], { maxTokens: 500, timeoutMs, ...(model ? { model } : {}) });
    const text = String(completion?.text || "").trim();
    if (!text || text.length < 20) return { learned: false, reason: "empty-refinement" };
    // Same as instincts: the run's work summary can contain a credential, and
    // the playbook is persisted to a plain-text JSON file and injected into
    // future prompts — redact before it is ever written.
    const safeText = redactSecrets(text);
    // Quality gate: a playbook is bullet lines. A model that answered with
    // prose/garbage (e.g. a status sentence) must not overwrite learned
    // knowledge — this exact failure once filled the store with stub text.
    if (!/^\s*[-•*]/m.test(text)) return { learned: false, reason: "not-bullet-format" };

    const list = this.load();
    const entry = list.find((p) => p.type === type);
    if (entry) {
      entry.playbook = safeText.slice(0, 2400);
      entry.updatedAt = new Date().toISOString();
      entry.runsLearnedFrom = (entry.runsLearnedFrom || 0) + 1;
    } else {
      list.push({
        type,
        playbook: safeText.slice(0, 2400),
        uses: 0,
        successes: 0,
        failures: 0,
        runsLearnedFrom: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    this.save(list);
    return { learned: true, isNew: !entry };
  }

  // Curator pass: keep the collection lean and current. Deterministic — no
  // LLM. Archives (removes) playbooks never used in 60 days, caps the list at
  // 24 types ranked by usefulness (uses, then recency).
  curate({ now = Date.now() } = {}) {
    const list = this.load();
    const before = list.length;
    const DAY = 24 * 60 * 60 * 1000;
    const kept = list.filter((p) => {
      const lastTouch = new Date(p.lastUsedAt || p.updatedAt || p.createdAt || 0).getTime();
      const stale = now - lastTouch > 60 * DAY;
      return !(stale && (p.uses || 0) === 0);
    });
    kept.sort((a, b) => (b.uses || 0) - (a.uses || 0) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const capped = kept.slice(0, 24);
    this.save(capped);
    return { before, after: capped.length, removed: before - capped.length };
  }
}
