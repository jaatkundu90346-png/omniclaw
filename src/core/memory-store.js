import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secret-redact.js";
import { atomicWriteFileSync, withFileLock } from "./atomic-write.js";

function normalizeAgentId(agentId = "") {
  // Strict slug — this value is used to build filesystem paths (workspace/agents/
  // <id>/memory/...). Trimming alone let "../../pwned" / "C:/tmp/x" escape the
  // workspace via memory_write. Stripping everything but [a-z0-9_-] makes path
  // traversal impossible (no separators, no "..", no drive letters survive).
  const slug = String(agentId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "")
    .slice(0, 64);
  return slug || "main";
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(value, max = 900) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 18))}...[truncated]`;
}

function uniqueList(items) {
  return [...new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

// Conversational filler (English + Hinglish) that must not drive recall — a
// user message like "kya tumhe yaad hai mera project" should match on
// "yaad/project", not on kya/mera/hai.
const STOPWORDS = new Set([
  "the", "is", "are", "was", "were", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for", "with", "it", "this", "that", "you", "your", "my", "me", "we", "our", "i", "do", "does", "did", "can", "could", "will", "would", "should", "have", "has", "had", "be", "been", "what", "which", "who", "how", "when", "where", "why", "please", "just", "also", "very", "some", "any",
  "ka", "ki", "ke", "ko", "se", "me", "mein", "pe", "par", "aur", "ya", "ha", "hai", "hain", "ho", "hu", "hoon", "tha", "thi", "the", "kya", "kyu", "kyon", "kaise", "kab", "kaha", "kahan", "kon", "kaun", "bhi", "to", "toh", "ye", "yeh", "wo", "woh", "na", "nahi", "nhi", "mat", "ek", "do", "abb", "ab", "mera", "meri", "mere", "tumhara", "tumhari", "apna", "apni", "uska", "uski", "iska", "iski", "wala", "wali", "karo", "kar", "karna", "hua", "hui", "gaya", "gayi", "raha", "rahi", "rha", "rhi", "bhai", "bro", "mujhe", "mujha", "tum", "aap", "main", "mai",
]);

// Tokens: latin + digits + Devanagari (Hinglish users mix scripts freely).
function tokenize(value = "") {
  return (String(value || "").toLowerCase().match(/[a-z0-9_ऀ-ॿ]{2,}/g) || []);
}

function contentTerms(value = "") {
  const terms = tokenize(value).filter((t) => !STOPWORDS.has(t));
  // A query that is ALL stopwords still deserves a match attempt.
  return terms.length > 0 ? terms : tokenize(value);
}

// BM25-lite relevance: coverage of query terms (dominant), small term-frequency
// bonus, exact-phrase bonus. Returns 0 when nothing matches.
function scoreText(query = "", text = "") {
  const terms = [...new Set(contentTerms(query))];
  if (terms.length === 0) return 0;
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return 0;
  const textTokens = tokenize(haystack);
  const tf = new Map();
  for (const token of textTokens) tf.set(token, (tf.get(token) || 0) + 1);
  let matched = 0;
  let freqBonus = 0;
  for (const term of terms) {
    const count = tf.get(term) || (haystack.includes(term) ? 1 : 0);
    if (count > 0) {
      matched += 1;
      freqBonus += Math.min(3, count) * 0.15;
    }
  }
  if (matched === 0) return 0;
  const coverage = matched / terms.length;
  const phrase = String(query || "").trim().toLowerCase();
  const phraseBonus = phrase.length >= 8 && haystack.includes(phrase) ? 1 : 0;
  return coverage * 2 + freqBonus + phraseBonus;
}

// Rank a list of items by scoreText over textOf(item), newest-first tiebreak.
// Threshold: at least one real term must match.
function rankByRelevance(items = [], query = "", textOf = (x) => x, limit = 12) {
  return items
    .map((item, index) => ({ item, index, score: scoreText(query, textOf(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, Math.max(1, limit))
    .map((entry) => Object.assign({}, entry.item, { _score: Number(entry.score.toFixed(3)) }));
}

// ── Memory hygiene (measured 2026-09-26) ────────────────────────────────
// The store held 755 conversation records = 49 MB JSON, of which 38 MB was
// raw toolOutputs (whole file contents, command dumps) copied out of the
// transcript. Nothing downstream needs them: the context bundle keeps only
// user/assistant/intents/plan + a tool COUNT (compactConversation), and the
// session transcript is the real record. Unbounded growth also made every
// read parse tens of MB. So a stored conversation is a bounded DIGEST:
// newest N tool outputs, each capped, plus capped user/assistant text.
export const CONVERSATION_TOOL_OUTPUT_LIMIT = 12;
export const CONVERSATION_TOOL_OUTPUT_CHARS = 600;
export const CONVERSATION_USER_CHARS = 2000;
export const CONVERSATION_ASSISTANT_CHARS = 4000;
export const CONVERSATION_RETENTION = 5000;

// Retention for the store arrays that previously grew without bound. Only
// conversations and attachmentExtracts had a cap, so notes/research/artifacts/
// dreams grew forever (this store was measured at 60MB before compaction).
// Keep the NEWEST N of each (same style as the conversation trim). longTerm is
// deliberately NOT capped: it is the curated, user-facing durable memory and
// must never be evicted automatically.
export const NOTES_RETENTION = 2000;
export const RESEARCH_RETENTION = 1000;
export const ARTIFACTS_RETENTION = 500;
export const DREAMS_RETENTION = 500;

// Drop the oldest entries past `max` (in place, returns true when trimmed).
function trimNewest(list, max) {
  if (!Array.isArray(list) || list.length <= max) return false;
  list.splice(0, list.length - max);
  return true;
}

export function boundToolOutputs(toolOutputs = []) {
  const list = Array.isArray(toolOutputs) ? toolOutputs.slice(-CONVERSATION_TOOL_OUTPUT_LIMIT) : [];
  return list.map((item) => {
    if (!item || typeof item !== "object") {
      return { tool: "unknown", output: redactSecrets(truncate(String(item == null ? "" : item), CONVERSATION_TOOL_OUTPUT_CHARS)) };
    }
    let encoded = "";
    try { encoded = JSON.stringify(item.output ?? item.result ?? item); } catch { encoded = String(item.output || ""); }
    // Redact the encoded form too: a short (non-digested) object output is still
    // stored verbatim below, but any secret in it is masked in `digestChars`
    // accounting and in the long-output digest path.
    const safeEncoded = redactSecrets(encoded);
    const shortOutput = typeof item.output === "string"
      ? redactSecrets(item.output)
      : typeof item.result === "string"
        ? redactSecrets(item.result)
        : item.output ?? item.result;
    // `...item` would re-introduce the RAW sibling fields (e.g. `result`) that
    // the redacted `output` above replaced — so redact every own string value
    // on the spread, not just the field we chose as the output.
    const safeItem = Object.fromEntries(
      Object.entries(item).map(([k, v]) => [k, typeof v === "string" ? redactSecrets(v) : v]),
    );
    return {
      ...safeItem,
      output: safeEncoded.length > CONVERSATION_TOOL_OUTPUT_CHARS
        ? `${safeEncoded.slice(0, Math.max(0, CONVERSATION_TOOL_OUTPUT_CHARS - 32))}...[digest stored; full output lives in the session transcript]`
        : shortOutput,
      digestChars: encoded.length,
    };
  });
}

// Only these plan keys are useful in a memory digest (compactConversation reads
// `summary`; plan-resume reads the live plan from the session, not memory).
// The auto-planner object also carries toolsAvailable (full tool schemas) and a
// modelToolLoop report — measured 7.3 MB + 1.9 MB of a 49 MB store. Dropped.
const PLAN_KEEP_KEYS = ["summary", "intents", "source", "toolCount", "modelPlanningSkipped", "modelPlanningReason"];

export function boundConversationPlan(plan = null) {
  if (!plan || typeof plan !== "object") return plan ?? null;
  const steps = Array.isArray(plan.steps)
    ? plan.steps.slice(0, 24).map((step) => ({
      title: redactSecrets(truncate(step?.title || step?.label || step?.tool || "", 160)),
      status: String(step?.status || "pending"),
      verification: redactSecrets(truncate(step?.verification || "", 160)),
    }))
    : [];
  const bounded = { steps };
  for (const key of PLAN_KEEP_KEYS) {
    const value = plan[key];
    if (value === undefined) continue;
    if (typeof value === "string") bounded[key] = redactSecrets(truncate(value, key === "summary" ? 600 : 200));
    else if (Array.isArray(value)) bounded[key] = value.slice(0, 8);
    else bounded[key] = value;
  }
  return bounded;
}

export function boundConversationRecord(entry = {}) {
  return {
    ...entry,
    // Secrets must never reach the durable store: these digests are read back
    // into the model prompt (and shipped to the provider). Redact by VALUE
    // pattern. Idempotent — redacting an already-redacted string is a no-op.
    user: redactSecrets(truncate(entry.user, CONVERSATION_USER_CHARS)),
    assistant: redactSecrets(truncate(entry.assistant, CONVERSATION_ASSISTANT_CHARS)),
    toolOutputs: boundToolOutputs(entry.toolOutputs),
    plan: boundConversationPlan(entry.plan),
  };
}

// The cache must never hand out a live reference: a caller that mutates what
// read() returned and then throws BEFORE write() would leave this.cache.data
// holding un-persisted edits, and the next write() would silently persist them
// (the "phantom record" bug). Copying in BOTH directions — read() returns a
// copy, write() caches a copy — makes the cached snapshot reachable only from
// inside this class.
//
// This is a bounded structural copy (store object -> array -> record -> the few
// nested arrays a record carries), not a full structuredClone deep copy: it is
// O(records) with no recursion, which matters because read() is on the hot
// recall path and the store can hold thousands of records.
function copyStoreData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (!Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.map((item) => {
      if (!item || typeof item !== "object") return item;
      const copy = { ...item };
      if (Array.isArray(item.tags)) copy.tags = [...item.tags];
      if (Array.isArray(item.toolOutputs)) copy.toolOutputs = item.toolOutputs.map((t) => (t && typeof t === "object" ? { ...t } : t));
      if (Array.isArray(item.plan)) copy.plan = item.plan.map((s) => (s && typeof s === "object" ? { ...s } : s));
      return copy;
    });
  }
  return out;
}

// The daily-memory FILENAME must follow the user's LOCAL day, not UTC.
// toISOString().slice(0,10) is UTC, so between 00:00 and 05:30 IST every note
// was written into "tomorrow's" file and the daily/topic reads drifted a day.
function localDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class MemoryStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "data", "memory.json");
    this.markdownPath = path.join(rootDir, "data", "MEMORY.md");
    this.cache = null;
    this.ensureFile();
    this.ensureMarkdownFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            conversations: [],
            notes: [],
            research: [],
            artifacts: [],
            attachmentExtracts: [],
            longTerm: [],
            dreams: [],
          },
          null,
          2,
        ),
      );
    }
  }

  read() {
    const stat = fs.statSync(this.filePath);
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return copyStoreData(this.cache.data);
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const data = {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      research: Array.isArray(parsed.research) ? parsed.research : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      attachmentExtracts: Array.isArray(parsed.attachmentExtracts) ? parsed.attachmentExtracts : [],
      longTerm: Array.isArray(parsed.longTerm) ? parsed.longTerm : [],
      dreams: Array.isArray(parsed.dreams) ? parsed.dreams : [],
    };
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
    };
    // Hand back a copy: callers mutate what they get and then call write().
    return copyStoreData(data);
  }

  // Atomic: a kill mid-write used to leave data/memory.json truncated, and the
  // next read() then threw on JSON.parse forever. Temp + rename makes the swap
  // all-or-nothing. See src/core/atomic-write.js.
  write(data) {
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
    const stat = fs.statSync(this.filePath);
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      // Cache a copy too, so the caller's object cannot reach back in later.
      data: copyStoreData(data),
    };
  }

  ensureMarkdownFile() {
    fs.mkdirSync(path.dirname(this.markdownPath), { recursive: true });
    if (!fs.existsSync(this.markdownPath)) {
      fs.writeFileSync(
        this.markdownPath,
        [
          "# OmniClaw Memory",
          "",
          "This file is generated from promoted long-term memories.",
          "",
          "## Long-Term Memories",
          "",
          "_No promoted memories yet._",
          "",
        ].join("\n"),
        "utf8",
      );
    }
  }

  getAgentWorkspaceMemoryDir(agentId = "main") {
    return path.join(this.rootDir, "workspace", "agents", normalizeAgentId(agentId), "memory");
  }

  getLayeredMemoryPaths(agentId = "main") {
    const agentDir = path.join(this.rootDir, "workspace", "agents", normalizeAgentId(agentId));
    const memoryDir = this.getAgentWorkspaceMemoryDir(agentId);
    const today = localDateStamp();
    return {
      sessionTranscriptDir: path.join(this.rootDir, "data", "sessions", "transcripts"),
      dailyMemoryDir: memoryDir,
      dailyMemoryPath: path.join(memoryDir, `${today}.md`),
      longTermMemoryPath: path.join(agentDir, "MEMORY.md"),
      // UNUSED: DREAMS.md is declared here but nothing reads or writes it —
      // getDreams() reads the `dreams` array in memory.json. Kept for path
      // compatibility; do not treat it as the source of truth.
      dreamsPath: path.join(agentDir, "DREAMS.md"),
      jsonMemoryPath: this.filePath,
      generatedLongTermPath: this.markdownPath,
    };
  }

  ensureLayeredMemoryFiles(agentId = "main") {
    const paths = this.getLayeredMemoryPaths(agentId);
    fs.mkdirSync(paths.dailyMemoryDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.longTermMemoryPath), { recursive: true });
    if (!fs.existsSync(paths.dailyMemoryPath)) {
      fs.writeFileSync(paths.dailyMemoryPath, `# Daily Memory ${localDateStamp()}\n\n`, "utf8");
    }
    if (!fs.existsSync(paths.longTermMemoryPath)) {
      fs.writeFileSync(paths.longTermMemoryPath, "# MEMORY\n\nDurable facts, preferences, decisions, and action boundaries.\n\n", "utf8");
    }
    if (!fs.existsSync(paths.dreamsPath)) {
      fs.writeFileSync(paths.dreamsPath, "# DREAMS\n\nReview summaries and memory compaction notes.\n\n", "utf8");
    }
    return paths;
  }

  syncMarkdown() {
    const data = this.read();
    const items = data.longTerm.slice().sort((left, right) => String(right.promotedAt).localeCompare(String(left.promotedAt)));
    const lines = [
      "# OmniClaw Memory",
      "",
      "This file is generated from promoted long-term memories.",
      "",
      "## Long-Term Memories",
      "",
    ];

    if (items.length === 0) {
      lines.push("_No promoted memories yet._", "");
    } else {
      for (const item of items) {
        lines.push(`### ${item.title || item.id}`);
        lines.push("");
        lines.push(`- Agent: ${item.agentId || "main"}`);
        lines.push(`- Importance: ${item.importance || "medium"}`);
        lines.push(`- Source: ${item.sourceRef || item.sourceType || "manual"}`);
        lines.push(`- Promoted: ${item.promotedAt || item.createdAt || ""}`);
        if (Array.isArray(item.tags) && item.tags.length > 0) {
          lines.push(`- Tags: ${item.tags.join(", ")}`);
        }
        lines.push("");
        lines.push(item.text || "");
        lines.push("");
      }
    }

    fs.writeFileSync(this.markdownPath, lines.join("\n"), "utf8");
    return {
      path: this.markdownPath,
      memoryCount: items.length,
    };
  }

  filterByAgent(items, agentId = "") {
    if (!agentId) {
      return items;
    }

    const normalized = normalizeAgentId(agentId);
    return items.filter((item) => normalizeAgentId(item.agentId) === normalized);
  }

  appendConversation(entry) {
    const data = this.read();
    data.conversations.push({
      agentId: normalizeAgentId(entry.agentId),
      ...boundConversationRecord(entry),
    });
    // Retention: keep the newest CONVERSATION_RETENTION digests. Each record is
    // bounded, so this caps the store instead of letting it grow forever.
    if (data.conversations.length > CONVERSATION_RETENTION) {
      data.conversations = data.conversations.slice(-CONVERSATION_RETENTION);
    }
    this.write(data);
    return data;
  }

  addNote(text, options = {}) {
    const data = this.read();
    data.notes.push({
      id: `note_${Date.now()}`,
      // Notes are read straight back into the prompt — redact before they land.
      text: redactSecrets(text),
      agentId: normalizeAgentId(options.agentId),
      createdAt: new Date().toISOString(),
    });
    // Retention: keep the newest NOTES_RETENTION notes (they are read back
    // into the prompt, so an unbounded list also degraded recall quality).
    trimNewest(data.notes, NOTES_RETENTION);
    this.write(data);
    return data.notes[data.notes.length - 1];
  }

  getRecentConversations(limit = 12, agentId = "") {
    return this.filterByAgent(this.read().conversations, agentId).slice(-limit);
  }

  getNotes(agentId = "") {
    return this.filterByAgent(this.read().notes, agentId);
  }

  addResearch(entry) {
    const data = this.read();
    const record = {
      id: `research_${Date.now()}`,
      createdAt: new Date().toISOString(),
      agentId: normalizeAgentId(entry.agentId),
      ...entry,
    };
    data.research.push(record);
    trimNewest(data.research, RESEARCH_RETENTION);
    this.write(data);
    return record;
  }

  getResearch(limit = 10, agentId = "") {
    return this.filterByAgent(this.read().research, agentId).slice(-limit);
  }

  writeLayeredMemory({
    type = "daily",
    content = "",
    source = "manual",
    expiry = "",
    actionBoundary = "",
    agentId = "main",
    sessionId = "",
    runId = "",
    title = "",
    tags = [],
    importance = "",
  } = {}) {
    const text = redactSecrets(truncate(content, 4000));
    if (!text) {
      return { ok: false, error: "content is required" };
    }
    const normalizedType = String(type || "daily").toLowerCase();
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const at = new Date().toISOString();
    const boundaryLine = actionBoundary ? `Action boundary: ${actionBoundary}` : "";
    const meta = [
      `Source: ${source || "manual"}`,
      sessionId ? `Session: ${sessionId}` : "",
      runId ? `Run: ${runId}` : "",
      expiry ? `Expiry: ${expiry}` : "",
      boundaryLine,
    ].filter(Boolean);
    const entry = [
      `\n## ${normalizedType} (${at})`,
      ...meta.map((line) => `- ${line}`),
      "",
      text,
      "",
    ].join("\n");

    if (["long-term", "longterm", "durable", "memory"].includes(normalizedType)) {
      fs.appendFileSync(paths.longTermMemoryPath, entry, "utf8");
      const promoted = this.promoteMemory({
        text,
        title: String(title || "").trim().slice(0, 120) || text.split(/\r?\n/)[0].slice(0, 120) || "Manual memory",
        sourceType: "memory_write",
        sourceId: runId || sessionId || createId("manual_memory"),
        agentId,
        importance: ["low", "medium", "high"].includes(String(importance || "").toLowerCase())
          ? String(importance).toLowerCase()
          : (actionBoundary ? "high" : "medium"),
        tags: uniqueList([
          "memory-write",
          actionBoundary ? "action-boundary" : "",
          normalizedType,
          ...(Array.isArray(tags) ? tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 6) : []),
        ]),
        actionBoundary,
        expiry,
      });
      return { ok: true, layer: "longTerm", path: paths.longTermMemoryPath, memory: promoted.memory || promoted, actionBoundary };
    }

    const note = this.addNote(text, { agentId });
    fs.appendFileSync(paths.dailyMemoryPath, entry, "utf8");
    return { ok: true, layer: "daily", path: paths.dailyMemoryPath, note, actionBoundary };
  }

  getLayeredMemory({ file = "overview", range = "", agentId = "main" } = {}) {
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const key = String(file || "overview").toLowerCase();
    if (key === "overview") {
      return {
        overview: this.getOverview(agentId),
        paths,
        layers: {
          sessionTranscript: paths.sessionTranscriptDir,
          dailyMemory: paths.dailyMemoryPath,
          longTermMemory: paths.longTermMemoryPath,
          dreams: paths.dreamsPath,
        },
        recent: {
          conversations: this.getRecentConversations(6, agentId),
          notes: this.getNotes(agentId).slice(-8),
          longTerm: this.getLongTermMemory(8, agentId),
        },
      };
    }
    const filePath = key.includes("dream") ? paths.dreamsPath
      : key.includes("daily") || key.includes("today") ? paths.dailyMemoryPath
      : key.includes("json") ? paths.jsonMemoryPath
      : paths.longTermMemoryPath;
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const lines = content.split(/\r?\n/);
    const match = String(range || "").match(/(\d+)\s*-\s*(\d+)/);
    const selected = match
      ? lines.slice(Math.max(0, Number(match[1]) - 1), Math.min(lines.length, Number(match[2]))).join("\n")
      : content;
    return { file, path: filePath, range: range || "", content: truncate(selected, 12000), lineCount: lines.length };
  }

  addArtifact(entry) {
    const data = this.read();
    const record = {
      id: `artifact_${Date.now()}`,
      createdAt: new Date().toISOString(),
      agentId: normalizeAgentId(entry.agentId),
      ...entry,
    };
    data.artifacts.push(record);
    trimNewest(data.artifacts, ARTIFACTS_RETENTION);
    this.write(data);
    return record;
  }

  getArtifacts(limit = 10, agentId = "") {
    return this.filterByAgent(this.read().artifacts, agentId).slice(-limit);
  }

  addAttachmentExtract(entry = {}) {
    const data = this.read();
    const sourceId = String(entry.extractId || entry.sourceId || "").trim() || createId("attachment_extract_source");
    const agentId = normalizeAgentId(entry.agentId);
    const existingIndex = data.attachmentExtracts.findIndex(
      (item) => String(item.sourceId || item.extractId || "") === sourceId && normalizeAgentId(item.agentId) === agentId,
    );
    const record = {
      id: existingIndex === -1 ? createId("attachment_extract") : data.attachmentExtracts[existingIndex].id,
      sourceId,
      extractId: String(entry.extractId || sourceId).trim(),
      cacheId: String(entry.cacheId || "").trim(),
      deliveryId: String(entry.deliveryId || "").trim(),
      adapterId: String(entry.adapterId || "").trim(),
      agentId,
      sessionId: String(entry.sessionId || "").trim(),
      runId: String(entry.runId || "").trim(),
      title: truncate(entry.title || entry.name || "Imported attachment extract", 140),
      text: truncate(entry.text || "", 2400),
      status: String(entry.status || "completed").trim(),
      sourceRef: String(entry.sourceRef || `attachment-extract:${sourceId}`).trim(),
      tags: uniqueList(["attachment-extract", entry.adapterId, ...(entry.tags || [])]),
      createdAt: existingIndex === -1 ? new Date().toISOString() : data.attachmentExtracts[existingIndex].createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (existingIndex === -1) {
      data.attachmentExtracts.push(record);
      if (data.attachmentExtracts.length > 300) {
        data.attachmentExtracts = data.attachmentExtracts.slice(-300);
      }
    } else {
      data.attachmentExtracts[existingIndex] = record;
    }
    this.write(data);
    return record;
  }

  getLongTermMemory(limit = 50, agentId = "") {
    return this.filterByAgent(this.read().longTerm, agentId).slice(-limit).reverse();
  }

  getDreams(limit = 20, agentId = "") {
    return this.filterByAgent(this.read().dreams, agentId).slice(-limit).reverse();
  }

  getOverview(agentId = "") {
    const data = this.read();
    const scopedLongTerm = this.filterByAgent(data.longTerm, agentId);
    const scopedDreams = this.filterByAgent(data.dreams, agentId);
    const scopedCandidates = this.getPromotionCandidates({ agentId, limit: 50 });
    return {
      notes: this.filterByAgent(data.notes, agentId).length,
      conversations: this.filterByAgent(data.conversations, agentId).length,
      research: this.filterByAgent(data.research, agentId).length,
      artifacts: this.filterByAgent(data.artifacts, agentId).length,
      attachmentExtracts: this.filterByAgent(data.attachmentExtracts, agentId).length,
      longTerm: scopedLongTerm.length,
      dreams: scopedDreams.length,
      candidates: scopedCandidates.length,
      markdownPath: this.markdownPath,
      lastDreamAt: scopedDreams[scopedDreams.length - 1]?.createdAt || null,
    };
  }

  // ── Structured memory (Claude Code style: one fact = one file) ────────────
  // Each durable memory is its own markdown file with frontmatter under
  // workspace/agents/<id>/memory/<slug>.md, and MEMORY.md carries a
  // harness-maintained one-line-per-memory INDEX that is injected into every
  // run — the model scans the index cheaply and opens a file only when needed.
  static MEMORY_INDEX_MARK = "## Memory Index (one line per memory — harness-maintained)";

  slugifyMemoryName(title = "") {
    const slug = String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9ऀ-ॿ]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return slug || createId("memory").toLowerCase();
  }

  // Two different titles that slugify identically (e.g. "Prefers pnpm" and
  // "Prefers PNPM", or any two notes whose first 60 chars match) used to land on
  // the SAME <slug>.md and silently overwrite each other — the first memory was
  // destroyed with no error, and its index line was rewritten to the new text.
  // Re-slug with a -2/-3/... suffix when the existing file belongs to a
  // DIFFERENT title; keep the slug when it is the same title, so updating a
  // memory in place (replaceMemory) still edits one file.
  uniqueMemorySlug(slug, dir, heading) {
    const wanted = String(heading || "").trim().toLowerCase();
    const fileFor = (name) => path.join(dir, `${name}.md`);
    if (!fs.existsSync(fileFor(slug))) return slug;
    let existingTitle = "";
    try {
      existingTitle = (fs.readFileSync(fileFor(slug), "utf8").match(/^#\s+(.+)$/m)?.[1] || "").trim().toLowerCase();
    } catch (error) {
      console.warn("[memory] uniqueMemorySlug read:", error.message);
    }
    if (existingTitle && existingTitle === wanted) return slug;
    for (let suffix = 2; suffix <= 200; suffix += 1) {
      const candidate = `${slug}-${suffix}`;
      if (!fs.existsSync(fileFor(candidate))) return candidate;
      let candidateTitle = "";
      try {
        candidateTitle = (fs.readFileSync(fileFor(candidate), "utf8").match(/^#\s+(.+)$/m)?.[1] || "").trim().toLowerCase();
      } catch (error) {
        console.warn("[memory] uniqueMemorySlug read:", error.message);
      }
      if (candidateTitle && candidateTitle === wanted) return candidate;
    }
    return `${slug}-${Date.now().toString(36)}`;
  }

  writeStructuredMemory({ agentId = "main", title = "", text = "", type = "project", tags = [], description = "" } = {}) {
    try {
      const paths = this.ensureLayeredMemoryFiles(agentId);
      // Secrets must never reach durable memory: a memory file is indexed in
      // MEMORY.md and can be read into the model's context (and shipped to the
      // provider). Found live 2026-09-26: workspace/agents/main/memory/ held a
      // file with a real `sk-live-...` key. Redact by VALUE pattern on write.
      const body = redactSecrets(truncate(String(text || "").trim(), 2400));
      const heading = redactSecrets(truncate(String(title || "").trim() || body.slice(0, 60), 120));
      if (!body) return { ok: false, error: "text is required" };
      const slug = this.uniqueMemorySlug(this.slugifyMemoryName(heading), paths.dailyMemoryDir, heading);
      const file = path.join(paths.dailyMemoryDir, `${slug}.md`);
      const now = new Date().toISOString();
      let createdAt = now;
      const existed = fs.existsSync(file);
      if (existed) {
        try {
          const prior = fs.readFileSync(file, "utf8");
          createdAt = prior.match(/^createdAt:\s*(\S+)/m)?.[1] || now;
        } catch { /* keep now */ }
      }
      const desc = truncate(String(description || "").trim() || body.split(/[.\n।]/)[0], 140);
      const safeTags = uniqueList(tags).slice(0, 8);
      const content = [
        "---",
        `name: ${slug}`,
        `description: ${desc.replace(/\r?\n/g, " ")}`,
        "metadata:",
        `  type: ${String(type || "project").toLowerCase()}`,
        safeTags.length ? `  tags: ${safeTags.join(", ")}` : "",
        `createdAt: ${createdAt}`,
        `updatedAt: ${now}`,
        "---",
        "",
        `# ${heading}`,
        "",
        body,
        "",
      ].filter((line) => line !== "").join("\n");
      fs.writeFileSync(file, content, "utf8");
      this.updateMemoryIndex(agentId, { slug, title: heading, description: desc });
      return { ok: true, path: file, slug, updated: existed };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  updateMemoryIndex(agentId, { slug, title, description }) {
    try {
      const paths = this.ensureLayeredMemoryFiles(agentId);
      const indexPath = paths.longTermMemoryPath; // workspace/agents/<id>/MEMORY.md
      let text = "";
      try {
        text = fs.readFileSync(indexPath, "utf8");
      } catch (error) {
        // A missing file is the normal "first write" case, so this stays quiet.
        if (error?.code !== "ENOENT") console.warn("[memory] updateMemoryIndex read:", error.message);
      }
      const MARK = MemoryStore.MEMORY_INDEX_MARK;
      let head = text;
      let section = "";
      const markIndex = text.indexOf(MARK);
      if (markIndex !== -1) {
        head = text.slice(0, markIndex);
        section = text.slice(markIndex + MARK.length);
      }
      const line = `- [${title}](memory/${slug}.md) — ${description}`;
      const lines = section.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("- ["));
      const withoutOld = lines.filter((l) => !l.includes(`(memory/${slug}.md)`));
      const updated = [line, ...withoutOld].slice(0, 200); // newest first, bounded
      const headText = head.trim() || "# MEMORY\n\nDurable facts, preferences, decisions, and action boundaries.";
      fs.writeFileSync(indexPath, `${headText}\n\n${MARK}\n\n${updated.join("\n")}\n`, "utf8");
    } catch (error) {
      // Was `catch { }` — a failed index rewrite was invisible, so MEMORY.md
      // silently stopped matching the store.
      console.warn("[memory] updateMemoryIndex:", error.message);
    }
  }

  readMemoryIndex(agentId = "main", maxChars = 1600) {
    try {
      const paths = this.getLayeredMemoryPaths(agentId);
      const text = fs.readFileSync(paths.longTermMemoryPath, "utf8");
      const markIndex = text.indexOf(MemoryStore.MEMORY_INDEX_MARK);
      if (markIndex === -1) return "";
      return text.slice(markIndex + MemoryStore.MEMORY_INDEX_MARK.length).trim().slice(0, maxChars);
    } catch (error) {
      // Was `catch { return "" }` — an unreadable MEMORY.md index silently
      // dropped the whole memory index out of the prompt, with no signal.
      // ENOENT is normal on a fresh install, so only warn on real failures.
      if (error?.code !== "ENOENT") console.warn("[memory] readMemoryIndex:", error.message);
      return "";
    }
  }

  promoteMemory(input = {}) {
    const data = this.read();
    const agentId = normalizeAgentId(input.agentId);
    // Redact once, at the top: every downstream consumer (memory.json record,
    // syncMarkdown's data/MEMORY.md, the per-fact <slug>.md file, the semantic
    // index) derives from these two fields, so this covers all of them.
    const safeText = redactSecrets(input.text || "");
    const safeTitle = redactSecrets(input.title || "");
    const sourceType = String(input.sourceType || "manual").trim();
    const sourceId = String(input.sourceId || "").trim();
    const sourceRef = sourceId ? `${sourceType}:${sourceId}` : `manual:${createId("source")}`;
    const existing = data.longTerm.find(
      (item) => item.sourceRef === sourceRef && normalizeAgentId(item.agentId) === agentId,
    );
    if (existing) {
      return {
        created: false,
        memory: existing,
        markdown: this.syncMarkdown(),
      };
    }

    const record = {
      id: createId("memory"),
      agentId,
      title: truncate(safeTitle || "Promoted memory", 140),
      text: truncate(safeText, 2000),
      sourceType,
      sourceId,
      sourceRef,
      importance: String(input.importance || "medium").trim().toLowerCase(),
      tags: uniqueList(input.tags || []),
      createdAt: new Date().toISOString(),
      promotedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.longTerm.push(record);
    this.write(data);
    // Keep the semantic index in sync — set by the runtime after construction
    // (fire-and-forget; embedding failures never block a memory write).
    if (typeof this.onPromote === "function") {
      try { void this.onPromote(record); } catch { /* best effort */ }
    }
    // Claude Code-style file-per-fact + MEMORY.md index entry, so every
    // promoted memory is a readable, editable markdown file the model (and
    // the user) can open directly.
    const structuredType = record.tags.includes("user-fact") || record.sourceType === "auto_capture"
      ? "user"
      : record.tags.includes("action-boundary") ? "feedback" : "project";
    this.writeStructuredMemory({
      agentId,
      title: record.title,
      text: record.text,
      type: structuredType,
      tags: record.tags,
    });
    return {
      created: true,
      memory: record,
      markdown: this.syncMarkdown(),
    };
  }

  // ── Memory edit/delete (Hermes parity) ─────────────────────────────────
  // Hermes lets the agent fix or drop a saved memory by a short unique
  // substring (old_text matching). Without this, a wrongly-saved fact stays in
  // every future prompt forever — the model's only option was writing a
  // duplicate "correction" memory next to the wrong one.
  findLongTermMatches(match, agentId = "") {
    const needle = String(match || "").trim().toLowerCase();
    if (!needle) return [];
    return this.filterByAgent(this.read().longTerm, agentId).filter((item) =>
      `${item.title || ""} ${item.text || ""}`.toLowerCase().includes(needle),
    );
  }

  requireSingleMatch(match, agentId) {
    const matches = this.findLongTermMatches(match, agentId);
    if (matches.length === 0) {
      return { error: `No long-term memory matches "${match}". Use list_long_term_memory or memory_search to see what is saved.` };
    }
    if (matches.length > 1) {
      const titles = matches.slice(0, 5).map((m) => `"${m.title}"`).join(", ");
      return { error: `"${match}" matches ${matches.length} memories (${titles}${matches.length > 5 ? ", …" : ""}). Use a longer, more specific substring that identifies exactly one.` };
    }
    return { memory: matches[0] };
  }

  removeMemoryIndexEntry(agentId, slug) {
    try {
      const paths = this.getLayeredMemoryPaths(agentId);
      const text = fs.readFileSync(paths.longTermMemoryPath, "utf8");
      const kept = text.split(/\r?\n/).filter((line) => !line.includes(`(memory/${slug}.md)`));
      fs.writeFileSync(paths.longTermMemoryPath, kept.join("\n"), "utf8");
    } catch { /* index is best-effort */ }
  }

  removeStructuredMemoryFile(agentId, title) {
    try {
      const slug = this.slugifyMemoryName(title);
      const paths = this.getLayeredMemoryPaths(agentId);
      // Since writeStructuredMemory can now disambiguate colliding slugs with
      // a -2/-3 suffix, the file for this title may not be `<slug>.md`. Match on
      // the H1 so the right file (and its index line) is removed — otherwise a
      // forgotten file-per-fact kept serving the deleted memory's content.
      const wanted = String(title || "").trim().toLowerCase();
      const candidates = [slug];
      try {
        for (const entry of fs.readdirSync(paths.dailyMemoryDir)) {
          if (!entry.endsWith(".md")) continue;
          const base = entry.replace(/\.md$/, "");
          if (base !== slug && !base.startsWith(`${slug}-`)) continue;
          const head = (fs.readFileSync(path.join(paths.dailyMemoryDir, entry), "utf8").match(/^#\s+(.+)$/m)?.[1] || "").trim().toLowerCase();
          if (head && head === wanted) candidates.push(base);
        }
      } catch (error) {
        console.warn("[memory] removeStructuredMemoryFile scan:", error.message);
      }
      for (const name of [...new Set(candidates)]) {
        const file = path.join(paths.dailyMemoryDir, `${name}.md`);
        if (fs.existsSync(file)) fs.rmSync(file);
        this.removeMemoryIndexEntry(agentId, name);
      }
    } catch (error) {
      // file-per-fact is best-effort; the JSON store is the truth
      console.warn("[memory] removeStructuredMemoryFile:", error.message);
    }
  }

  replaceMemory({ agentId = "", match = "", text = "", title = "" } = {}) {
    const newText = String(text || "").trim();
    if (!newText) return { ok: false, error: "text is required — the corrected content of the memory." };
    const found = this.requireSingleMatch(match, agentId);
    if (found.error) return { ok: false, error: found.error };
    const data = this.read();
    const record = data.longTerm.find((item) => item.id === found.memory.id);
    const oldTitle = record.title;
    const newTitle = truncate(String(title || "").trim(), 140) || oldTitle;
    record.title = newTitle;
    record.text = truncate(newText, 2000);
    record.updatedAt = new Date().toISOString();
    this.write(data);
    // A renamed memory gets a new slug — drop the old file/index line so the
    // stale copy doesn't keep surfacing next to the corrected one.
    if (newTitle !== oldTitle) this.removeStructuredMemoryFile(record.agentId || agentId || "main", oldTitle);
    this.writeStructuredMemory({
      agentId: record.agentId || agentId || "main",
      title: record.title,
      text: record.text,
      tags: record.tags,
    });
    if (typeof this.onPromote === "function") {
      try { void this.onPromote(record); } catch { /* re-embed is best effort */ }
    }
    this.syncMarkdown();
    return { ok: true, updated: true, memory: record };
  }

  removeMemory({ agentId = "", match = "" } = {}) {
    const found = this.requireSingleMatch(match, agentId);
    if (found.error) return { ok: false, error: found.error };
    const data = this.read();
    const index = data.longTerm.findIndex((item) => item.id === found.memory.id);
    const [removed] = data.longTerm.splice(index, 1);
    this.write(data);
    this.removeStructuredMemoryFile(removed.agentId || agentId || "main", removed.title);
    this.syncMarkdown();
    return { ok: true, removed: { id: removed.id, title: removed.title } };
  }

  // Capacity snapshot for the always-injected memory index — Hermes shows the
  // agent "67% — 1,474/2,200 chars" so it knows WHEN to consolidate instead of
  // appending forever.
  getMemoryCapacityInfo(agentId = "main", indexLimit = 1600) {
    const fullIndex = this.readMemoryIndex(agentId, 1_000_000);
    const indexChars = fullIndex.length;
    return {
      memories: this.filterByAgent(this.read().longTerm, agentId).length,
      indexChars,
      indexLimit,
      percent: Math.min(100, Math.round((indexChars / indexLimit) * 100)),
    };
  }

  buildCandidate({ sourceType, sourceId, agentId, title, text, score, reason, tags = [] }) {
    return {
      id: `${sourceType}:${sourceId}`,
      sourceType,
      sourceId,
      agentId: normalizeAgentId(agentId),
      title: truncate(title, 140),
      text: truncate(text, 1400),
      score: Number(score || 0),
      reason,
      tags: uniqueList(tags),
    };
  }

  getPromotionCandidates({ limit = 12, agentId = "" } = {}) {
    const data = this.read();
    const promoted = new Set(data.longTerm.map((item) => item.sourceRef).filter(Boolean));
    const candidates = [];

    for (const note of this.filterByAgent(data.notes, agentId)) {
      const sourceRef = `note:${note.id}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      candidates.push(
        this.buildCandidate({
          sourceType: "note",
          sourceId: note.id,
          agentId: note.agentId,
          title: truncate(note.text, 90) || "Memory note",
          text: note.text,
          score: 0.7,
          reason: "Explicit user note saved with remember.",
          tags: ["note"],
        }),
      );
    }

    for (const conversation of this.filterByAgent(data.conversations, agentId).slice(-30)) {
      const sourceRef = `conversation:${conversation.runId || conversation.at}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      const intents = Array.isArray(conversation.intents) ? conversation.intents : [];
      const importantIntent = intents.some((intent) =>
        ["planning", "config-update", "skill-create", "research", "file-write", "shell-plan"].includes(intent),
      );
      candidates.push(
        this.buildCandidate({
          sourceType: "conversation",
          sourceId: conversation.runId || conversation.at,
          agentId: conversation.agentId,
          title: truncate(conversation.user || "Conversation", 90),
          text: `User: ${conversation.user || ""}\nAssistant: ${conversation.assistant || ""}`,
          score: importantIntent ? 0.8 : 0.45,
          reason: importantIntent ? `Important intent(s): ${intents.join(", ")}` : "Recent conversation context.",
          tags: ["conversation", ...intents.slice(0, 3)],
        }),
      );
    }

    for (const research of this.filterByAgent(data.research, agentId)) {
      const sourceRef = `research:${research.id}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      const first = research.results?.[0];
      candidates.push(
        this.buildCandidate({
          sourceType: "research",
          sourceId: research.id,
          agentId: research.agentId,
          title: research.query || first?.title || "Research memory",
          text: [
            `Query: ${research.query || ""}`,
            ...(research.results || [])
              .slice(0, 3)
              .map((result) => `- ${result.title || result.url || "result"} ${result.url || ""}`),
          ].join("\n"),
          score: 0.72,
          reason: "Research result can support future answers.",
          tags: ["research"],
        }),
      );
    }

    for (const extract of this.filterByAgent(data.attachmentExtracts, agentId)) {
      const sourceId = extract.sourceId || extract.extractId || extract.id;
      const sourceRef = `attachment-extract:${sourceId}`;
      if (promoted.has(sourceRef)) {
        continue;
      }
      candidates.push(
        this.buildCandidate({
          sourceType: "attachment-extract",
          sourceId,
          agentId: extract.agentId,
          title: extract.title || "Imported attachment extract",
          text: extract.text,
          score: extract.status === "completed" ? 0.78 : 0.58,
          reason: "Attachment text was imported into an OmniClaw session and may be useful later.",
          tags: extract.tags || ["attachment-extract"],
        }),
      );
    }

    return candidates.sort((left, right) => right.score - left.score).slice(0, Number(limit || 12));
  }

  async scoreCandidatesWithModel(candidates, provider, model = "") {
    if (!candidates || candidates.length === 0 || !provider) {
      return candidates;
    }

    const prompt = `Review the following memory candidates and score them for long-term storage.
Return a JSON array of objects, each containing:
- id: (string) matches the input candidate id
- score: (number 0.0 to 1.0) higher means more valuable
- reason: (string) short explanation of why this is valuable or not
- title: (string) a better, more descriptive title if needed
- tags: (string array) 2-3 relevant tags

Scoring Criteria:
1. Novelty: Does it contain new information not likely in the model's base training?
2. Utility: How useful will this be for future task execution or user preferences?
3. Importance: Is it a key decision, a complex research result, or a specific user instruction?

Candidates:
${JSON.stringify(candidates.map(c => ({ id: c.id, title: c.title, text: c.text })), null, 2)}`;

    try {
      // modelOverride: background scoring rides the cheap model when the
      // caller passes one (empty = main model, same as before).
      const modelOpt = String(model || "").trim() ? { model: String(model).trim() } : {};
      const response = await provider.complete([
        { role: "system", content: "You are a memory consolidation expert. You only output valid JSON arrays." },
        { role: "user", content: prompt }
      ], modelOpt);

      const text = response.text || "[]";
      const scores = JSON.parse(text.match(/\[.*\]/s)?.[0] || "[]");
      const scoreMap = new Map(scores.map(s => [s.id, s]));

      return candidates.map(c => {
        const update = scoreMap.get(c.id);
        if (!update) return c;
        return {
          ...c,
          score: update.score ?? c.score,
          reason: update.reason ?? c.reason,
          title: update.title ?? c.title,
          tags: uniqueList([...(c.tags || []), ...(update.tags || [])]),
        };
      });
    } catch (error) {
      console.error("Dreaming score error:", error);
      return candidates; // Fallback to heuristic scores
    }
  }
  async runDreamSweep({ agentId = "", limit = 5, minScore = 0.65, source = "manual",
provider = null, model = "" } = {}) {
    let candidates = this.getPromotionCandidates({ agentId, limit: Math.max(Number(limit || 5), 1) * 3 });

    if (provider) {
      candidates = await this.scoreCandidatesWithModel(candidates, provider, model);
    }

    const finalCandidates = candidates
      .filter((candidate) => candidate.score >= Number(minScore || 0.65))
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(limit || 5));

    // Serialize the promote + dream-record phase against other sweeps. This is
    // the one read-modify-write on memory.json with an `await` before it (the
    // model scoring above), so two concurrent sweeps could each read the store,
    // then interleave their promote()/write() calls and lose a promotion.
    // Every OTHER mutator in this class is fully synchronous read→write with no
    // await in between, which Node already runs to completion — those are safe
    // without a lock.
    return withFileLock(this.filePath, () => {
      const promoted = finalCandidates.map((candidate) =>
        this.promoteMemory({
          agentId: candidate.agentId,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          title: candidate.title,
          text: candidate.text,
          importance: candidate.score >= 0.78 ? "high" : "medium",
          tags: ["dream", ...candidate.tags],
        }).memory,
      );
      const data = this.read();
      const dream = {
        id: createId("dream"),
        agentId: normalizeAgentId(agentId),
        source,
        createdAt: new Date().toISOString(),
        candidateCount: candidates.length,
        promotedCount: promoted.length,
        promotedMemoryIds: promoted.map((item) => item.id),
        summary:
          promoted.length > 0
            ? `Promoted ${promoted.length} memory item(s): ${promoted.map((item) => item.title).join("; ")}`
            : "No memory candidates met the promotion threshold.",
      };
      data.dreams.push(dream);
      trimNewest(data.dreams, DREAMS_RETENTION);
      this.write(data);
      this.syncMarkdown();
      return {
        dream,
        promoted,
        candidates,
      };
    });
  }

  // ─── Search Methods ───────────────────────────────────────────
  // Token-scored ranked recall (BM25-lite). The old substring matching meant a
  // multi-word query — e.g. the user's WHOLE message from ActiveMemory — never
  // matched anything, which is exactly why memory felt "weak": recall returned
  // nothing unless the query was a verbatim substring.
  searchNotes(query, agentId = "", limit = 12) {
    if (!String(query || "").trim()) return [];
    return rankByRelevance(this.filterByAgent(this.read().notes, agentId), query, (note) => note.text || "", limit);
  }

  searchLongTerm(query, agentId = "", limit = 12) {
    if (!String(query || "").trim()) return [];
    return rankByRelevance(
      this.filterByAgent(this.read().longTerm, agentId),
      query,
      (item) => `${item.title || ""} ${item.text || ""} ${(item.tags || []).join(" ")}`,
      limit,
    );
  }

  searchResearch(query, agentId = "", limit = 12) {
    if (!String(query || "").trim()) return [];
    return rankByRelevance(
      this.filterByAgent(this.read().research, agentId),
      query,
      (item) => `${item.query || ""} ${JSON.stringify(item.results || []).slice(0, 4000)}`,
      limit,
    );
  }

  searchArtifacts(query, agentId = "", limit = 12) {
    if (!String(query || "").trim()) return [];
    return rankByRelevance(
      this.filterByAgent(this.read().artifacts, agentId),
      query,
      (item) => `${item.path || ""} ${item.kind || ""}`,
      limit,
    );
  }

  searchConversations(query, agentId = "", limit = 8) {
    if (!String(query || "").trim()) return [];
    return rankByRelevance(
      this.filterByAgent(this.read().conversations, agentId),
      query,
      (item) => `${item.user || ""} ${item.assistant || ""}`,
      limit,
    );
  }

  searchAll(query, agentId = "") {
    const data = this.read();
    const attachmentExtracts = !String(query || "").trim() ? [] : rankByRelevance(
      this.filterByAgent(data.attachmentExtracts, agentId),
      query,
      (item) => `${item.title || ""} ${item.text || ""} ${(item.tags || []).join(" ")}`,
      8,
    );
    return {
      notes: this.searchNotes(query, agentId),
      longTerm: this.searchLongTerm(query, agentId),
      research: this.searchResearch(query, agentId),
      artifacts: this.searchArtifacts(query, agentId),
      conversations: this.searchConversations(query, agentId),
      attachmentExtracts,
    };
  }

  flattenMemoryItems(agentId = "") {
    const data = this.read();
    const make = (layer, item, text, title = "") => ({
      layer,
      id: item.id || `${layer}_${Math.random().toString(36).slice(2)}`,
      agentId: item.agentId || agentId || "main",
      title,
      text: truncate(text, 2200),
      item,
    });
    return [
      ...this.filterByAgent(data.conversations, agentId).map((item) =>
        make("session", item, [item.user, item.assistant, JSON.stringify(item.toolOutputs || [])].join("\n"), item.sessionId || item.runId || "conversation")),
      ...this.filterByAgent(data.notes, agentId).map((item) => make("daily", item, item.text, "note")),
      ...this.filterByAgent(data.longTerm, agentId).map((item) => make("longTerm", item, `${item.title || ""}\n${item.text || ""}\n${(item.tags || []).join(" ")}`, item.title || "long-term")),
      ...this.filterByAgent(data.research, agentId).map((item) => make("research", item, `${item.query || ""}\n${JSON.stringify(item.results || [])}`, item.query || "research")),
      ...this.filterByAgent(data.artifacts, agentId).map((item) => make("artifact", item, `${item.kind || ""}\n${item.path || ""}`, item.path || item.kind || "artifact")),
      ...this.filterByAgent(data.attachmentExtracts, agentId).map((item) => make("attachment", item, `${item.title || ""}\n${item.text || ""}\n${(item.tags || []).join(" ")}`, item.title || "attachment")),
    ];
  }

  async hybridSearch({ query = "", limit = 12, scope = "all", agentId = "", semanticMemory = null } = {}) {
    const q = String(query || "").trim();
    if (!q) {
      return { query: q, results: [], count: 0, mode: "empty-query" };
    }
    const normalizedScope = String(scope || "all").trim();
    const allItems = this.flattenMemoryItems(agentId)
      .filter((item) => normalizedScope === "all" || item.layer === normalizedScope);
    const keywordResults = allItems
      .map((item) => ({
        ...item,
        keywordScore: scoreText(q, `${item.title}\n${item.text}`),
      }))
      .filter((item) => item.keywordScore > 0);

    let semanticResults = [];
    if (semanticMemory?.searchText) {
      // Incremental backfill: index any eligible memory not yet in the semantic
      // store so recall stays fresh as new memories arrive. Previously this only
      // fired while the index had <5 entries, so every memory added AFTER the
      // first seed was never semantically indexed (recall silently went stale).
      // backfillFromItems skips already-indexed ids and self-throttles, and the
      // call is fire-and-forget, so re-checking every search is cheap.
      if (typeof semanticMemory.backfillFromItems === "function") {
        const eligible = allItems.filter((i) => ["longTerm", "daily"].includes(i.layer));
        const hasUnindexed = eligible.some((i) => !semanticMemory.embeddings?.has?.(i.id));
        if (hasUnindexed) {
          void semanticMemory.backfillFromItems(eligible, { max: 200 }).catch?.(() => {});
        }
      }
      try {
        semanticResults = await semanticMemory.searchText(q, Math.max(limit, 12), 0.2);
      } catch {
        semanticResults = [];
      }
    }
    const semanticById = new Map(semanticResults.map((item) => [item.id, item]));
    const keywordById = new Map(keywordResults.map((item) => [item.id, item]));
    const allById = new Map(allItems.map((item) => [item.id, item]));
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Candidate set = UNION of keyword AND semantic matches. Previously `merged`
    // was built ONLY from keywordResults, so a memory that matched SEMANTICALLY
    // but shared NO literal keywords (exactly what embeddings are for) was
    // silently dropped — the "hybrid" search was really keyword-gated and the
    // semantic half only re-ranked keyword hits. Semantic-only ids are resolved
    // back to their full item via allById.
    const candidateIds = new Set([
      ...keywordResults.map((item) => item.id),
      ...semanticResults.map((item) => item.id).filter((id) => allById.has(id)),
    ]);
    const merged = [...candidateIds].map((id) => {
      const base = keywordById.get(id) || allById.get(id);
      const keywordScore = Number(keywordById.get(id)?.keywordScore || 0);
      const semanticScore = Number(semanticById.get(id)?.similarity || 0);
      // Freshness + importance nudge relevance-equal items: a high-importance
      // memory from this week should beat a low one from three months ago.
      const createdAt = new Date(base.item?.createdAt || base.item?.at || 0).getTime();
      const ageDays = createdAt > 0 ? (now - createdAt) / DAY : 365;
      const recencyBoost = ageDays <= 7 ? 0.3 : ageDays <= 30 ? 0.15 : 0;
      const importanceBoost = base.item?.importance === "high" ? 0.4 : base.item?.importance === "medium" ? 0.15 : 0;
      return {
        layer: base.layer,
        id: base.id,
        title: base.title,
        preview: truncate(base.text, 700),
        keywordScore: Number(keywordScore.toFixed(3)),
        semanticScore: Number(semanticScore.toFixed(3)),
        score: Number((keywordScore * 0.7 + semanticScore * 3 + recencyBoost + importanceBoost).toFixed(3)),
        source: base.item.sourceRef || base.item.path || base.item.sessionId || base.layer,
        item: base.item,
      };
    }).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Number(limit || 12)));

    return {
      query: q,
      scope: normalizedScope,
      mode: semanticResults.length ? "keyword+semantic" : "keyword",
      results: merged,
      count: merged.length,
      layers: {
        session: merged.filter((item) => item.layer === "session").length,
        daily: merged.filter((item) => item.layer === "daily").length,
        longTerm: merged.filter((item) => item.layer === "longTerm").length,
        research: merged.filter((item) => item.layer === "research").length,
      },
    };
  }

  compactLayeredMemory({ agentId = "main", dryRun = false, maxItems = 12 } = {}) {
    const paths = this.ensureLayeredMemoryFiles(agentId);
    const daily = fs.existsSync(paths.dailyMemoryPath) ? fs.readFileSync(paths.dailyMemoryPath, "utf8") : "";
    const candidates = [
      ...this.getNotes(agentId).slice(-Number(maxItems || 12)).map((note) => ({
        title: truncate(note.text, 80),
        text: note.text,
        sourceRef: `note:${note.id}`,
        tags: ["daily-note"],
      })),
      ...(daily.match(/Action boundary:[^\n]+[\s\S]{0,600}/g) || []).map((text, index) => ({
        title: `Action boundary ${index + 1}`,
        text,
        sourceRef: `daily:${path.basename(paths.dailyMemoryPath)}#boundary-${index + 1}`,
        tags: ["action-boundary"],
      })),
    ].slice(0, Number(maxItems || 12));

    if (dryRun) {
      return { ok: true, dryRun: true, candidates, paths };
    }

    const promoted = candidates.map((candidate) => this.promoteMemory({
      ...candidate,
      agentId,
      sourceType: "memory_compact",
      sourceId: candidate.sourceRef,
      importance: candidate.tags.includes("action-boundary") ? "high" : "medium",
    }));
    const dreamEntry = [
      `\n## Memory compaction (${new Date().toISOString()})`,
      `- Promoted: ${promoted.length}`,
      `- Daily source: ${paths.dailyMemoryPath}`,
      "",
    ].join("\n");
    fs.appendFileSync(paths.dreamsPath, dreamEntry, "utf8");
    this.syncMarkdown();
    return { ok: true, promotedCount: promoted.length, promoted, paths };
  }

  prefetchAll({ query = "", agentId = "", limit = 12 } = {}) {
    const overview = this.getOverview(agentId);
    const search = query ? this.searchAll(query, agentId) : null;
    return {
      agentId: normalizeAgentId(agentId),
      overview,
      recentConversations: this.getRecentConversations(limit, agentId),
      notes: this.getNotes(agentId).slice(-limit),
      longTermMemory: this.getLongTermMemory(limit, agentId),
      dreams: this.getDreams(Math.min(limit, 8), agentId),
      search,
      lifecycle: [
        "prefetch_all: gather memory before LLM call",
        "fenced block: inject as memory/context data, not active instructions",
        "sync_all: persist notes, conversations, research, artifacts, and promoted memory after turn",
        "queue_prefetch_all: heartbeat/dream sweep refreshes candidates for future turns",
      ],
      providerRule: "Built-in JSON + MEMORY.md provider is always present; external memory plugins should be additive and not replace core memory.",
    };
  }

  // ─── Three-Layer Memory (Mavis-Style) ──────────────────────────────

  /**
   * Get Mavis-style memory paths.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {Object} Memory paths
   */
  getMemoryPaths(scope, agentId = "main") {
    const homeDir = process.env.HOME || process.env.USERPROFILE || this.rootDir;
    const mavisDir = path.join(homeDir, ".mavis");

    return {
      user: {
        base: path.join(mavisDir, "memory"),
        memoryMd: path.join(mavisDir, "memory", "user.md"),
      },
      agent: {
        base: path.join(mavisDir, "agents", agentId, "memory"),
        memoryMd: path.join(mavisDir, "agents", agentId, "memory", "MEMORY.md"),
        topicsDir: path.join(mavisDir, "agents", agentId, "memory", "topics"),
      },
      project: {
        base: this.rootDir,
        agentsMd: path.join(this.rootDir, "AGENTS.md"),
        claudeMd: path.join(this.rootDir, "CLAUDE.md"),
      },
    }[scope];
  }

  /**
   * Ensure memory directory structure exists.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} agentId - Agent ID
   */
  ensureMemoryDir(scope, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);
    fs.mkdirSync(path.dirname(paths.memoryMd), { recursive: true });
    if (scope === "agent" && paths.topicsDir) {
      fs.mkdirSync(paths.topicsDir, { recursive: true });
    }
  }

  /**
   * Read memory content for given scope.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} topic - Optional topic file name (for agent scope)
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {string} Memory content
   */
  getMemory(scope, topic = null, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);

    if (scope === "project") {
      const agentsMd = fs.existsSync(paths.agentsMd) ? fs.readFileSync(paths.agentsMd, "utf-8") : "";
      const claudeMd = fs.existsSync(paths.claudeMd) ? fs.readFileSync(paths.claudeMd, "utf-8") : "";
      return agentsMd || claudeMd || "";
    }

    if (scope === "agent" && topic) {
      const topicPath = path.join(paths.topicsDir, `${topic}.md`);
      if (fs.existsSync(topicPath)) {
        return fs.readFileSync(topicPath, "utf-8");
      }
      return "";
    }

    if (fs.existsSync(paths.memoryMd)) {
      return fs.readFileSync(paths.memoryMd, "utf-8");
    }
    return "";
  }

  /**
   * Append memory entry to given scope.
   * @param {string} scope - 'user', 'agent', or 'project'
   * @param {string} content - Memory content to append
   * @param {string} type - Memory type: 'user', 'feedback', 'reference', 'pattern', 'gotcha', 'lesson'
   * @param {string} agentId - Agent ID for agent-scoped memory
   * @returns {Object} Append result
   */
  appendMemory(scope, content, type = "feedback", agentId = "main") {
    this.ensureMemoryDir(scope, agentId);
    const paths = this.getMemoryPaths(scope, agentId);

    const date = new Date().toISOString().split("T")[0];
    const safeContent = redactSecrets(content);
    const entry = [
      "",
      `### ${scope}_${type} (${date})`,
      `Type: ${type}`,
      "",
      safeContent,
    ].join("\n");

    fs.appendFileSync(paths.memoryMd, entry + "\n");

    return {
      scope,
      type,
      agentId,
      path: paths.memoryMd,
      size: fs.statSync(paths.memoryMd).size,
    };
  }

  /**
   * List topic files for an agent.
   * @param {string} agentId - Agent ID
   * @returns {Array} List of topics with metadata
   */
  listTopics(agentId = "main") {
    const paths = this.getMemoryPaths("agent", agentId);
    if (!fs.existsSync(paths.topicsDir)) {
      return [];
    }

    return fs.readdirSync(paths.topicsDir)
      .filter(f => f.endsWith(".md"))
      .map(f => {
        const filePath = path.join(paths.topicsDir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const descriptionMatch = content.match(/description:\s*(.+)/i);

        return {
          name: f.replace(/\.md$/, ""),
          file: f,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          description: descriptionMatch ? descriptionMatch[1].trim() : "",
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /**
   * Search memory across all layers.
   * @param {string} query - Search query
   * @param {string} scope - Optional scope filter: 'user', 'agent', 'project', or 'all'
   * @param {string} agentId - Agent ID for search
   * @returns {Object} Search results per layer
   */
  searchMemory(query, scope = "all", agentId = "main") {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return { results: [], count: 0 };

    const results = [];
    const scopesToSearch = scope === "all"
      ? ["user", "agent", "project"]
      : [scope];

    for (const s of scopesToSearch) {
      const content = this.getMemory(s, null, agentId);
      if (content) {
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(q)) {
            results.push({
              scope: s,
              agentId: s === "agent" ? agentId : null,
              line: idx + 1,
              text: line.trim(),
              preview: lines.slice(Math.max(0, idx - 2), idx + 3).join("\n"),
            });
          }
        });
      }
    }

    return {
      query: q,
      scopes: scopesToSearch,
      results,
      count: results.length,
    };
  }

  /**
   * Get memory size and check constraints.
   * @param {string} scope - 'user' or 'agent'
   * @param {string} agentId - Agent ID
   * @returns {Object} Size info and constraints status
   */
  // REPORT ONLY, NOT ENFORCED: this reports per-topic size against the
  // soft/hard limits, but no writer consults the result and nothing truncates
  // on this basis. Do not read a healthy result as "sizes are managed" — the
  // only real caps are the RETENTION_* constants applied at append time.
  getMemorySizeInfo(scope, agentId = "main") {
    const paths = this.getMemoryPaths(scope, agentId);
    const MEMORY_SOFT_LIMIT = 15 * 1024; // 15KB soft limit
    const MEMORY_HARD_LIMIT = 20 * 1024; // 20KB hard limit
    const TOPIC_SOFT_LIMIT = 30 * 1024; // 30KB per topic

    let size = 0;
    if (fs.existsSync(paths.memoryMd)) {
      size = fs.statSync(paths.memoryMd).size;
    }

    const topics = scope === "agent" ? this.listTopics(agentId) : [];
    const oversizedTopics = topics.filter(t => t.size > TOPIC_SOFT_LIMIT);

    return {
      scope,
      agentId,
      memorySize: size,
      memorySizeFormatted: `${(size / 1024).toFixed(1)} KB`,
      softLimit: MEMORY_SOFT_LIMIT,
      hardLimit: MEMORY_HARD_LIMIT,
      withinSoftLimit: size <= MEMORY_SOFT_LIMIT,
      withinHardLimit: size <= MEMORY_HARD_LIMIT,
      topicCount: topics.length,
      topicSizeLimit: TOPIC_SOFT_LIMIT,
      oversizedTopics,
      status: size > MEMORY_HARD_LIMIT ? "exceeded" :
              size > MEMORY_SOFT_LIMIT ? "warning" : "ok",
    };
  }
}
