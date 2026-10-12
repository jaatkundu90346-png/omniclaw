// OmniClaw Neo UI — chat-first professional shell.
// Sessions, slash commands, live tool activity, data panels (skills, plugins,
// agents, messaging, automations, memory, settings) and an embedded preview
// browser dock. Vanilla JS, no framework.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  sessionId: "",
  sessionLabel: "",
  agentId: "main",
  running: false,
  currentRunId: "",
  theme: localStorage.getItem("oc-theme") || "dark",
  runStats: { tasks: 0, files: 0, tools: 0 },
  // Centralized agent-workspace store: single source of truth for task
  // lifecycle, connection, models, permissions, files. All surfaces
  // (topbar, timeline, dock, composer) read from here; backend events write here.
  task: { status: "IDLE", startedAt: 0, title: "", lastUserMessage: "" },
  connection: "connecting",
  files: { changed: new Map(), created: new Set(), read: new Set() },
  lastElapsedText: "0s",
};
const TASK_LABEL = {
  IDLE: "Idle", PLANNING: "Planning", WORKING: "Working",
  WAITING_FOR_APPROVAL: "Waiting for approval", VERIFYING: "Verifying",
  COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled",
};
let elapsedTimer = null;
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function setTaskState(next, title = "") {
  state.task.status = next;
  if (next === "WORKING" || next === "PLANNING") {
    if (!state.task.startedAt) state.task.startedAt = Date.now();
  }
  if (next === "IDLE" || next === "COMPLETED" || next === "FAILED" || next === "CANCELLED") {
    // keep startedAt for final elapsed display
  }
  if (title) state.task.title = title;
  const pill = $("#task-status-pill");
  if (pill) {
    pill.dataset.state = next.toLowerCase();
    pill.textContent = TASK_LABEL[next] || next;
  }
  const hs = $("#task-header-status");
  if (hs) hs.textContent = TASK_LABEL[next] || next;
  const hh = $("#task-header");
  if (hh) hh.hidden = (next === "IDLE" && !state.task.title);
  const ht = $("#task-header-title");
  if (ht && state.task.title) ht.textContent = state.task.title.slice(0, 120);
  const hss = $("#task-header-session");
  if (hss) hss.textContent = state.sessionLabel || state.sessionId.slice(0, 8) || "";
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      if (!state.task.startedAt) return;
      const t = fmtElapsed(Date.now() - state.task.startedAt);
      state.lastElapsedText = t;
      if ($("#task-elapsed")) { $("#task-elapsed").hidden = state.task.status === "IDLE"; $("#task-elapsed").textContent = t; }
      if ($("#task-header-elapsed")) $("#task-header-elapsed").textContent = t;
    }, 1000);
  }
  // run-context strip mirrors the same source of truth
  const map = { IDLE: "idle", PLANNING: "active", WORKING: "active", WAITING_FOR_APPROVAL: "active", VERIFYING: "active", COMPLETED: "success", FAILED: "error", CANCELLED: "error" };
  try { updateRunSurface(`${TASK_LABEL[next] || next}${state.task.title ? ` · ${state.task.title.slice(0, 60)}` : ""}`, map[next] || "idle"); } catch { /* surface optional */ }
}
function setConnection(next) {
  state.connection = next;
  const dot = $("#conn-dot");
  const txt = $("#conn-text");
  const pill = $("#conn-pill");
  if (!dot || !txt) return;
  dot.dataset.state = next;
  txt.textContent = next === "connected" ? "Connected" : next === "reconnecting" ? "Reconnecting" : next === "disconnected" ? "Disconnected" : "Connecting";
  if (pill) pill.dataset.state = next;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function renderMarkdown(text) {
  const blocks = [];
  let source = String(text || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.trimEnd())}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  source = esc(source)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^#{1,4} (.+)$/gm, "<strong>$1</strong>")
    .replace(/^[-*] (.+)$/gm, "&bull; $1")
    .replace(/^(\d+)\. (.+)$/gm, "$1. $2")
    .replace(/\n/g, "<br/>");
  return source.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status}`);
  }
  return res.json();
}

function timeAgo(iso) {
  const ms = Date.now() - Date.parse(iso || 0);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Theme + layout chrome ──────────────────────────────────────────────────

function applyTheme() { document.documentElement.dataset.theme = state.theme; }
function updateRunSurface(label, mode = "idle") {
  const text = $("#run-state-text");
  const core = $("#run-core-mini");
  if (text) text.textContent = label;
  if (core) core.dataset.state = mode;
  const summary = $("#run-summary");
  if (summary) summary.textContent = mode === "idle" ? "Ready to work" : mode === "success" ? "Review ready" : mode === "error" ? "Needs attention" : label;
  $$(".run-count-detail").forEach((node) => { node.hidden = mode === "idle"; });
  for (const [key, value] of Object.entries(state.runStats)) {
    const node = $(`#run-${key === "tools" ? "tool" : key}-count`);
    if (node) node.textContent = String(value);
    const inspectorNode = $(`#inspector-${key === "tools" ? "tool" : key}-count`);
    if (inspectorNode) inspectorNode.textContent = String(value);
  }
  updateCognitiveStage(label, mode);
}
function updateCognitiveStage(label, mode = "idle") {
  const stage = $("#cognitive-stage");
  if (!stage) return;
  const phase = mode === "success" ? "verify" : mode === "active" ? "act" : "plan";
  stage.dataset.state = mode;
  stage.querySelectorAll("[data-phase]").forEach((node) => {
    node.classList.toggle("active", node.dataset.phase === phase);
  });
  const heading = $("#cognitive-state");
  const detail = $("#cognitive-detail");
  if (heading) heading.textContent = mode === "idle" ? "Ready to collaborate" : label;
  if (detail) detail.textContent = mode === "success"
    ? "Task completed — inspect the changes and verification evidence."
    : mode === "error"
      ? "The agent needs attention. Review the activity timeline for details."
      : mode === "active"
        ? "Agent is reasoning, selecting tools, and streaming work live."
        : "Plans, tools, file changes, and verification stay visible.";
}
function resetRunSurface() {
  state.runStats = { tasks: 0, files: 0, tools: 0 };
  updateRunSurface("Ready for your next task", "idle");
  $("#inspector-task") && ($("#inspector-task").textContent = "Waiting for the next instruction");
  $("#inspector-tools") && ($("#inspector-tools").textContent = "No tools running");
  $("#inspector-files") && ($("#inspector-files").textContent = "No files changed in this thread");
  setLiveContext("Ready · live workspace", "Choose Browser, Terminal, Code, or Preview");
}
function setLiveContext(label, detail = "", tab = "") {
  if ($("#live-context-state")) $("#live-context-state").textContent = label;
  if ($("#live-context-url")) $("#live-context-url").textContent = detail || "Live environment";
  if (tab && typeof openDock === "function" && dockTab !== tab) openDock(tab);
}

// ─── OmniClaw's computer ────────────────────────────────────────────────────
//
// One timeline of everything the agent did to this machine, in order, with
// enough of each event kept to RE-RENDER it later. That is the whole difference
// between "a live view you have to be watching" and "a recording you can step
// back through" — the user asked for the second one.
//
// Live mode follows the newest entry. Touching the scrubber parks on one entry
// and stops following, because auto-jumping while someone is reading is the
// fastest way to make a panel unusable.

const computer = {
  timeline: [],   // {kind, verb, target, payload} — oldest first
  cursor: -1,     // entry currently on screen
  live: true,
  step: "",       // human-readable current step, from the plan
};

const COMPUTER_PANES = { browser: "mybrowser", preview: "browser", terminal: "terminal", editor: "code" };
const COMPUTER_VERBS = { browser: "Browser", preview: "Preview", terminal: "Terminal", editor: "Editor" };

function computerRecord(kind, target, payload = {}) {
  const entry = { kind, verb: COMPUTER_VERBS[kind] || kind, target: String(target || ""), payload, at: Date.now() };
  computer.timeline.push(entry);
  // Unbounded growth would eventually make a long run's panel crawl.
  if (computer.timeline.length > 400) {
    computer.timeline.splice(0, computer.timeline.length - 400);
    if (computer.cursor >= 0) computer.cursor = Math.max(0, computer.cursor - 1);
  }
  if (computer.live) computerSeek(computer.timeline.length - 1, { keepLive: true });
  else computerRenderChrome();
  return entry;
}

// Renders one entry: the header, the right pane, and the pane's content. Kept
// separate from recording so replay and live use the SAME path — a replay that
// renders differently from the live view is a lie.
function computerSeek(index, { keepLive = false } = {}) {
  const total = computer.timeline.length;
  if (!total) return computerRenderChrome();
  const at = Math.max(0, Math.min(total - 1, index));
  computer.cursor = at;
  if (!keepLive) computer.live = at === total - 1;

  const entry = computer.timeline[at];
  setLiveContext(`OmniClaw is using ${entry.verb}`, entry.target || "—", COMPUTER_PANES[entry.kind] || "activity");

  if (entry.kind === "terminal") updateLiveTerminal(entry.payload);
  else if (entry.kind === "editor") showCodeDoc(entry.payload);
  else if (entry.kind === "preview" && entry.payload.rel) dockPreview(entry.payload.rel);
  // "browser" is the live CDP screencast: there are no frames to rewind to, so
  // replaying one only restores which page was in focus. Say so rather than
  // showing a stale frame as if it were that moment.
  else if (entry.kind === "browser" && !computer.live) {
    if ($("#mb-placeholder")) {
      $("#mb-placeholder").hidden = false;
      $("#mb-placeholder").textContent = `Replay: ${entry.target || "browser action"} — live frames sirf Live mode me aate hain.`;
    }
  }
  computerRenderChrome();
}

function computerRenderChrome() {
  const total = computer.timeline.length;
  const at = computer.cursor;
  const shown = total ? at + 1 : 0;
  if ($("#timeline-count")) $("#timeline-count").textContent = `${shown} / ${total}`;
  if ($("#timeline-fill")) $("#timeline-fill").style.width = total ? `${(shown / total) * 100}%` : "0%";
  if ($("#timeline-prev")) $("#timeline-prev").disabled = shown <= 1;
  if ($("#timeline-next")) $("#timeline-next").disabled = !total || at >= total - 1;

  const badge = $("#computer-live");
  if (badge) {
    badge.classList.toggle("live", computer.live);
    $("#computer-live-label").textContent = computer.live ? "Live" : "Replay";
    badge.title = computer.live
      ? "Live — panel agent ke saath chal raha hai."
      : "Replay — scrubber se peeche aa gaye ho. Live par wapas jaane ke liye click karo.";
  }
  if ($("#timeline-live-btn")) $("#timeline-live-btn").hidden = computer.live;
  if ($("#computer-step")) {
    $("#computer-step").textContent = computer.step || (total ? `${total} actions` : "no step yet");
  }
}

function computerGoLive() {
  computer.live = true;
  if (computer.timeline.length) computerSeek(computer.timeline.length - 1, { keepLive: true });
  else computerRenderChrome();
}

function computerReset() {
  computer.timeline = [];
  computer.cursor = -1;
  computer.live = true;
  computer.step = "";
  computerRenderChrome();
}

function updateLiveTerminal(payload = {}) {
  const terminal = $("#terminal-live");
  if (!terminal) return;
  const output = [payload.stdout, payload.stderr].filter(Boolean).join("\n").trim();
  const status = payload.exitCode != null ? `exit ${payload.exitCode}` : String(payload.status || "running");
  terminal.innerHTML = `<div class="terminal-live-command"><span>PS</span> ${esc(payload.command || "local command")} <b>${esc(status)}</b></div><pre>${esc(output || "Waiting for command output…")}</pre>`;
}

// ── Editor: Diff | Original | Modified ─────────────────────────────────────
// A unified diff already contains both sides, so the other two views are
// derived from it instead of re-reading the file — which also means they can
// never disagree with the change that was actually made.

let codeView = "diff";
let codeDoc = null;   // {path, diff, text, kind}

function splitDiffSides(diff) {
  const original = [];
  const modified = [];
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("#") || line.startsWith("@@")) continue;   // hunk headers
    if (line.startsWith("+")) modified.push(line.slice(1));
    else if (line.startsWith("-")) original.push(line.slice(1));
    else {
      const context = line.startsWith(" ") ? line.slice(1) : line;
      original.push(context);
      modified.push(context);
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}

function showCodeDoc(doc) {
  codeDoc = doc || null;
  // Plain reads have one side only — offering Original/Modified there would be
  // three tabs showing the same thing.
  const hasSides = Boolean(doc?.diff);
  $$("#code-view-tabs .code-view-tab").forEach((tab) => {
    const isDiff = tab.dataset.view === "diff";
    tab.disabled = !hasSides && !isDiff;
    if (!hasSides && !isDiff) tab.classList.remove("active");
  });
  if (!hasSides) codeView = "diff";
  $$("#code-view-tabs .code-view-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === codeView));
  renderCodeView();
}

function renderCodeView() {
  if (!codeDoc) return;
  const { path = "", diff = "", text = "", kind = "READ" } = codeDoc;
  if (!diff) return updateLiveCode(path, text, kind);
  if (codeView === "diff") return updateLiveCode(path, diff, "DIFF");
  const sides = splitDiffSides(diff);
  updateLiveCode(path, codeView === "original" ? sides.original : sides.modified, codeView === "original" ? "ORIGINAL" : "MODIFIED");
}

let codeRevealMode = localStorage.getItem("oc-code-reveal") || "animated";
function updateLiveCode(path, content, kind = "READ") {
  if ($("#code-live-title")) $("#code-live-title").textContent = path || "Code workspace";
  if ($("#code-live-tree")) $("#code-live-tree").innerHTML = `<span>workspace</span><span>└─ ${esc(path || "current file")}</span>`;
  const source = String(content || "No file observation available.");
  const lines = source.split("\n").map((line, index) => `<span class="code-line" style="--line-index:${index}"><i>${String(index + 1).padStart(3, "0")}</i><b>${esc(line || " ")}</b></span>`).join("");
  if ($("#code-live-output")) {
    $("#code-live-output").dataset.reveal = codeRevealMode;
    $("#code-live-output").innerHTML = `<code><span class="code-live-kind">${esc(kind)}</span>${lines}</code>`;
  }
}
function copyText(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

// ─── Files panel: real workspace state (no mocks) ──────────────────────────
// Sources, in order: live tool events this run (tool.diff/tool.read),
// repository status via GET /api/workspace/git, directory listing via
// GET /api/fs/browse. Clicking a file reads it via POST /api/tools/run
// read_file so the Editor always shows backend truth.
function trackFileEvent(payload = {}) {
  const raw = String(payload.path || payload.file || "").trim();
  if (!raw) return;
  const tool = String(payload.tool || "").toLowerCase();
  const isCreate = /create|new|write/.test(tool) || payload.created === true;
  const isRead = /read|search|list|browse/.test(tool) || payload.observation != null;
  if (isCreate && !isRead) state.files.created.add(raw);
  else if (!isRead) state.files.changed.set(raw, Date.now());
  else if (!state.files.changed.has(raw) && !state.files.created.has(raw)) state.files.read.add(raw);
  renderFilesPanel();
}
function fileRow(path) {
  const short = String(path).split(/[\\/]/).slice(-2).join("/");
  return `<button type="button" class="file-row" data-path="${esc(path)}" title="${esc(path)}"><span class="file-dot"></span><span class="file-name">${esc(short || path)}</span></button>`;
}
function gitChangeRow(change = {}) {
  const path = String(change.path || "");
  const kind = String(change.kind || "modified");
  const label = kind === "untracked" ? "U" : kind === "deleted" ? "D" : kind === "added" ? "A" : "M";
  return `<button type="button" class="git-change ${esc(kind)}" data-path="${esc(path)}" title="Open ${esc(path)}"><span class="git-change-status">${label}</span><span class="file-name">${esc(path)}</span></button>`;
}
function renderFilesPanel() {
  const groups = $("#file-groups");
  const ch = $("#files-changed");
  const cr = $("#files-created");
  const rd = $("#files-read");
  const changed = [...state.files.changed.keys()];
  const created = [...state.files.created];
  const read = [...state.files.read].slice(-8);
  const any = changed.length || created.length || read.length;
  if (groups) groups.hidden = !any;
  if (ch) ch.innerHTML = changed.length ? changed.map(fileRow).join("") : `<span class="muted small">—</span>`;
  if (cr) cr.innerHTML = created.length ? created.map(fileRow).join("") : `<span class="muted small">—</span>`;
  if (rd) rd.innerHTML = read.length ? read.map(fileRow).join("") : `<span class="muted small">—</span>`;
  const insp = $("#inspector-files");
  if (insp && !any) insp.textContent = "No files changed in this thread";
  if (insp && any) insp.textContent = `${changed.length + created.length} file(s) touched`;
  if ($("#inspector-file-count")) $("#inspector-file-count").textContent = String(changed.length + created.length);
  $$("#file-groups .file-row").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => openFileInEditor(btn.dataset.path));
  });
}
async function openFileInEditor(relPath) {
  try {
    openDock("code");
    updateLiveCode(relPath, "Loading from workspace…", "READ");
    const result = await api("/api/tools/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "read_file", input: { path: relPath, limit: 400 } }),
    });
    const text = result?.result?.content || result?.result?.text || result?.output?.content || JSON.stringify(result).slice(0, 12000);
    updateLiveCode(relPath, String(text).slice(0, 30000), "READ");
    computerRecord("editor", relPath, { path: relPath, text: String(text).slice(0, 30000), kind: "READ" });
  } catch (error) {
    updateLiveCode(relPath, `Could not read file: ${error.message}`, "READ");
  }
}
async function loadRepoPanel() {
  const gitBox = $("#inspector-git");
  const brBox = $("#inspector-branches");
  try {
    const git = await api("/api/workspace/git");
    if (gitBox) {
      gitBox.textContent = !git.isRepo ? `Not a git repo · ${git.path || ""}`
        : git.error ? `Repo · branch unknown (${String(git.error).slice(0, 80)})`
        : `Repo · ${git.current || "detached"} · ${(git.branches || []).length} branches`;
    }
    const bc = $("#inspector-git-count");
    if (bc) bc.textContent = git.isRepo ? String((git.branches || []).length) : "";
    if (brBox) {
      brBox.innerHTML = (git.branches || []).slice(0, 8).map((b) =>
        `<span class="branch-row${b.current ? " current" : ""}">${b.current ? "● " : ""}${esc(b.name)}</span>`).join("");
    }
    const changesBox = $("#inspector-changes");
    const changes = Array.isArray(git.changes) ? git.changes : [];
    if (changesBox) {
      changesBox.innerHTML = changes.length
        ? changes.slice(0, 12).map(gitChangeRow).join("")
        : `<span class="git-clean">Working tree clean</span>`;
      changesBox.querySelectorAll(".git-change").forEach((button) => {
        button.addEventListener("click", () => openFileInEditor(button.dataset.path));
      });
    }
    const pill = document.querySelector(".branch-pill");
    if (pill && git.current) pill.textContent = git.current;
  } catch (error) {
    if (gitBox) gitBox.textContent = `Git status unavailable (${String(error.message || "fetch failed").slice(0, 90)}) — retrying automatically`;
  }
}
function parseTestVerdict(text = "") {
  const s = String(text);
  const pass = [...s.matchAll(/(\d+)\s*passed/gi)].map((m) => Number(m[1]));
  const fail = [...s.matchAll(/(\d+)\s*failed/gi)].map((m) => Number(m[1]));
  const passed = pass.length ? pass[pass.length - 1] : null;
  const failed = fail.length ? fail[fail.length - 1] : null;
  if (passed == null && failed == null) return null;
  return { passed: passed ?? 0, failed: failed ?? 0 };
}
$("#theme-toggle").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("oc-theme", state.theme);
  applyTheme();
});
applyTheme();
$("#sidebar-toggle").addEventListener("click", () => $("#sidebar").classList.toggle("collapsed"));

// ─── Status: provider pill, statusbar ───────────────────────────────────────

async function loadStatus() {
  try {
    const health = await api("/api/health");
    setConnection("connected");
    const provider = health.provider || {};
    const pill = $("#provider-pill");
    pill.classList.toggle("ready", provider.ready !== false);
    pill.classList.toggle("down", provider.ready === false);
    const modelName = provider.model || provider.id || "No provider";
    $("#provider-pill-text").textContent = modelName;
    $("#composer-model").textContent = modelName;
    $("#status-model").textContent = modelName;
    if ($("#topbar-model")) $("#topbar-model").textContent = modelName;
    $("#status-version").textContent = `v${health.version || ""}`;
    $("#status-gateway").innerHTML = `<span class="status-dot ready"></span>&nbsp;Gateway ready`;
  } catch {
    setConnection("disconnected");
    $("#provider-pill-text").textContent = "Server offline";
    $("#provider-pill").classList.add("down");
    $("#status-gateway").innerHTML = `<span class="status-dot down"></span>&nbsp;Gateway offline`;
  }
  try {
    const agents = await api("/api/agents");
    $("#status-agents").textContent = `Agents ${(agents.agents || []).length}`;
  } catch { /* optional */ }
  try {
    const schedules = await api("/api/schedules");
    const active = (schedules.schedules || []).filter((item) => item.status === "active").length;
    $("#status-cron").textContent = `Cron ${active}`;
  } catch { /* optional */ }
}

async function loadAgents() {
  try {
    const data = await api("/api/agents");
    const select = $("#agent-select");
    select.innerHTML = (data.agents || [])
      .map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}</option>`)
      .join("");
    select.value = state.agentId;
  } catch { /* optional */ }
}
$("#agent-select").addEventListener("change", (event) => {
  state.agentId = event.target.value || "main";
});

// ─── Sessions ───────────────────────────────────────────────────────────────

async function loadSessions(filter = "") {
  try {
    const data = await api("/api/sessions?limit=40");
    const needle = filter.trim().toLowerCase();
    const sessions = (data.sessions || [])
      .filter((session) => session.lifecycleState !== "archived")
      .filter((session) =>
        !needle || `${session.label} ${session.lastUserMessagePreview}`.toLowerCase().includes(needle));
    $("#session-list").innerHTML = sessions.length
      ? sessions.map((session) => {
        const isRunning = state.running && session.id === state.sessionId;
        const badge = isRunning ? `<span class="sess-badge running">● working</span>`
          : session.lifecycleState && session.lifecycleState !== "active" ? `<span class="sess-badge">${esc(session.lifecycleState)}</span>` : "";
        return `
          <div class="session-row ${session.id === state.sessionId ? "active" : ""}" data-id="${esc(session.id)}" data-label="${esc(session.label)}">
            <button class="session-item" data-id="${esc(session.id)}" data-label="${esc(session.label)}">
              <span class="sess-title">${esc(session.label || "session")} ${badge}</span>
              <small>${esc(session.lastUserMessagePreview || "No messages yet")} &middot; ${timeAgo(session.updatedAt)}</small>
            </button>
            <span class="session-actions">
              <button class="session-action" data-act="rename" title="Rename">&#9998;</button>
              <button class="session-action" data-act="archive" title="Archive">&times;</button>
            </span>
          </div>`;
      }).join("")
      : `<div class="history-empty"><strong>${needle ? "No matching chats" : "No chat history yet"}</strong><small>${needle ? "Try a different search." : "Your completed tasks will appear here."}</small></div>`;
    $$(".session-item").forEach((el) =>
      el.addEventListener("click", () => openSession(el.dataset.id, el.dataset.label)));
    $$(".session-action").forEach((el) =>
      el.addEventListener("click", async (event) => {
        event.stopPropagation();
        const row = el.closest(".session-row");
        const sessionId = row?.dataset.id;
        if (!sessionId) return;
        if (el.dataset.act === "rename") {
          const next = prompt("Naya naam:", row.dataset.label || "");
          if (!next || !next.trim()) return;
          try {
            await api("/api/sessions/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, label: next.trim() }),
            });
            if (sessionId === state.sessionId) {
              state.sessionLabel = next.trim();
              $("#main-title-text").textContent = state.sessionLabel;
            }
          } catch { /* list reload below shows truth */ }
        }
        if (el.dataset.act === "archive") {
          if (!confirm("Session archive karna hai?")) return;
          try {
            await api("/api/sessions/reset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, reason: "archived-from-ui" }),
            });
            if (sessionId === state.sessionId) $("#new-chat").click();
          } catch { /* list reload below shows truth */ }
        }
        loadSessions($("#sidebar-search").value);
      }));
  } catch (error) {
    const list = $("#session-list");
    if (list) {
      list.innerHTML = `<button class="history-retry" type="button"><strong>Chat history unavailable</strong><small>Retry connection</small></button>`;
      list.querySelector(".history-retry")?.addEventListener("click", () => loadSessions($("#sidebar-search").value));
    }
  }
}
$("#sidebar-search").addEventListener("input", (event) => loadSessions(event.target.value));

async function openSession(sessionId, label) {
  switchView("chat");
  state.sessionId = sessionId;
  state.sessionLabel = label || "session";
  $("#main-title-text").textContent = state.sessionLabel;
  $("#chat-hero").style.display = "none";
  const thread = $("#thread");
  thread.innerHTML = `<p class="muted small">Loading conversation</p>`;
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const session = detail.session || detail;
    thread.innerHTML = "";
    for (const entry of session.transcript || []) {
      if (entry.type !== "message") continue;
      if (entry.role === "user") appendUser(entry.text);
      else if (entry.role === "assistant") appendAssistant(entry.text, entry.finalMetadata);
    }
    if (!thread.children.length) thread.innerHTML = `<p class="muted small">Empty session — say something.</p>`;
    scrollToBottom(true);
  } catch (error) {
    thread.innerHTML = `<p class="muted small">Could not load session: ${esc(error.message)}</p>`;
  }
  loadSessions($("#sidebar-search").value);
}

$("#new-chat").addEventListener("click", () => {
  resetRunSurface();
  state.sessionId = "";
  state.sessionLabel = `chat-${new Date().toISOString().slice(5, 16).replace(/[T:]/g, "-")}`;
  $("#main-title-text").textContent = "New session";
  $("#thread").innerHTML = "";
  $("#chat-hero").style.display = "";
  switchView("chat");
  $("#composer-input").focus();
});

// ─── Thread rendering ───────────────────────────────────────────────────────

function scrollToBottom(force = false) {
  const scroller = $("#chat-scroll");
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  if (force || nearBottom) scroller.scrollTop = scroller.scrollHeight;
}

function appendUser(text, attachments = []) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  const thumbs = attachments.length
    ? `<div class="bubble-attachments">${attachments.map((att) => att.isImage
        ? `<a href="/preview/${esc(att.relPath)}" target="_blank" rel="noopener"><img class="bubble-thumb" src="/preview/${esc(att.relPath)}" alt="${esc(att.name)}" /></a>`
        : `<span class="bubble-file">&#128196; ${esc(att.name)}</span>`).join("")}</div>`
    : "";
  el.innerHTML = `${thumbs}<div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  $("#thread").appendChild(el);
  scrollToBottom(true);
}

function appendAssistant(text, meta) {
  const el = document.createElement("div");
  el.className = "msg msg-assistant";
  const metaLine = meta
    ? `<div class="msg-meta">${esc(meta.model || "")}${meta.stepCount ? ` &middot; ${meta.stepCount} rounds` : ""}${meta.toolCallCount ? ` &middot; ${meta.toolCallCount} tools` : ""}${meta.totalTokens ? ` &middot; ${meta.totalTokens >= 1000 ? `${(meta.totalTokens / 1000).toFixed(1)}k` : meta.totalTokens} tok` : ""}${meta.durationMs ? ` &middot; ${(meta.durationMs / 1000).toFixed(1)}s` : ""}</div>`
    : "";
  el.innerHTML = `<div class="bubble">${renderMarkdown(text)}</div>${metaLine}`;
  $("#thread").appendChild(el);
  scrollToBottom();
}

function appendToolStrip() {
  const el = document.createElement("div");
  el.className = "tool-strip";
  $("#thread").appendChild(el);
  return el;
}

function appendThinking(text = "Working") {
  const el = document.createElement("div");
  el.className = "thinking-line";
  el.innerHTML = `<span class="spinner"></span><span class="t-text"></span><span class="t-context" hidden></span>`;
  el.querySelector(".t-text").textContent = text;
  $("#thread").appendChild(el);
  scrollToBottom();
  return el;
}

function toolChip(strip, tool, detail) {
  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.innerHTML = `<span class="t-status"></span><strong>${esc(tool)}</strong><span class="t-detail"></span>`;
  chip.querySelector(".t-detail").textContent = detail || "";
  strip.appendChild(chip);
  scrollToBottom();
  return chip;
}

function activityRow(eventName, detail) {
  const feed = $("#activity-feed");
  const row = document.createElement("div");
  row.className = "activity-row";
  row.innerHTML = `<span class="a-event">${esc(eventName)}</span><span class="a-detail"></span>`;
  row.querySelector(".a-detail").textContent = detail || "";
  feed.appendChild(row);
  while (feed.children.length > 200) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

// ─── Send message over SSE ──────────────────────────────────────────────────

function expandSlash(raw) {
  const trimmed = String(raw || "").trim();
  const sp = trimmed.indexOf(" ");
  const cmd = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
  if (SLASH_TEMPLATES[cmd] && rest) return SLASH_TEMPLATES[cmd](rest);
  return trimmed;
}
async function sendMessage(text) {
  let message = expandSlash(text);
  const attachments = pendingAttachments.splice(0, pendingAttachments.length);
  renderAttachTray();
  if (attachments.length && !message) message = "Attached file(s) dekho aur batao kya hai / kya karna hai.";
  if (!message || state.running) return;
  // Hand the agent concrete paths — the harness serves these from the project
  // root, so read_file/image tools can open them directly.
  const attachmentNote = attachments.length
    ? `\n\n[Attached by user — files saved in the project root:${attachments.map((att) => `\n- ${att.relPath}${att.isImage ? " (image — analyze/view it)" : ""}`).join("")}]`
    : "";
  const outgoing = message + attachmentNote;
  state.running = true;
  state.runStats = { tasks: 1, files: 0, tools: 0 };
  state.task.startedAt = Date.now();
  state.task.lastUserMessage = message;
  state.files.changed.clear(); state.files.created.clear(); state.files.read.clear();
  try { renderFilesPanel(); } catch { /* panel optional */ }
  setTaskState("PLANNING", message.slice(0, 120));
  updateRunSurface("Executing request", "active");
  if ($("#inspector-task")) $("#inspector-task").textContent = message.slice(0, 120);
  if ($("#inspector-tools")) $("#inspector-tools").textContent = "Preparing agent tools…";
  $("#send-btn").disabled = true;
  $("#stop-btn").hidden = false;
  $("#chat-hero").style.display = "none";
  if (!state.sessionLabel) {
    state.sessionLabel = `chat-${new Date().toISOString().slice(5, 16).replace(/[T:]/g, "-")}`;
    $("#main-title-text").textContent = state.sessionLabel;
  }

  appendUser(message, attachments);
  const thinking = appendThinking("OmniClaw is working");
  const strip = appendToolStrip();
  // Pending chips per tool id (a tool can run multiple times in parallel).
  const chips = new Map();
  const chipStarted = (tool, detail) => {
    if (!chips.has(tool)) chips.set(tool, []);
    chips.get(tool).push(toolChip(strip, tool, detail));
  };
  const chipFinished = (tool) => {
    const pending = chips.get(tool) || [];
    return pending.shift() || toolChip(strip, tool, "");
  };
  state.currentRunId = "";

  // Live token-streaming bubble: filled by assistant.delta events. On each new
  // model round the previous round's narration is frozen in place (so the
  // "now I'll do X" line stays above its tool cards) and a fresh bubble starts.
  let streamBubble = null;
  let streamText = "";
  let uiRound = -1; // shared round tracker for assistant.delta + assistant.reasoning
  const ensureStreamBubble = () => {
    if (!streamBubble) {
      streamBubble = document.createElement("div");
      streamBubble.className = "msg msg-assistant streaming";
      streamBubble.innerHTML = `<div class="bubble"></div>`;
      $("#thread").appendChild(streamBubble);
    }
    return streamBubble;
  };
  // rAF-throttled painter for the live stream bubble (plain text while
  // streaming; markdown is rendered once on freeze/final).
  let streamRenderQueued = false;
  const paintStreamBubble = () => {
    streamRenderQueued = false;
    if (!streamBubble) return;
    streamBubble.querySelector(".bubble").textContent = streamText;
  };
  // Live "thinking" bubble: filled by assistant.reasoning events (reasoning
  // models stream their chain-of-thought separately from the answer). Shown
  // dimmer/collapsible above the answer, cleared when the final answer renders.
  let thinkBubble = null;
  let thinkText = "";
  const ensureThinkBubble = () => {
    if (!thinkBubble) {
      thinkBubble = document.createElement("div");
      thinkBubble.className = "msg msg-assistant thinking-msg";
      thinkBubble.innerHTML = `<div class="think-bubble"><div class="think-head">Thinking</div><div class="think-body"></div></div>`;
      $("#thread").appendChild(thinkBubble);
    }
    return thinkBubble;
  };
  const dropThinkBubble = () => {
    if (thinkBubble) { thinkBubble.remove(); thinkBubble = null; }
    thinkText = "";
  };
  const dropStreamBubble = () => {
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    streamText = "";
    dropThinkBubble();
  };
  // When the loop moves to a new round, freeze the prior round's narration +
  // thinking in the transcript (keep non-empty ones, drop empty ones) so the
  // history reads think -> "now I'll do X" -> [tool cards] -> next round, like
  // Claude Code. The first event of a new round triggers this.
  const advanceRound = (round) => {
    if (round == null || round === uiRound) return;
    if (uiRound !== -1) {
      if (streamBubble && streamText.trim()) { streamBubble.classList.remove("streaming"); streamBubble.querySelector(".bubble").innerHTML = renderMarkdown(streamText); streamBubble = null; }
      else if (streamBubble) { streamBubble.remove(); streamBubble = null; }
      if (thinkBubble && thinkText.trim()) { thinkBubble.classList.add("collapsed"); thinkBubble = null; }
      else if (thinkBubble) { thinkBubble.remove(); thinkBubble = null; }
    }
    streamText = "";
    thinkText = "";
    uiRound = round;
  };

  // Diff card for edit/multi_edit — red/green lines, collapsible.
  const renderDiffCard = (payload) => {
    computerRecord("editor", payload.path || "changed file", {
      path: payload.path || "changed file",
      diff: payload.diff || "",
      kind: "DIFF",
    });
    const card = document.createElement("div");
    card.className = "diff-card";
    const body = String(payload.diff || "").split("\n").map((line) => {
      const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("#") ? "hunk" : "ctx";
      return `<div class="diff-line ${cls}">${esc(line)}</div>`;
    }).join("");
    card.innerHTML = `<div class="diff-head"><span class="diff-tool">${esc(payload.tool || "edit")}</span> <span class="diff-path">${esc(payload.path || "")}</span></div><div class="diff-body">${body}</div>`;
    $("#thread").appendChild(card);
    scrollToBottom();
  };

  // Terminal-output card for exec/run_terminal_command — command + stdout/stderr
  // in a monospace block with an exit-code badge, so shell work is visible.
  // Parses pass/fail counts from the real output for a TEST/VERIFICATION strip.
  const renderExecCard = (payload) => {
    computerRecord("terminal", payload.command || "local command", payload);
    const card = document.createElement("div");
    const failed = (payload.status && payload.status !== "completed") || (payload.exitCode != null && payload.exitCode !== 0);
    card.className = "exec-card" + (failed ? " fail" : "");
    const out = String(payload.stdout || "");
    const err = String(payload.stderr || "");
    const bodyText = [out, err].filter((s) => s.trim()).join("\n").trim() || "(no output)";
    const badge = payload.exitCode != null ? `exit ${payload.exitCode}` : (payload.status || "");
    const verdict = parseTestVerdict(`${out}\n${err}`);
    const verdictHtml = verdict ? `<span class="exec-verdict ${verdict.failed ? "fail" : "ok"}">${verdict.failed ? `✗ ${verdict.failed} failed · ✓ ${verdict.passed} passed` : `✓ ${verdict.passed} passed`}</span>` : "";
    const kind = /test|verify|check/i.test(String(payload.command || "")) ? "TEST" : "TOOL";
    card.innerHTML = `<div class="exec-head"><span class="exec-kind">${kind}</span><span class="exec-prompt">$</span><span class="exec-cmd">${esc(payload.command || "")}</span><span class="exec-exit">${esc(badge)}</span>${verdictHtml}</div><div class="exec-body">${esc(bodyText.slice(0, 8000))}</div>`;
    $("#thread").appendChild(card);
    scrollToBottom();
  };

  // Read-observation card — the EXACT text the model received from
  // read_file/search_text, so the user can verify the agent truly sees the
  // code. Collapsed by default (header click to expand).
  const renderReadCard = (payload) => {
    setLiveContext("Using Code", payload.path || "Reading project file", "code");
    updateLiveCode(payload.path || "current file", payload.observation || "", "READ");
    const card = document.createElement("div");
    card.className = "read-card collapsed";
    const meta = payload.lines ? ` <span class="read-lines">${esc(payload.lines)}</span>` : "";
    card.innerHTML = `<div class="read-head">&#128196; <span class="read-tool">${esc(payload.tool || "read_file")}</span> <span class="read-path">${esc(payload.path || "")}</span>${meta}<span class="read-toggle">show</span></div><div class="read-body">${esc(String(payload.observation || ""))}</div>`;
    card.querySelector(".read-head").addEventListener("click", () => {
      card.classList.toggle("collapsed");
      card.querySelector(".read-toggle").textContent = card.classList.contains("collapsed") ? "show" : "hide";
    });
    $("#thread").appendChild(card);
    scrollToBottom();
  };

  // Inline browser screenshot — shows the actual image the agent captured, so
  // the user SEES what the agent saw (served via /preview/<relPath>).
  const renderScreenshotCard = (payload) => {
    const rel = String(payload.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) return;
    const src = `/preview/${rel.split("/").map(encodeURIComponent).join("/")}?t=${Date.now()}`;
    setLiveContext("Live Preview", payload.url || rel, "browser");
    dockPreview(rel);
    const card = document.createElement("div");
    card.className = "shot-card";
    const sub = payload.url ? ` &middot; ${esc(String(payload.url).slice(0, 90))}` : "";
    card.innerHTML = `<div class="shot-head">&#128247; ${esc(payload.tool || "screenshot")}${sub}</div><a href="${src}" target="_blank" rel="noopener"><img class="shot-img" src="${src}" alt="agent screenshot" loading="lazy"></a>`;
    $("#thread").appendChild(card);
    scrollToBottom();
  };

  // Live plan checklist card, updated by plan.updated events.
  let planCard = null;
  const renderPlanCard = (payload) => {
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    if (!steps.length) return;
    if (!planCard) {
      planCard = document.createElement("div");
      planCard.className = "plan-card";
    }
    planCard.innerHTML = `<div class="plan-head">Plan &middot; ${payload.completed ?? 0}/${payload.total ?? steps.length} done</div>` +
      steps.map((step) => {
        const mark = step.status === "completed" ? "&#10003;" : step.status === "in_progress" ? "&#8594;" : step.status === "skipped" ? "&ndash;" : "&#9675;";
        return `<div class="plan-step ${esc(step.status)}"><span class="plan-mark">${mark}</span>${esc(step.title)}</div>`;
      }).join("");
    $("#thread").appendChild(planCard);
    scrollToBottom();
  };

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: outgoing,
        sessionId: state.sessionId || undefined,
        label: state.sessionLabel,
        agentId: state.agentId,
      }),
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalShown = false;

    const handlePacket = (packet) => {
      if (packet.type === "event") {
        const record = packet.record || {};
        const payload = record.payload || {};
        const eventName = record.event || "";
        if (!state.currentRunId && payload.runId) {
          state.currentRunId = payload.runId;
        }
        if (eventName === "assistant.reasoning") {
          advanceRound(payload.round);
          thinkText += payload.text || "";
          ensureThinkBubble().querySelector(".think-body").textContent = thinkText;
          scrollToBottom();
          return;
        }
        if (eventName === "assistant.delta") {
          advanceRound(payload.round);
          // Once the answer starts, fold the thinking block shut so it doesn't
          // dominate — the model has moved from reasoning to responding.
          if (thinkBubble) thinkBubble.classList.add("collapsed");
          streamText += payload.text || "";
          // PERF: paint plain text at most once per frame while streaming —
          // re-running full markdown on every token is O(n^2) and made long
          // answers feel laggy. Final markdown render happens once, either
          // when the round freezes (advanceRound) or on the "final" packet.
          if (!streamRenderQueued) {
            streamRenderQueued = true;
            requestAnimationFrame(paintStreamBubble);
          }
          scrollToBottom();
          return;
        }
        if (eventName === "plan.updated") {
          setTaskState("PLANNING");
          renderPlanCard(payload);
        }
        if (eventName === "tool.diff" && payload.diff) {
          setTaskState("WORKING");
          try { trackFileEvent(payload); } catch { /* panel optional */ }
          renderDiffCard(payload);
        }
        if (eventName === "tool.exec") {
          const cmd = String(payload.command || "");
          if (/test|verify|check|build|lint/i.test(cmd)) setTaskState("VERIFYING");
          else setTaskState("WORKING");
          renderExecCard(payload);
        }
        if (eventName === "tool.read" && payload.observation) {
          setTaskState("WORKING");
          try { trackFileEvent({ ...payload, tool: payload.tool || "read_file" }); } catch { /* panel optional */ }
          renderReadCard(payload);
        }
        if (eventName === "tool.screenshot" && payload.path) {
          renderScreenshotCard(payload);
        }
        // Mid-run interactivity: agent question card + command approval card.
        if (eventName === "run.question" && payload.questionId) {
          setTaskState("WAITING_FOR_APPROVAL");
          renderQuestionCard(payload);
        }
        if (eventName === "run.question_timeout" && payload.questionId) {
          setTaskState("WORKING");
          markQuestionClosed(payload.questionId, "Time out — agent recommended option ke saath aage badh gaya");
        }
        if (eventName === "approval.requested" && payload.approvalId) {
          setTaskState("WAITING_FOR_APPROVAL");
          renderApprovalCard(payload);
        }
        if (eventName === "approval.resolved" && payload.approvalId) {
          setTaskState("WORKING");
          markApprovalResolved(payload);
        }
        activityRow(eventName, payload.tool || payload.message || payload.stoppedReason || "");
        if (eventName === "agent.thinking") {
          thinking.querySelector(".t-text").textContent = payload.message || "Working";
        }
        if (eventName === "model.waiting") {
          // Liveness heartbeat from the loop while the model call is in flight —
          // shows elapsed seconds so a slow provider reads as "waiting", not frozen.
          const secs = Math.max(1, Math.round((payload.waitMs || 0) / 1000));
          thinking.querySelector(".t-text").textContent = payload.gotFirstToken
            ? `Streaming… ${secs}s`
            : `Model connect ho raha hai… ${secs}s`;
        }
        if (eventName === "context.usage" && Number.isFinite(payload.percentFull)) {
          // Live context meter — shows how full the model's window is, and warns
          // (amber/red) as it nears the auto-compaction threshold.
          const meter = thinking.querySelector(".t-context");
          if (meter) {
            meter.hidden = false;
            meter.textContent = `· context ${payload.percentFull}%`;
            meter.classList.toggle("warn", payload.percentFull >= 70 && payload.percentFull < 85);
            meter.classList.toggle("hot", payload.percentFull >= 85);
          }
        }
        if (eventName === "tool.started" || eventName === "model_tool_loop.tool_started") {
          state.runStats.tools += 1;
          if (payload.path || payload.file) state.runStats.files += 1;
          if (state.task.status === "PLANNING" || state.task.status === "IDLE") setTaskState("WORKING");
          updateRunSurface(`Working · ${payload.tool || "tool"}`, "active");
          if ($("#inspector-tools")) $("#inspector-tools").textContent = `${payload.tool || "Tool"} running`;
          if ($("#inspector-files") && (payload.path || payload.file)) $("#inspector-files").textContent = String(payload.path || payload.file);
          chipStarted(payload.tool || "tool", payload.reason || "");
        }
        if (["tool.completed", "tool.failed", "model_tool_loop.tool_completed"].includes(eventName)) {
          const chip = chipFinished(payload.tool || "tool");
          chip.classList.add(eventName === "tool.failed" || payload.error || payload.blocked ? "fail" : "done");
          const detail = payload.outputSummary || payload.path || payload.command || payload.url || "";
          if (detail) chip.querySelector(".t-detail").textContent = String(detail).slice(0, 110);
        }
        if (eventName === "tool.output" && payload.tool) {
          const pending = chips.get(payload.tool) || [];
          const chip = pending[0];
          if (chip && payload.outputSummary) chip.querySelector(".t-detail").textContent = String(payload.outputSummary).slice(0, 110);
        }
      }
      if (packet.type === "final" && !finalShown) {
        finalShown = true;
        thinking.remove();
        dropStreamBubble();
        appendAssistant(packet.content || "(empty reply)", packet.metadata);
        setTaskState("COMPLETED");
        updateRunSurface("Completed · review ready", "success");
        if ($("#inspector-tools")) $("#inspector-tools").textContent = "No tools running";
        try { loadRepoPanel(); } catch { /* optional */ }
        maybeAutoPreview(packet.data);
      }
      if (packet.type === "done") {
        state.sessionId = packet.sessionId || state.sessionId;
        state.currentRunId = "";
        loadSessions($("#sidebar-search").value);
      }
      if (packet.type === "error") {
        thinking.remove();
        dropStreamBubble();
        appendAssistant(`Run failed: ${packet.error || "unknown error"}`);
        setTaskState("FAILED");
        updateRunSurface("Run failed · inspect activity", "error");
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try { handlePacket(JSON.parse(line.slice(5))); } catch { /* keep stream alive */ }
      }
    }
    if (!finalShown) {
      thinking.remove();
      dropStreamBubble();
      appendAssistant("Run finished but no final answer arrived. Activity panel me details hain.");
      updateRunSurface("Finished · activity needs review", "error");
    }
  } catch (error) {
    thinking.remove();
    dropStreamBubble();
    appendAssistant(`Connection dropped: ${esc(error.message)}. Run server par chal raha ho sakta hai — sidebar se session reopen karo.`);
  } finally {
    if (!strip.children.length) strip.remove();
    state.running = false;
    state.currentRunId = "";
    $("#send-btn").disabled = false;
    $("#stop-btn").hidden = true;
    $("#stop-btn").disabled = false;
  }
}

$("#stop-btn").addEventListener("click", async () => {
  const btn = $("#stop-btn");
  if (!state.currentRunId) {
    btn.title = "Run abhi register nahi hua — ek second me phir try karo.";
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(state.currentRunId)}/stop`, { method: "POST" });
    setTaskState("CANCELLED");
    activityRow("run.cancel_requested", state.currentRunId);
  } catch (error) {
    activityRow("run.cancel_failed", error.message);
    btn.disabled = false;
  }
});

// Retry / Continue call the same real agent runtime — never a local echo.
$("#retry-btn")?.addEventListener("click", () => {
  if (state.running || !state.task.lastUserMessage) return;
  sendMessage(state.task.lastUserMessage);
});
$("#continue-btn")?.addEventListener("click", () => {
  if (state.running) return;
  sendMessage("Continue the task from where you left off. Verify pending work and finish it.");
});

// ─── Composer chips: access mode + model picker (Codex-style) ────────────────

const ACCESS_MODES = {
  full: {
    label: "Full Access", dot: "ok",
    desc: "Agent khud decide karega — sab tools, koi rukawat nahi",
    config: { tools: { permissions: { allowFileWrite: true, allowShellExecution: true, allowComputerAccess: true, allowConnectorWrite: true, allowBrowserControl: true }, shellExecution: { approvalMode: "auto" } } },
  },
  approvals: {
    label: "Approvals", dot: "warn",
    desc: "Har shell command se pehle Allow / Deny card aayega",
    config: { tools: { permissions: { allowFileWrite: true, allowShellExecution: true, allowComputerAccess: true, allowConnectorWrite: true, allowBrowserControl: true }, shellExecution: { approvalMode: "always" } } },
  },
  readonly: {
    label: "Read-only", dot: "info",
    desc: "Sirf padhna, research, plan — file write + shell OFF",
    config: { tools: { permissions: { allowFileWrite: false, allowShellExecution: false, allowComputerAccess: false }, shellExecution: { approvalMode: "auto" } } },
  },
};

function detectAccessMode(config) {
  const perms = config?.tools?.permissions || {};
  const approvalMode = String(config?.tools?.shellExecution?.approvalMode || "auto");
  if (perms.allowShellExecution === false && perms.allowFileWrite === false) return "readonly";
  if (approvalMode === "always") return "approvals";
  return "full";
}

function setModeChip(modeKey) {
  const mode = ACCESS_MODES[modeKey] || ACCESS_MODES.full;
  $("#chip-mode-text").textContent = mode.label;
  const dot = $("#chip-mode-dot");
  dot.className = `chip-dot ${mode.dot}`;
  if ($("#topbar-perm")) $("#topbar-perm").textContent = mode.label;
  if ($("#inspector-permission")) $("#inspector-permission").textContent = mode.label;
}

function closeChipMenus() {
  $$(".chip-menu").forEach((el) => el.remove());
}
document.addEventListener("click", (event) => {
  if (!event.target.closest(".chip") && !event.target.closest(".chip-menu")) closeChipMenus();
});

function openChipMenu(anchor, items, footer = null) {
  closeChipMenus();
  const menu = document.createElement("div");
  menu.className = "chip-menu";
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `chip-menu-item${item.active ? " active" : ""}`;
    row.innerHTML =
      `<span class="cmi-main">${esc(item.label)}${item.badge ? ` <span class="cmi-badge">${esc(item.badge)}</span>` : ""}${item.active ? ' <span class="cmi-check">&#10003;</span>' : ""}</span>` +
      (item.desc ? `<span class="cmi-desc">${esc(item.desc)}</span>` : "");
    row.addEventListener("click", async () => {
      closeChipMenus();
      try { await item.onPick?.(); } catch (error) { activityRow("chip.error", error.message); }
    });
    menu.appendChild(row);
  }
  if (footer) menu.appendChild(footer);
  const wrap = anchor.closest(".composer-wrap");
  wrap.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left - wrapRect.left)}px`;
  menu.style.bottom = `${wrapRect.height - (rect.top - wrapRect.top) + 8}px`;
}

async function applyAccessMode(modeKey) {
  const mode = ACCESS_MODES[modeKey];
  if (!mode) return;
  await api("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode.config),
  });
  setModeChip(modeKey);
  activityRow("mode.applied", `${mode.label} — ${mode.desc}`);
}

// GET /api/config wraps the real config under .config — unwrap once here.
async function fetchConfig() {
  const data = await api("/api/config");
  return data.config || data;
}

$("#chip-mode").addEventListener("click", async (event) => {
  event.stopPropagation();
  if (document.querySelector(".chip-menu")) { closeChipMenus(); return; }
  let current = "full";
  try { current = detectAccessMode(await fetchConfig()); } catch { /* default */ }
  openChipMenu($("#chip-mode"), Object.entries(ACCESS_MODES).map(([key, mode]) => ({
    label: mode.label,
    desc: mode.desc,
    badge: key === "full" ? "Recommended" : "",
    active: key === current,
    onPick: () => applyAccessMode(key),
  })));
});

$("#chip-model").addEventListener("click", async (event) => {
  event.stopPropagation();
  if (document.querySelector(".chip-menu")) { closeChipMenus(); return; }
  let config = {};
  try { config = await fetchConfig(); } catch { /* offline */ }
  const profiles = config.providerProfiles || {};
  const currentModel = config.provider?.model || "";

  // Live models straight from the provider's /models endpoint. Falls back to
  // saved profiles below when there's no key yet or the provider is offline.
  let live = { ok: false, models: [] };
  try { live = await api("/api/models"); } catch { /* no key yet */ }

  const groupOf = (id = "") => {
    const s = String(id).toLowerCase();
    if (/local|ollama|llama\.cpp|lmstudio/.test(s)) return "LOCAL";
    if (/flash|haiku|mini|fast|3\.8|4o-mini/.test(s)) return "FAST";
    if (/thinking|reason|opus|pro|o1|o3|r1/.test(s)) return "REASONING";
    return "PREMIUM";
  };
  const items = (live.ok ? live.models : []).slice(0, 60).map((model) => {
    const id = typeof model === "string" ? model : model.id;
    const name = typeof model === "string" ? model : (model.name || model.id);
    return {
      label: name,
      desc: "live",
      badge: groupOf(id),
      active: Boolean(id && id === currentModel),
      onPick: async () => {
        await api("/api/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: { model: id } }),
        });
        activityRow("model.applied", id);
        loadStatus();
      },
    };
  });

  items.push(...Object.entries(profiles).map(([profileId, profile]) => ({
    label: profileId,
    desc: profile.model || profile.baseUrl || "",
    active: Boolean(profile.model && profile.model === currentModel),
    onPick: async () => {
      await api("/api/provider/profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      activityRow("model.applied", `${profileId} — ${profile.model || ""}`);
      loadStatus();
    },
  })));
  if (!items.length) {
    // Nothing live and nothing saved — most likely means no API key yet.
    const hint = live.ok
      ? "Provider ne koi model nahi diya"
      : `API key set karo, phir live models yahan aayenge${live.error ? ` (${live.error})` : ""}`;
    items.push({ label: "Koi model nahi mila", desc: hint, onPick: () => {} });
  }
  // Custom model id row — type and Enter to set on the ACTIVE provider.
  const footer = document.createElement("div");
  footer.className = "chip-menu-footer";
  footer.innerHTML = `<input type="text" placeholder="Custom model id — Enter to apply" value="${esc(currentModel)}" spellcheck="false" />`;
  const input = footer.querySelector("input");
  input.addEventListener("keydown", async (keyEvent) => {
    if (keyEvent.key !== "Enter") return;
    const model = input.value.trim();
    if (!model) return;
    closeChipMenus();
    await api("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { model } }),
    });
    activityRow("model.applied", model);
    loadStatus();
  });
  input.addEventListener("click", (clickEvent) => clickEvent.stopPropagation());
  openChipMenu($("#chip-model"), items, footer);
});

// ─── Workspace picker ───────────────────────────────────────────────────────
// OmniClaw used to be stuck inside its own install folder. This lets the user
// point the agent at any project folder; the choice survives restarts because
// the server persists it in data/workspaces.json.

const workspaceState = {
  selection: null,
  browsePath: "",
  selectedCandidate: "",
  branches: null,
};

function currentWorkspacePath() {
  return workspaceState.selection?.activePath || "";
}

async function loadWorkspace() {
  try {
    const data = await api("/api/workspace");
    workspaceState.selection = data.selection || null;
  } catch {
    workspaceState.selection = null;
  }
  const selection = workspaceState.selection;
  const label = selection?.activeName || "workspace";
  const chip = $("#composer-workspace");
  if (chip) chip.textContent = label;
  const chipBtn = $("#chip-workspace");
  if (chipBtn) {
    chipBtn.title = selection?.activePath
      ? `Workspace: ${selection.activePath}`
      : "Workspace folder — click to switch project";
    chipBtn.classList.toggle("is-default", Boolean(selection?.isDefault));
  }
  loadBranches();
}

async function loadBranches() {
  const chipBtn = $("#chip-workspace");
  try {
    const git = await api("/api/workspace/git");
    workspaceState.branches = git;
    const current = git?.current ? ` · ${git.current}` : "";
    const count = (git?.branches || []).length;
    if (chipBtn) {
      chipBtn.title = `${currentWorkspacePath() || "No workspace"}${current}${count ? ` · ${count} branches` : ""}`;
    }
  } catch {
    workspaceState.branches = null;
  }
}

function openWorkspacePicker() {
  const backdrop = $("#ws-backdrop");
  if (!backdrop) return;
  backdrop.hidden = false;
  $("#ws-error").textContent = "";
  $("#ws-current-path").textContent = currentWorkspacePath() || "—";
  workspaceState.selectedCandidate = currentWorkspacePath();
  renderRecents();
  browseTo(currentWorkspacePath(), { syncInput: true });
}

function closeWorkspacePicker() {
  const backdrop = $("#ws-backdrop");
  if (backdrop) backdrop.hidden = true;
}

function renderRecents() {
  const host = $("#ws-recents");
  if (!host) return;
  const recents = workspaceState.selection?.recents || [];
  host.innerHTML = "";
  for (const entry of recents) {
    const button = document.createElement("button");
    button.className = `ws-recent${entry.path === currentWorkspacePath() ? " active" : ""}${entry.exists ? "" : " missing"}`;
    button.type = "button";
    button.title = entry.path;
    button.innerHTML = `<span class="ws-name">${esc(entry.name)}</span><span class="ws-folder">${esc(entry.path)}</span>`;
    button.addEventListener("click", () => {
      workspaceState.selectedCandidate = entry.path;
      browseTo(entry.path, { syncInput: true });
    });
    host.appendChild(button);
  }
}

async function browseTo(targetPath, { syncInput = false } = {}) {
  const list = $("#ws-list");
  const error = $("#ws-error");
  if (!list) return;
  error.textContent = "";
  const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
  let data;
  try {
    data = await api(`/api/fs/browse${query}`);
  } catch (requestError) {
    error.textContent = requestError.message || "Folder nahi khul saka";
    return;
  }
  workspaceState.browsePath = data.path;
  workspaceState.selectedCandidate = data.path;
  if (syncInput) $("#ws-path-input").value = data.path;

  list.innerHTML = "";
  if (!data.directories?.length) {
    const empty = document.createElement("div");
    empty.className = "ws-empty";
    empty.textContent = "Yahan koi folder nahi";
    list.appendChild(empty);
    return;
  }
  for (const entry of data.directories) {
    const row = document.createElement("div");
    row.className = "ws-item";
    row.innerHTML = `<span class="ws-folder">${esc(entry.name)}</span>`;
    row.addEventListener("click", () => {
      $$(".ws-item").forEach((node) => node.classList.remove("selected"));
      row.classList.add("selected");
      workspaceState.selectedCandidate = entry.path;
      $("#ws-path-input").value = entry.path;
    });
    row.addEventListener("dblclick", () => browseTo(entry.path, { syncInput: true }));
    list.appendChild(row);
  }
}

async function selectWorkspaceFolder(targetPath) {
  const error = $("#ws-error");
  const path = String(targetPath || workspaceState.selectedCandidate || "").trim();
  if (!path) {
    error.textContent = "Pehle ek folder chuno";
    return;
  }
  try {
    const result = await api("/api/workspace/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    workspaceState.selection = result.selection || workspaceState.selection;
    closeWorkspacePicker();
    activityRow("workspace.applied", result.path || path);
    await loadWorkspace();
    // Chat history is scoped per folder, so the thread has to be reloaded.
    if (typeof loadSessions === "function") {
      try { await loadSessions(); } catch { /* optional */ }
    }
  } catch (requestError) {
    error.textContent = requestError.message || "Folder select nahi hua";
  }
}

$("#chip-workspace").addEventListener("click", () => openWorkspacePicker());
$("#ws-close").addEventListener("click", () => closeWorkspacePicker());
$("#ws-cancel").addEventListener("click", () => closeWorkspacePicker());
$("#ws-backdrop").addEventListener("click", (event) => {
  if (event.target === $("#ws-backdrop")) closeWorkspacePicker();
});
$("#ws-select").addEventListener("click", () => selectWorkspaceFolder());
$("#ws-go").addEventListener("click", () => browseTo($("#ws-path-input").value, { syncInput: true }));
$("#ws-path-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") browseTo($("#ws-path-input").value, { syncInput: true });
});
$("#ws-up").addEventListener("click", () => {
  const current = workspaceState.browsePath || currentWorkspacePath();
  const parent = current.includes("\\") || current.includes("/")
    ? current.replace(/[\\/][^\\/]*$/, "") || current
    : current;
  browseTo(parent, { syncInput: true });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#ws-backdrop").hidden) closeWorkspacePicker();
});

loadWorkspace();

// Set the mode chip once at boot.
(async () => {
  try { setModeChip(detectAccessMode(await fetchConfig())); } catch { setModeChip("full"); }
})();

// ─── Mid-run question + approval cards ───────────────────────────────────────

function renderQuestionCard(payload) {
  if (!payload.questionId || document.querySelector(`[data-question-id="${payload.questionId}"]`)) return;
  const card = document.createElement("div");
  card.className = "ask-card";
  card.dataset.questionId = payload.questionId;
  card.innerHTML = `<div class="ask-head"><span class="ask-icon">?</span>Agent ko tumhara decision chahiye</div>` +
    `<div class="ask-q">${esc(payload.question || "")}</div><div class="ask-options"></div>`;
  const optionsWrap = card.querySelector(".ask-options");

  const submit = async (answer) => {
    if (!String(answer || "").trim()) return;
    card.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
    try {
      await api("/api/questions/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: payload.questionId, answer }),
      });
      card.classList.add("answered");
      card.querySelector(".ask-head").innerHTML = `<span class="ask-icon done">&#10003;</span>Tumne chuna: <strong>${esc(answer)}</strong>`;
      optionsWrap.remove();
    } catch (error) {
      card.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
      card.querySelector(".ask-head").textContent = `Answer bhejna fail hua: ${error.message}`;
    }
  };

  for (const option of payload.options || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ask-opt${option.recommended ? " recommended" : ""}`;
    button.innerHTML = `<span class="ask-opt-label">${esc(option.label)}${option.recommended ? ' <span class="ask-star">&#9733; Recommended</span>' : ""}</span>` +
      (option.description ? `<span class="ask-opt-desc">${esc(option.description)}</span>` : "");
    button.addEventListener("click", () => submit(option.label));
    optionsWrap.appendChild(button);
  }
  if (payload.allowOther !== false) {
    const other = document.createElement("div");
    other.className = "ask-other";
    other.innerHTML = `<input type="text" placeholder="Kuch aur… (type karke Enter)" spellcheck="false" /><button type="button" class="ask-send">Send</button>`;
    const input = other.querySelector("input");
    other.querySelector(".ask-send").addEventListener("click", () => submit(input.value.trim()));
    input.addEventListener("keydown", (keyEvent) => { if (keyEvent.key === "Enter") submit(input.value.trim()); });
    optionsWrap.appendChild(other);
  }
  $("#thread").appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
}

function markQuestionClosed(questionId, note) {
  const card = document.querySelector(`[data-question-id="${questionId}"]`);
  if (!card || card.classList.contains("answered")) return;
  card.classList.add("answered");
  const head = card.querySelector(".ask-head");
  if (head && note) head.textContent = note;
  card.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
}

async function renderApprovalCard(payload) {
  if (!payload.approvalId || document.querySelector(`[data-approval-id="${payload.approvalId}"]`)) return;
  let approval = null;
  try {
    const data = await api("/api/approvals");
    approval = (data.approvals || []).find((item) => item.id === payload.approvalId);
  } catch { /* fall through with payload only */ }
  if (approval && approval.status !== "pending") return;
  const command = approval?.payload?.command || approval?.summary || payload.type || "command";
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = payload.approvalId;
  card.innerHTML = `<div class="ap-head"><span class="ap-pulse"></span>Agent permission maang raha hai</div>` +
    `<div class="ap-cmd">${esc(command)}</div>` +
    `<div class="ap-actions"><button type="button" class="ap-allow">&#10003; Allow</button><button type="button" class="ap-deny">&#10007; Deny</button></div>`;

  const resolve = async (decision) => {
    card.querySelectorAll("button").forEach((el) => { el.disabled = true; });
    try {
      await api("/api/approvals/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: payload.approvalId, decision, note: "" }),
      });
      card.classList.add(decision === "approved" ? "allowed" : "denied");
      card.querySelector(".ap-head").innerHTML = decision === "approved"
        ? `<span class="ap-mark ok">&#10003;</span>Allowed — command chal raha hai`
        : `<span class="ap-mark bad">&#10007;</span>Denied — agent doosra rasta dhundhega`;
      card.querySelector(".ap-actions").remove();
    } catch (error) {
      card.querySelectorAll("button").forEach((el) => { el.disabled = false; });
      card.querySelector(".ap-head").textContent = `Resolve fail hua: ${error.message}`;
    }
  };
  card.querySelector(".ap-allow").addEventListener("click", () => resolve("approved"));
  card.querySelector(".ap-deny").addEventListener("click", () => resolve("denied"));
  $("#thread").appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "end" });
}

function markApprovalResolved(payload) {
  const card = document.querySelector(`[data-approval-id="${payload.approvalId}"]`);
  if (!card || card.classList.contains("allowed") || card.classList.contains("denied")) return;
  const approved = payload.decision === "approved";
  card.classList.add(approved ? "allowed" : "denied");
  const head = card.querySelector(".ap-head");
  if (head) head.textContent = approved ? "Allowed" : "Denied";
  card.querySelector(".ap-actions")?.remove();
}

// ─── Attachments (images/docs from the composer) ────────────────────────────

const pendingAttachments = []; // [{relPath, name, isImage, bytes}]

function renderAttachTray() {
  const tray = $("#attach-tray");
  if (!tray) return;
  if (!pendingAttachments.length) { tray.hidden = true; tray.innerHTML = ""; return; }
  tray.hidden = false;
  tray.innerHTML = pendingAttachments.map((att, index) => `
    <span class="attach-chip" title="${esc(att.name)}">
      ${att.isImage ? `<img src="/preview/${esc(att.relPath)}" alt="${esc(att.name)}" />` : `<span class="attach-doc">&#128196;</span>`}
      <span class="attach-name">${esc(att.name)}</span>
      <button class="attach-remove" data-index="${index}" title="Remove file">&times;</button>
    </span>`).join("");
  tray.querySelectorAll(".attach-remove").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingAttachments.splice(Number(el.dataset.index), 1);
      renderAttachTray();
    }));
}

async function uploadAttachment(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: 10MB se badi file allow nahi hai.`);
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
  const result = await api("/api/uploads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, dataBase64 }),
  });
  pendingAttachments.push({ relPath: result.relPath, name: file.name, isImage: result.isImage, bytes: result.bytes });
  renderAttachTray();
}

// ─── Popovers & Action Controls ─────────────────────────────────────────────

function closeAllPopovers() {
  const ctx = $("#context-popover");
  const mdl = $("#model-popover");
  const env = $("#env-popover");
  if (ctx) ctx.hidden = true;
  if (mdl) mdl.hidden = true;
  if (env) env.hidden = true;
}

// Context Popover (+)
const contextBtn = $("#context-btn") || $("#attach-btn");
const contextPopover = $("#context-popover");
if (contextBtn && contextPopover) {
  contextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = contextPopover.hidden;
    closeAllPopovers();
    contextPopover.hidden = !isHidden;
  });
}
$("#ctx-opt-media")?.addEventListener("click", () => {
  closeAllPopovers();
  $("#attach-input").click();
});
$("#ctx-opt-mention")?.addEventListener("click", () => {
  closeAllPopovers();
  composer.value += (composer.value && !composer.value.endsWith(" ") ? " @" : "@");
  composer.focus();
});
$("#ctx-opt-actions")?.addEventListener("click", () => {
  closeAllPopovers();
  composer.value = "/";
  updateSlashPalette();
  composer.focus();
});
$("#ctx-opt-browser")?.addEventListener("click", () => {
  closeAllPopovers();
  if (typeof switchDockTab === "function") switchDockTab("mybrowser");
});

// Model Popover
const chipModel = $("#chip-model");
const modelPopover = $("#model-popover");
if (chipModel && modelPopover) {
  chipModel.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = modelPopover.hidden;
    closeAllPopovers();
    modelPopover.hidden = !isHidden;
  });
}
$$(".model-item").forEach((item) => {
  item.addEventListener("click", () => {
    $$(".model-item").forEach((el) => {
      el.classList.remove("active");
      const check = el.querySelector(".model-check");
      if (check) check.textContent = "";
    });
    item.classList.add("active");
    const check = item.querySelector(".model-check");
    if (check) check.textContent = "✓";
    const modelName = item.querySelector(".model-name")?.textContent || "Model";
    const composerModel = $("#composer-model");
    if (composerModel) composerModel.textContent = modelName;
    closeAllPopovers();
  });
});

// Environment Popover
const chipEnv = $("#chip-env");
const envPopover = $("#env-popover");
if (chipEnv && envPopover) {
  chipEnv.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = envPopover.hidden;
    closeAllPopovers();
    envPopover.hidden = !isHidden;
  });
}
$$(".env-item").forEach((item) => {
  item.addEventListener("click", () => {
    $$(".env-item").forEach((el) => el.classList.remove("active"));
    item.classList.add("active");
    const label = item.querySelector(".popover-label")?.textContent || "Local";
    const chipEnvLabel = $("#chip-env-label");
    if (chipEnvLabel) chipEnvLabel.textContent = label;
    closeAllPopovers();
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover-menu") && !e.target.closest(".plus-button") && !e.target.closest("#chip-model") && !e.target.closest("#chip-env") && !e.target.closest("#context-btn")) {
    closeAllPopovers();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllPopovers();
});

$("#attach-input").addEventListener("change", async (event) => {
  for (const file of event.target.files || []) {
    try { await uploadAttachment(file); }
    catch (error) { activityRow("upload.failed", error.message); alert(error.message); }
  }
  event.target.value = "";
});
// Paste an image straight into the composer (screenshot workflows).
document.addEventListener("paste", async (event) => {
  const items = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file");
  if (!items.length) return;
  for (const item of items) {
    const file = item.getAsFile();
    if (!file) continue;
    const named = file.name && file.name !== "image.png"
      ? file
      : new File([file], `pasted-${Date.now()}.png`, { type: file.type });
    try { await uploadAttachment(named); } catch (error) { activityRow("upload.failed", error.message); }
  }
});

// ─── Voice input (Web Speech API — Chrome/Edge) ─────────────────────────────

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRec) {
  $("#voice-btn").hidden = true; // Firefox/others: no dictation support
} else {
  let recognizer = null;
  let listening = false;
  let baseText = "";
  $("#voice-btn").addEventListener("click", () => {
    if (listening) { recognizer?.stop(); return; }
    recognizer = new SpeechRec();
    recognizer.lang = navigator.language?.startsWith("hi") ? "hi-IN" : "en-IN";
    recognizer.interimResults = true;
    recognizer.continuous = true;
    baseText = composer.value ? `${composer.value.trimEnd()} ` : "";
    recognizer.onresult = (event) => {
      let transcript = "";
      for (const result of event.results) transcript += result[0].transcript;
      composer.value = baseText + transcript;
      composer.dispatchEvent(new Event("input"));
    };
    recognizer.onend = () => {
      listening = false;
      $("#voice-btn").classList.remove("listening");
    };
    recognizer.onerror = () => {
      listening = false;
      $("#voice-btn").classList.remove("listening");
    };
    listening = true;
    $("#voice-btn").classList.add("listening");
    recognizer.start();
  });
}

const composer = $("#composer-input");
composer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && $("#slash-palette").hidden) {
    event.preventDefault();
    const text = composer.value;
    composer.value = "";
    composer.style.height = "auto";
    sendMessage(text);
  }
});
composer.addEventListener("input", () => {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 180)}px`;
  updateSlashPalette();
});
$("#send-btn").addEventListener("click", () => {
  const text = composer.value;
  composer.value = "";
  composer.style.height = "auto";
  sendMessage(text);
});
$$(".starter-card").forEach((card) =>
  card.addEventListener("click", () => sendMessage(card.dataset.prompt)));

// ─── Slash commands ─────────────────────────────────────────────────────────

// Prompt-template commands: "/plan build a todo app" expands into a full
// instruction that drives OmniClaw's real tools (update_plan / feature_list /
// create_skill). Expanded client-side in expandSlash() before sending.
const SLASH_TEMPLATES = {
  "/plan": (rest) => `Make a clear, verifiable step-by-step plan for this task using the update_plan tool (give each step a 'verification' = the command/check that proves it done), then execute it step by step, verifying as you go: ${rest}`,
  "/goal": (rest) => `Treat this as a goal. Break it into features with feature_list/feature_set (each feature = behavior + a verification command + state), then start the first not_started feature and verify it with feature_verify: ${rest}`,
  "/skill": (rest) => `Create a new reusable OmniClaw skill with the create_skill tool for: ${rest}. Give it a clear name, description, and the steps it should follow.`,
  "/skill-creator": (rest) => `Create a new reusable OmniClaw skill with the create_skill tool for: ${rest}. Give it a clear name, description, and the steps it should follow.`,
};
const SLASH_COMMANDS = [
  { cmd: "/btw", icon: "💬", hint: "Ask a quick question without interrupting main run" },
  { cmd: "/goal", icon: "🎯", hint: "Run until the specified goal is completely finished" },
  { cmd: "/plan", icon: "🧠", hint: "Make a verified step-by-step plan, then build it" },
  { cmd: "/schedule", icon: "⏱", hint: "Run instruction on a recurring schedule or timer" },
  { cmd: "/browser", icon: "🌐", hint: "Invoke browser agent for web tasks and research" },
  { cmd: "/grill-me", icon: "🎙", hint: "Interview me interactively to align on a plan" },
  { cmd: "/learn", icon: "💡", hint: "Reflect on recent work to capture reusable rules" },
  { cmd: "/skill", icon: "✨", hint: "Create a new reusable OmniClaw skill" },
  { cmd: "/doctor", icon: "🩺", hint: "Health check: provider, tools, memory, gateway" },
  { cmd: "/model", icon: "⚡", hint: "Active model and provider info" },
  { cmd: "/mcp", icon: "🔌", hint: "Manage MCP servers and external tools" },
  { cmd: "/usage", icon: "📊", hint: "Context window and token usage" },
];

let slashSelected = 0;
function updateSlashPalette() {
  const palette = $("#slash-palette");
  const value = composer.value;
  if (!value.startsWith("/") || value.includes("\n")) { palette.hidden = true; return; }
  const matches = SLASH_COMMANDS.filter((item) => item.cmd.startsWith(value.toLowerCase().trimEnd()) || value.trim() === "/");
  if (!matches.length) { palette.hidden = true; return; }
  slashSelected = Math.min(slashSelected, matches.length - 1);
  palette.innerHTML = matches.map((item, index) => `
    <button class="slash-item ${index === slashSelected ? "selected" : ""}" data-cmd="${esc(item.cmd)}">
      <span class="slash-item-icon">${item.icon || "⚡"}</span>
      <span class="slash-item-cmd">${esc(item.cmd)}</span>
      <span class="slash-item-hint">${esc(item.hint)}</span>
    </button>`).join("");
  palette.hidden = false;
  $$(".slash-item").forEach((el) =>
    el.addEventListener("click", () => {
      composer.value = el.dataset.cmd;
      palette.hidden = true;
      composer.focus();
    }));
}
composer.addEventListener("keydown", (event) => {
  const palette = $("#slash-palette");
  if (palette.hidden) return;
  const items = $$(".slash-item");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    slashSelected = (slashSelected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
    items.forEach((el, index) => el.classList.toggle("selected", index === slashSelected));
  }
  if (event.key === "Tab" || (event.key === "Enter" && items[slashSelected])) {
    event.preventDefault();
    composer.value = items[slashSelected].dataset.cmd;
    palette.hidden = true;
  }
  if (event.key === "Escape") palette.hidden = true;
});

// ─── Views ──────────────────────────────────────────────────────────────────

function switchView(view) {
  $$(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  $("#view-chat").classList.toggle("active", view === "chat");
  $("#view-panel").classList.toggle("active", view !== "chat");
  if (view !== "chat") renderPanel(view);
}
$$('[data-view]').forEach((el) =>
  el.addEventListener('click', () => switchView(el.dataset.view)));

function panelShell(title, description, body) {
  return `
    <div class="panel-head">
      <h2>${esc(title)}</h2>
      <p>${esc(description)}</p>
    </div>
    ${body}`;
}

async function renderPanel(view) {
  const box = $("#panel-content");
  box.innerHTML = `<p class="muted">Loading</p>`;
  try {
    if (view === "skills") await renderSkills(box);
    else if (view === "plugins") await renderPlugins(box);
    else if (view === "agents") await renderAgentsPanel(box);
    else if (view === "messaging") await renderMessaging(box);
    else if (view === "automations") await renderAutomations(box);
    else if (view === "memory") await renderMemory(box);
    else if (view === "settings") await renderSettings(box);
  } catch (error) {
    box.innerHTML = `<p class="muted">Could not load ${esc(view)}: ${esc(error.message)}</p>`;
  }
}

async function renderSkills(box) {
  const [skillData, toolData] = await Promise.all([
    api(`/api/skills?agentId=${encodeURIComponent(state.agentId)}`),
    api("/api/tools").catch(() => ({ tools: [], count: 0, modelCallable: 0 })),
  ]);
  const skills = skillData.skills || [];
  const tools = toolData.tools || [];
  const skillGroups = new Map();
  for (const skill of skills) {
    const key = String(skill.source || skill.scope || "general").replace(/-/g, " ");
    if (!skillGroups.has(key)) skillGroups.set(key, []);
    skillGroups.get(key).push(skill);
  }
  const toolGroups = new Map();
  for (const tool of tools) {
    const key = String(tool.group || "general").replace(/[-_]/g, " ");
    if (!toolGroups.has(key)) toolGroups.set(key, []);
    toolGroups.get(key).push(tool);
  }
  const orderedToolGroups = [...toolGroups.entries()].sort((a, b) => b[1].length - a[1].length);

  box.innerHTML = panelShell("Skills & Tools", `Agent "${state.agentId}" — ${skills.length} skills (operating manuals, matching task par load hote hain) aur ${toolData.count || tools.length} REAL tools (${toolData.modelCallable || 0} model-callable).`, `
    <div class="catalog-toolbar">
      <div class="seg-tabs">
        <button class="seg-tab active" data-cat="skills">Skills <span class="badge">${skills.length}</span></button>
        <button class="seg-tab" data-cat="tools">Tools <span class="badge">${toolData.modelCallable || 0}</span></button>
      </div>
      <label class="catalog-search"><span class="line-icon search"></span><input id="skill-search" placeholder="Search" /></label>
    </div>
    <div id="cat-skills" class="cat-pane active">
      ${[...skillGroups.entries()].map(([group, items]) => `
        <div class="section-row-title"><span>${esc(group)}</span><span class="badge">${items.length}</span></div>
        <div class="list-rows">
          ${items.map((skill) => `
            <div class="catalog-row" data-name="${esc(`${skill.name} ${skill.description}`.toLowerCase())}">
              <span class="app-icon violet">${esc(String(skill.name || skill.id).replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "SK")}</span>
              <div class="row-main">
                <strong>${esc(skill.name || skill.id)}</strong>
                <small>${esc(String(skill.description || "No description").slice(0, 140))}</small>
              </div>
              <div class="row-actions">
                <button class="mini-button" data-skill="${esc(skill.id)}">Use</button>
              </div>
            </div>`).join("")}
        </div>`).join("") || `<p class="muted">No skills found.</p>`}
    </div>
    <div id="cat-tools" class="cat-pane">
      ${orderedToolGroups.map(([group, items]) => `
        <div class="section-row-title"><span>${esc(group)}</span><span class="badge">${items.length}</span></div>
        <div class="list-rows">
          ${items.map((tool) => `
            <div class="catalog-row" data-name="${esc(`${tool.id} ${tool.description}`.toLowerCase())}">
              <span class="tool-dot ${tool.modelCallable ? "on" : ""}" title="${tool.modelCallable ? "model-callable" : "operator-only"}"></span>
              <div class="row-main">
                <strong class="mono">${esc(tool.id)}</strong>
                <small>${esc(String(tool.description || "").slice(0, 150))}</small>
              </div>
              <div class="row-actions">
                ${tool.modelCallable ? `<span class="badge ok">model</span>` : `<span class="badge">operator</span>`}
              </div>
            </div>`).join("")}
        </div>`).join("") || `<p class="muted">No tools reported.</p>`}
    </div>`);

  box.querySelectorAll(".seg-tab").forEach((el) =>
    el.addEventListener("click", () => {
      box.querySelectorAll(".seg-tab").forEach((tab) => tab.classList.toggle("active", tab === el));
      box.querySelector("#cat-skills").classList.toggle("active", el.dataset.cat === "skills");
      box.querySelector("#cat-tools").classList.toggle("active", el.dataset.cat === "tools");
    }));
  box.querySelector("#skill-search")?.addEventListener("input", (event) => {
    const needle = event.target.value.trim().toLowerCase();
    box.querySelectorAll(".catalog-row").forEach((row) => {
      row.style.display = !needle || row.dataset.name.includes(needle) ? "" : "none";
    });
  });
  box.querySelectorAll("[data-skill]").forEach((el) =>
    el.addEventListener("click", () => {
      switchView("chat");
      composer.value = `${el.dataset.skill} skill use karke: `;
      composer.focus();
    }));
}

async function renderPlugins(box) {
  const [pluginData, appData] = await Promise.all([
    api("/api/plugins"),
    api("/api/apps"),
  ]);
  const plugins = pluginData.plugins || [];
  const apps = appData.apps || [];
  const computer = appData.computerUse || {};
  const appIcon = (app) => app.id === "github" ? "GH" : app.id === "gmail" ? "GM" : "AP";
  const appAccount = (app) => app.account?.login || app.account?.email || app.account?.name || "";
  const appCard = (app) => `
    <article class="connected-app-card plugin-catalog-item" data-app-card="${esc(app.id)}" data-name="${esc(`${app.name} ${app.description}`.toLowerCase())}">
      <div class="connected-app-top">
        <span class="connected-app-icon" style="--app-accent:${esc(app.accent || "#667")}">${appIcon(app)}</span>
        <div class="row-main">
          <strong>${esc(app.name)}</strong>
          <small>${esc(app.description)}</small>
        </div>
        <span class="badge ${app.connected ? "ok" : ""}">${app.connected ? "connected" : app.configured ? "ready to connect" : "setup needed"}</span>
      </div>
      <div class="connected-app-meta">
        ${app.connected ? `
          <span>Account: <strong>${esc(appAccount(app) || "approved")}</strong></span>
          <span>${esc((app.scopes || []).join(" · "))}</span>` : `
          <span>Read-only agent tools unlock only after you approve OAuth.</span>
          <span>Callback: <code>${esc(app.callbackUrl)}</code></span>`}
      </div>
      <div class="connected-app-actions">
        ${app.connected
          ? `<button class="mini-button danger-outline" data-app-disconnect="${esc(app.id)}">Disconnect</button>`
          : `<button class="mini-button primary" data-app-connect="${esc(app.id)}">${app.configured ? "Connect account" : "Configure OAuth"}</button>`}
        <button class="mini-button" data-app-setup-toggle="${esc(app.id)}">OAuth setup</button>
      </div>
      <form class="app-oauth-form" data-app-oauth-form="${esc(app.id)}" hidden>
        <label>Client ID<input data-oauth-client-id value="" placeholder="Your ${esc(app.name)} OAuth client ID" autocomplete="off" /></label>
        <label>Client secret<input data-oauth-client-secret type="password" placeholder="Stored encrypted on this PC" autocomplete="new-password" /></label>
        <label>Scopes<input data-oauth-scopes value="${esc((app.scopes || []).join(" "))}" /></label>
        <small>Use a localhost OAuth app and add the callback URL shown above in the ${esc(app.name)} developer console. The secret never returns to this page after save.</small>
        <div><button class="mini-button primary" type="submit">Save OAuth setup</button></div>
      </form>
    </article>`;
  const pluginCard = (plugin) => `
    <div class="catalog-row plugin-catalog-item" data-name="${esc(`${plugin.name || plugin.id} ${plugin.description || ""}`.toLowerCase())}">
      <span class="app-icon blue">${esc(String(plugin.name || plugin.id).slice(0, 2).toUpperCase())}</span>
      <div class="row-main"><strong>${esc(plugin.name || plugin.id)}</strong><small>${esc(plugin.description || "No description")} &middot; ${(plugin.tools || []).length} tools</small></div>
      <div class="row-actions"><span class="badge ${plugin.enabled !== false ? "ok" : ""}">${plugin.enabled !== false ? "enabled" : "disabled"}</span><button class="mini-button" data-plugin="${esc(plugin.id)}" data-enabled="${plugin.enabled !== false}">${plugin.enabled !== false ? "Disable" : "Enable"}</button></div>
    </div>`;
  box.innerHTML = panelShell("Plugins & Connected Apps", "Codex-style app catalog. Connect your own accounts with OAuth; tokens stay encrypted on this PC and the agent receives only the granted tools.", `
    <div class="catalog-toolbar">
      <div class="seg-tabs">
        <button class="seg-tab active" data-plugin-tab="apps">Connected apps <span class="badge">${apps.filter((app) => app.connected).length}/${apps.length}</span></button>
        <button class="seg-tab" data-plugin-tab="installed">Installed <span class="badge">${plugins.length}</span></button>
        <button class="seg-tab" data-plugin-tab="computer">Computer Use</button>
      </div>
      <label class="catalog-search"><span class="line-icon search"></span><input id="plugin-search" placeholder="Search apps and plugins" /></label>
    </div>
    <section class="cat-pane active" data-plugin-pane="apps">
      <div class="connected-app-intro"><strong>Connect your work</strong><span>GitHub and Gmail use your own OAuth app credentials, then your browser shows the official consent screen.</span></div>
      <div class="connected-app-grid">${apps.map(appCard).join("")}</div>
    </section>
    <section class="cat-pane" data-plugin-pane="installed"><div class="list-rows">${plugins.map(pluginCard).join("") || `<p class="muted">No local plugins installed.</p>`}</div></section>
    <section class="cat-pane" data-plugin-pane="computer">
      <article class="computer-use-card">
        <div><span class="connected-app-icon computer">PC</span><h3>Computer Use</h3><p>Allow the agent to use enabled computer/file tools within the configured Windows roots. Destructive operations remain governed by existing safety policies.</p></div>
        <span class="badge ${computer.enabled ? "ok" : ""}">${computer.enabled ? "enabled" : "disabled"}</span>
        <dl><div><dt>Allowed roots</dt><dd>${esc((computer.allowedRoots || []).join(", ") || "none")}</dd></div><div><dt>Write</dt><dd>${computer.allowWrite ? "allowed" : "blocked"}</dd></div><div><dt>Delete</dt><dd>${computer.allowDelete ? "allowed (trash by default)" : "blocked"}</dd></div></dl>
        <button class="mini-button primary" data-computer-toggle="${computer.enabled ? "disable" : "enable"}">${computer.enabled ? "Disable Computer Use" : "Enable Computer Use"}</button>
      </article>
    </section>`);

  box.querySelectorAll("[data-plugin-tab]").forEach((tab) => tab.addEventListener("click", () => {
    box.querySelectorAll("[data-plugin-tab]").forEach((item) => item.classList.toggle("active", item === tab));
    box.querySelectorAll("[data-plugin-pane]").forEach((pane) => pane.classList.toggle("active", pane.dataset.pluginPane === tab.dataset.pluginTab));
  }));
  box.querySelector("#plugin-search")?.addEventListener("input", (event) => {
    const needle = event.target.value.trim().toLowerCase();
    box.querySelectorAll(".plugin-catalog-item").forEach((item) => { item.style.display = !needle || item.dataset.name.includes(needle) ? "" : "none"; });
  });
  box.querySelectorAll("[data-plugin]").forEach((el) =>
    el.addEventListener("click", async () => {
      el.disabled = true;
      try {
        await api("/api/plugins/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pluginId: el.dataset.plugin, enabled: el.dataset.enabled !== "true" }),
        });
      } catch { /* re-render shows truth */ }
      renderPanel("plugins");
    }));
  box.querySelectorAll("[data-app-setup-toggle]").forEach((button) => button.addEventListener("click", () => {
    const form = box.querySelector(`[data-app-oauth-form="${button.dataset.appSetupToggle}"]`);
    if (form) form.hidden = !form.hidden;
  }));
  box.querySelectorAll("[data-app-oauth-form]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const provider = form.dataset.appOauthForm;
    const clientId = form.querySelector("[data-oauth-client-id]").value;
    const clientSecret = form.querySelector("[data-oauth-client-secret]").value;
    const scopes = form.querySelector("[data-oauth-scopes]").value;
    try {
      await api("/api/apps/oauth/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, clientId, clientSecret, scopes }) });
      renderPanel("plugins");
    } catch (error) { window.alert(error.message || "OAuth setup could not be saved."); }
  }));
  box.querySelectorAll("[data-app-connect]").forEach((button) => button.addEventListener("click", () => {
    const app = apps.find((item) => item.id === button.dataset.appConnect);
    if (!app?.configured) { box.querySelector(`[data-app-oauth-form="${button.dataset.appConnect}"]`)?.removeAttribute("hidden"); return; }
    window.location.assign(`/api/apps/oauth/start?provider=${encodeURIComponent(button.dataset.appConnect)}`);
  }));
  box.querySelectorAll("[data-app-disconnect]").forEach((button) => button.addEventListener("click", async () => {
    if (!window.confirm(`Disconnect ${button.dataset.appDisconnect}? The local OAuth token will be removed.`)) return;
    await api("/api/apps/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: button.dataset.appDisconnect }) });
    renderPanel("plugins");
  }));
  box.querySelector("[data-computer-toggle]")?.addEventListener("click", async (button) => {
    const enabled = button.currentTarget.dataset.computerToggle === "enable";
    if (!window.confirm(`${enabled ? "Enable" : "Disable"} Computer Use for OmniClaw?`)) return;
    await api("/api/apps/computer-use", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
    renderPanel("plugins");
  });
}

async function renderAgentsPanel(box) {
  const data = await api("/api/agents");
  box.innerHTML = panelShell("Agents", "Configured OmniClaw agents. Har agent ka apna workspace, identity files, tools aur skills hote hain.", `
    <div class="list-rows">
      ${(data.agents || []).map((agent) => `
        <div class="catalog-row">
          <span class="app-icon violet">${esc(String(agent.id).slice(0, 2).toUpperCase())}</span>
          <div class="row-main">
            <strong>${esc(agent.name || agent.id)}</strong>
            <small>${esc(agent.description || "")} &middot; profile: ${esc(agent.profileId || agent.profile?.id || "default")}</small>
          </div>
          <div class="row-actions">
            <span class="badge">${(agent.stats?.skillCount ?? agent.skills?.length ?? 0)} skills</span>
            <span class="badge">${(agent.stats?.toolCount ?? agent.tools?.length ?? 0)} tools</span>
            <button class="mini-button" data-agent="${esc(agent.id)}">Chat</button>
          </div>
        </div>`).join("")}
    </div>`);
  box.querySelectorAll("[data-agent]").forEach((el) =>
    el.addEventListener("click", () => {
      state.agentId = el.dataset.agent;
      $("#agent-select").value = state.agentId;
      $("#new-chat").click();
    }));
}

async function renderMessaging(box) {
  const data = await api("/api/connectors/adapters");
  const adapters = data.adapters || [];
  box.innerHTML = panelShell("Messaging", "OmniClaw ko Telegram, Discord aur webhooks se jodo. Configured channels directly agent sessions me route hote hain.", `
    <div class="list-rows">
      ${adapters.map((adapter) => `
        <div class="catalog-row">
          <span class="app-icon ${adapter.enabled ? "green" : "blue"}">${esc(String(adapter.name || adapter.id).slice(0, 2).toUpperCase())}</span>
          <div class="row-main">
            <strong>${esc(adapter.name || adapter.id)}</strong>
            <small>${esc(adapter.transport || "")} &middot; ${esc(adapter.direction || "")} &middot; agent: ${esc(adapter.defaultAgentId || "main")}</small>
          </div>
          <div class="row-actions">
            <span class="badge ${adapter.status === "ready" || adapter.status === "configured" ? "ok" : adapter.status === "needs-secret" ? "warn" : ""}">${esc(adapter.status || "unknown")}</span>
            <button class="mini-button" data-adapter="${esc(adapter.id)}">${adapter.secretConfigured ? "Reconfigure" : "Set up"}</button>
          </div>
        </div>`).join("") || `<p class="muted">No adapters registered.</p>`}
    </div>
    <div class="section-row-title" style="margin-top:28px"><span>Quick setup</span></div>
    <div class="card" style="max-width:560px">
      <h4>Telegram bot</h4>
      <p>BotFather se token lo, yahan paste karo. Allowed user IDs optional hain (comma-separated, @userinfobot se milenge).</p>
      <div style="display:grid;gap:8px;margin-top:12px">
        <input id="tg-token" type="password" placeholder="Bot token (123456:ABC...)" style="min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);outline:0" />
        <input id="tg-users" type="text" placeholder="Allowed user IDs (optional)" style="min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);outline:0" />
        <div style="display:flex;gap:8px">
          <button class="mini-button" id="tg-save">Save and test</button>
          <span class="muted small" id="tg-status"></span>
        </div>
      </div>
    </div>`);
  box.querySelectorAll("[data-adapter]").forEach((el) =>
    el.addEventListener("click", () => {
      const input = box.querySelector("#tg-token");
      if (el.dataset.adapter.includes("telegram") && input) input.focus();
      else {
        switchView("chat");
        composer.value = `${el.dataset.adapter} connector setup karo`;
        composer.focus();
      }
    }));
  box.querySelector("#tg-save")?.addEventListener("click", async () => {
    const status = box.querySelector("#tg-status");
    const token = box.querySelector("#tg-token").value.trim();
    if (!token) { status.textContent = "Token required."; return; }
    status.textContent = "Saving";
    try {
      await api("/api/connectors/adapters/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adapterId: "telegram-bot",
          enabled: true,
          secret: token,
          allowedUserIds: box.querySelector("#tg-users").value.trim(),
        }),
      });
      const test = await api("/api/connectors/adapters/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterId: "telegram-bot" }),
      }).catch(() => null);
      status.textContent = test?.ok === false ? `Saved, test failed: ${test.error || ""}` : "Saved and verified.";
      renderPanel("messaging");
    } catch (error) {
      status.textContent = `Failed: ${error.message}`;
    }
  });
}

async function renderAutomations(box) {
  const data = await api("/api/schedules");
  const schedules = data.schedules || [];
  box.innerHTML = panelShell("Automations", "Scheduled tasks jo cron ya interval par background me chalte hain.", `
    <div class="list-rows">
      ${schedules.map((schedule) => `
        <div class="catalog-row">
          <span class="app-icon amber">CR</span>
          <div class="row-main">
            <strong>${esc(schedule.name || schedule.id)}</strong>
            <small>${esc(schedule.trigger?.kind || "")} ${esc(schedule.trigger?.expression || schedule.trigger?.interval || "")} &middot; next: ${esc(schedule.nextRunAt || "n/a")}</small>
          </div>
          <div class="row-actions">
            <span class="badge ${schedule.status === "active" ? "ok" : ""}">${esc(schedule.status || "")}</span>
          </div>
        </div>`).join("") || `<p class="muted">No schedules yet. Chat me likho: "har subah 9 baje news summary bhejo" — agent cron bana dega.</p>`}
    </div>`);
}

async function renderMemory(box) {
  const data = await api("/api/memory");
  const overview = data.overview || data;
  const longTerm = (data.longTerm || data.longTermMemory || []).slice().reverse(); // newest first
  const typeOf = (memory) => {
    const tags = memory.tags || [];
    if (tags.includes("user-fact") || memory.sourceType === "auto_capture") return "user";
    if (tags.includes("action-boundary")) return "feedback";
    return "project";
  };
  box.innerHTML = panelShell("Memory", "Ek fact = ek markdown file (workspace/agents/<agent>/memory/) + MEMORY.md index jo har run ke prompt me jata hai. Harness khud maintain karta hai — auto-captured user facts, promoted memories, session summaries.", `
    <div class="metric-grid">
      <div class="card"><p>Long-term facts</p><div class="metric-value">${overview.longTerm ?? longTerm.length}</div></div>
      <div class="card"><p>Notes</p><div class="metric-value">${overview.notes ?? 0}</div></div>
      <div class="card"><p>Conversations</p><div class="metric-value">${overview.conversations ?? 0}</div></div>
      <div class="card"><p>Dream sweeps</p><div class="metric-value">${overview.dreams ?? 0}</div></div>
    </div>
    <div class="catalog-toolbar">
      <div class="seg-tabs" id="mem-filter">
        <button class="seg-tab active" data-type="all">All</button>
        <button class="seg-tab" data-type="user">User facts</button>
        <button class="seg-tab" data-type="project">Project</button>
        <button class="seg-tab" data-type="feedback">Feedback</button>
      </div>
      <label class="catalog-search"><span class="line-icon search"></span><input id="mem-search" placeholder="Search memories" /></label>
    </div>
    <div class="list-rows" id="mem-rows">
      ${longTerm.slice(0, 60).map((memory) => {
        const type = typeOf(memory);
        const tags = (memory.tags || []).filter((t) => !["memory-write", "auto-capture"].includes(t)).slice(0, 4);
        return `
        <div class="catalog-row mem-row" data-type="${type}" data-name="${esc(`${memory.title} ${memory.text} ${(memory.tags || []).join(" ")}`.toLowerCase())}">
          <span class="mem-type ${type}">${type === "user" ? "&#128100;" : type === "feedback" ? "&#9998;" : "&#128193;"}</span>
          <div class="row-main">
            <strong>${esc(memory.title || "memory")}</strong>
            <small>${esc(String(memory.text || "").slice(0, 170))}</small>
            ${tags.length ? `<div class="tag-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="row-actions">
            <span class="badge ${memory.importance === "high" ? "warn" : ""}">${esc(memory.importance || "medium")}</span>
            <small class="muted">${timeAgo(memory.updatedAt || memory.promotedAt || memory.createdAt)}</small>
          </div>
        </div>`;
      }).join("") || `<p class="muted">No long-term memories yet. Chat me "yaad rakho..." bolo — ya bas kaam karo, durable facts auto-capture hote hain.</p>`}
    </div>`);
  const applyMemFilter = () => {
    const type = box.querySelector("#mem-filter .seg-tab.active")?.dataset.type || "all";
    const needle = (box.querySelector("#mem-search")?.value || "").trim().toLowerCase();
    box.querySelectorAll(".mem-row").forEach((row) => {
      const typeOk = type === "all" || row.dataset.type === type;
      const searchOk = !needle || row.dataset.name.includes(needle);
      row.style.display = typeOk && searchOk ? "" : "none";
    });
  };
  box.querySelectorAll("#mem-filter .seg-tab").forEach((el) =>
    el.addEventListener("click", () => {
      box.querySelectorAll("#mem-filter .seg-tab").forEach((tab) => tab.classList.toggle("active", tab === el));
      applyMemFilter();
    }));
  box.querySelector("#mem-search")?.addEventListener("input", applyMemFilter);
}

async function renderSettings(box) {
  const [health, config] = await Promise.all([api("/api/health"), api("/api/config")]);
  const provider = health.provider || {};
  const profiles = config.config?.providerProfiles || config.providerProfiles || {};
  const secrets = config.providerSecrets || [];
  const keyStatusFor = (providerId) => secrets.find((s) => s.providerId === providerId) || { configured: false, masked: "" };
  const profileIds = Object.keys(profiles);
  // Default to the ACTIVE provider profile, not just the first one.
  const activeKeyProvider = provider.apiKeyProviderId || "";
  const activeProfileId =
    profileIds.find((id) => profiles[id].apiKeyProviderId === activeKeyProvider && profiles[id].model === provider.model) ||
    profileIds.find((id) => profiles[id].apiKeyProviderId === activeKeyProvider) ||
    profileIds[0] || "";

  box.innerHTML = panelShell("Settings", "Provider brain, model selection aur runtime quick controls. Advanced settings classic dashboard me hain.", `
    <div class="section-row-title"><span>Provider &amp; Model</span><span class="badge ${provider.ready !== false ? "ok" : "bad"}">${provider.ready !== false ? "ready" : "not ready"}</span></div>
    <div class="card" style="max-width:660px">
      <p>Step-by-step: provider chuno → API key add karo → models fetch karo → ek model test karo → apply.</p>
      <div style="display:grid;gap:10px;margin-top:12px">
        <label class="set-label">1. Provider
          <select id="set-profile" class="agent-select" style="width:100%;max-width:100%">
            ${profileIds.map((id) => `<option value="${esc(id)}"${id === activeProfileId ? " selected" : ""}>${esc(id)}${profiles[id].model ? ` — ${esc(profiles[id].model)}` : ""}</option>`).join("")}
          </select>
        </label>
        <div class="muted small" id="set-provider-meta"></div>
        <label class="set-label">2. API key
          <div style="display:flex;gap:8px">
            <input id="set-key" type="password" placeholder="paste API key" style="flex:1;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
            <button class="mini-button" id="set-savekey">Save key</button>
          </div>
          <div class="small" id="set-keystatus" style="margin-top:4px"></div>
        </label>
        <label class="set-label">3. Model
          <div style="display:flex;gap:8px">
            <select id="set-model" class="agent-select" style="flex:1;width:auto;max-width:100%"><option value="">${esc(provider.model || "current model")}</option></select>
            <button class="mini-button" id="set-fetch-models">Fetch models</button>
          </div>
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="mini-button" id="set-test">4. Test model</button>
          <button class="mini-button" id="set-apply">5. Apply</button>
          <span class="muted small" id="set-status">Active: ${esc(provider.id || "")} ${esc(provider.model || "")}</span>
        </div>
      </div>
    </div>
    <div class="section-row-title" style="margin-top:26px"><span>➕ Custom provider</span><span class="badge">apna naam + URL + key</span></div>
    <div class="card" style="max-width:660px">
      <p>Koi bhi OpenAI-compatible endpoint add karo apne naam se. Name + Base URL + API key do → models fetch → test → save. Save ke baad ye upar wale Provider dropdown me tumhare naam se aa jayega.</p>
      <div style="display:grid;gap:10px;margin-top:12px">
        <label class="set-label">Provider name
          <input id="cp-name" placeholder="e.g. My Cerebras" style="width:100%;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
        </label>
        <label class="set-label">Base URL
          <input id="cp-url" placeholder="https://api.example.com/v1" style="width:100%;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
        </label>
        <label class="set-label">API key
          <input id="cp-key" type="password" placeholder="paste API key" style="width:100%;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
        </label>
        <label class="set-label">Auth style
          <select id="cp-auth" class="agent-select" style="width:100%;max-width:100%">
            <option value="">Bearer (default — OpenAI/OpenRouter/Groq/most)</option>
            <option value="anthropic">Anthropic (x-api-key + anthropic-version)</option>
          </select>
        </label>
        <label class="set-label">Model
          <div style="display:flex;gap:8px">
            <select id="cp-model" class="agent-select" style="flex:1;width:auto;max-width:100%"><option value="">fetch models pehle</option></select>
            <button class="mini-button" id="cp-fetch">Fetch models</button>
          </div>
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="mini-button" id="cp-test">Test</button>
          <button class="mini-button primary" id="cp-save">Save &amp; apply</button>
          <span class="muted small" id="cp-status"></span>
        </div>
      </div>
    </div>
    <div class="section-row-title" style="margin-top:26px"><span>Sub-agents</span><span class="badge">${esc(config.config?.runtime?.subAgents?.model || "main model")}</span></div>
    <div class="card" style="max-width:660px">
      <p>Sub-agents (delegate_task / best_of_n / research fan-out) ka apna model — main agent se alag, taaki uska quota na jale. Same flow: provider → models fetch → test → save. Khali chhodo = main agent wala model.</p>
      <div style="display:grid;gap:10px;margin-top:12px">
        <label class="set-label">1. Model source (provider) — sub-agents run on THIS provider's key
          <select id="sub-profile" class="agent-select" style="width:100%;max-width:100%">
            ${profileIds.map((id) => `<option value="${esc(id)}"${id === (config.config?.runtime?.subAgents?.provider || activeProfileId) ? " selected" : ""}>${esc(id)}${id === activeProfileId ? " (same as main)" : ""}</option>`).join("")}
          </select>
        </label>
        <div class="muted small" id="sub-provider-meta"></div>
        <label class="set-label">2. Sub-agent model
          <div style="display:flex;gap:8px">
            <select id="sub-model" class="agent-select" style="flex:1;width:auto;max-width:100%">
              <option value="">${esc(config.config?.runtime?.subAgents?.model || "same as main agent")}</option>
            </select>
            <button class="mini-button" id="sub-fetch-models">Fetch models</button>
          </div>
        </label>
        <label class="set-label">3. Fallback model (sub-agent rate-limit par isse retry karega)
          <select id="sub-fallback" class="agent-select" style="width:100%;max-width:100%">
            <option value="">${esc(config.config?.runtime?.subAgents?.fallbackModel || "none")}</option>
          </select>
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="mini-button" id="sub-test">4. Test model</button>
          <label class="set-label" style="flex:none">Max concurrent
            <input id="set-sub-conc" type="number" min="1" max="8" value="${esc(String(config.config?.runtime?.subAgents?.maxConcurrent || 3))}" style="width:80px;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
          </label>
          <label class="set-label" style="flex:none">Max per hour
            <input id="set-sub-hour" type="number" min="1" max="200" value="${esc(String(config.config?.runtime?.subAgents?.maxPerHour || 30))}" style="width:90px;min-height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-soft);color:var(--text);outline:0" />
          </label>
          <button class="mini-button primary" id="set-sub-save">5. Save sub-agent settings</button>
        </div>
        <div class="muted small" id="set-sub-status"></div>
      </div>
    </div>
    <div class="section-row-title" style="margin-top:26px"><span>Runtime</span></div>
    <div class="metric-grid">
      <div class="card"><p>Server</p><div class="metric-value">v${esc(health.version || "")}</div></div>
      <div class="card"><p>Uptime</p><div class="metric-value">${Math.floor((health.uptime || 0) / 60)}m</div></div>
      <div class="card"><p>Theme</p><div style="margin-top:6px"><button class="mini-button" id="set-theme">Switch to ${state.theme === "dark" ? "light" : "dark"}</button></div></div>
      <div class="card"><p>Classic dashboard</p><div style="margin-top:6px"><a class="mini-button" href="/classic/index.html" target="_blank">Open</a></div></div>
    </div>`);

  const statusEl = box.querySelector("#set-status");
  const metaEl = box.querySelector("#set-provider-meta");
  const keyStatusEl = box.querySelector("#set-keystatus");
  const profileSel = box.querySelector("#set-profile");
  const modelSel = box.querySelector("#set-model");

  const keyProviderOf = (pid) => profiles[pid]?.apiKeyProviderId || pid;
  const renderKeyStatus = (statusObj) => {
    if (statusObj?.configured) {
      keyStatusEl.innerHTML = `<span class="badge ok">key set</span> <span class="muted">${esc(statusObj.masked || "")}</span>`;
    } else {
      keyStatusEl.innerHTML = `<span class="badge bad">no key</span> <span class="muted">add a key for this provider</span>`;
    }
  };
  // Reflect the selected provider: base URL, key-provider id, and key status.
  const refreshProviderView = (pid) => {
    const p = profiles[pid] || {};
    const kp = keyProviderOf(pid);
    metaEl.innerHTML = `Endpoint: <code>${esc(p.baseUrl || "(local/cli)")}</code> · key id: <code>${esc(kp)}</code> · default model: <code>${esc(p.model || "—")}</code>`;
    renderKeyStatus(keyStatusFor(kp));
    modelSel.innerHTML = `<option value="">${esc(p.model || "default model")}</option>`;
  };
  refreshProviderView(activeProfileId);
  profileSel.addEventListener("change", () => refreshProviderView(profileSel.value));

  // ── Custom provider: name + URL + key → fetch → test → save named profile ──
  const cp = (id) => box.querySelector(`#cp-${id}`);
  const cpStatus = cp("status");
  const cpReadCommon = () => ({
    baseUrl: cp("url").value.trim(),
    apiKey: cp("key").value.trim(),
    authStyle: cp("auth").value.trim(),
  });
  cp("fetch")?.addEventListener("click", async () => {
    const { baseUrl, apiKey, authStyle } = cpReadCommon();
    if (!baseUrl) { cpStatus.textContent = "Base URL daalo pehle."; return; }
    if (!apiKey) { cpStatus.textContent = "API key daalo (naye endpoint ke liye zaroori)."; return; }
    cpStatus.textContent = "Fetching models…";
    try {
      const result = await api("/api/provider/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, authStyle, apiKeyProviderId: "custom-adhoc" }),
      });
      if (result.ok === false) { cpStatus.textContent = `Fetch failed: ${result.error || "check URL/key"}`; return; }
      const models = result.models || [];
      cp("model").innerHTML = models.length
        ? models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("")
        : `<option value="">No models returned</option>`;
      cpStatus.textContent = `${models.length} models loaded — model chuno, test karo, phir save.`;
    } catch (error) {
      cpStatus.textContent = `Fetch failed: ${error.message}`;
    }
  });
  cp("test")?.addEventListener("click", async () => {
    const { baseUrl, apiKey, authStyle } = cpReadCommon();
    const model = cp("model").value;
    if (!baseUrl || !model) { cpStatus.textContent = "URL aur model dono chahiye test ke liye."; return; }
    cpStatus.textContent = `Testing ${model}…`;
    try {
      const result = await api("/api/provider/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, model, apiKey, authStyle, apiKeyProviderId: "custom-adhoc", live: true }),
      });
      cpStatus.textContent = result.ok
        ? `✓ Test passed: ${result.candidate?.model || model}${result.live?.responsePreview ? ` — "${result.live.responsePreview.slice(0, 40)}"` : ""}`
        : `✗ Test failed: ${result.message || result.error || "unknown"}`;
    } catch (error) {
      cpStatus.textContent = `Test failed: ${error.message}`;
    }
  });
  cp("save")?.addEventListener("click", async () => {
    const { baseUrl, apiKey, authStyle } = cpReadCommon();
    const name = cp("name").value.trim();
    const model = cp("model").value;
    if (!name) { cpStatus.textContent = "Provider ka naam daalo."; return; }
    if (!baseUrl || !model) { cpStatus.textContent = "Base URL aur model chahiye."; return; }
    cpStatus.textContent = "Saving…";
    try {
      const result = await api("/api/provider/profile/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseUrl, model, apiKey, authStyle, apply: true }),
      });
      if (result.ok === false) { cpStatus.textContent = `Save failed: ${result.error || "check fields"}`; return; }
      cpStatus.textContent = `✓ Saved & applied: "${name}" (${model}). Re-opening settings…`;
      loadStatus();
      setTimeout(() => renderPanel("settings"), 600);
    } catch (error) {
      cpStatus.textContent = `Save failed: ${error.message}`;
    }
  });

  // ── Sub-agent flow: provider → fetch → test → save (main-agent parity) ──
  const subStatus = box.querySelector("#set-sub-status");
  const subProfileSel = box.querySelector("#sub-profile");
  const subModelSel = box.querySelector("#sub-model");
  const subFallbackSel = box.querySelector("#sub-fallback");
  const subMetaEl = box.querySelector("#sub-provider-meta");
  const savedSubModel = config.config?.runtime?.subAgents?.model || "";
  const savedSubFallback = config.config?.runtime?.subAgents?.fallbackModel || "";
  const refreshSubProviderView = (pid) => {
    const p = profiles[pid] || {};
    const kp = keyProviderOf(pid);
    const key = keyStatusFor(kp);
    const sameAsActive = pid === activeProfileId;
    subMetaEl.innerHTML = `Endpoint: <code>${esc(p.baseUrl || "(local/cli)")}</code> · key: ${key.configured ? `<span class="badge ok">set</span>` : `<span class="badge bad">missing — is provider ki key add karo (upar Provider section / Custom provider se)</span>`} · ${sameAsActive ? "same as your active provider" : "sub-agents will run on THIS provider (its own key), separate from the main agent"}. Pick a model valid on this endpoint.`;
  };
  refreshSubProviderView(subProfileSel.value);
  subProfileSel.addEventListener("change", () => refreshSubProviderView(subProfileSel.value));

  box.querySelector("#sub-fetch-models")?.addEventListener("click", async () => {
    subStatus.textContent = "Fetching models…";
    try {
      const result = await api("/api/provider/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: subProfileSel.value }),
      });
      if (result.ok === false) { subStatus.textContent = `Fetch failed: ${result.error || "check API key"}`; return; }
      const models = result.models || [];
      const optionsFor = (selected) => [
        `<option value=""${!selected ? " selected" : ""}>${selected ? "same as main agent" : "same as main agent (default)"}</option>`,
        ...models.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? " selected" : ""}>${esc(m.id)}</option>`),
      ].join("");
      subModelSel.innerHTML = optionsFor(savedSubModel);
      subFallbackSel.innerHTML = optionsFor(savedSubFallback).replace("same as main agent (default)", "no fallback");
      subStatus.textContent = `${models.length} models loaded — ab model chuno, test karo, phir save.`;
    } catch (error) {
      subStatus.textContent = `Fetch failed: ${error.message}`;
    }
  });

  box.querySelector("#sub-test")?.addEventListener("click", async () => {
    const model = subModelSel.value;
    if (!model) { subStatus.textContent = "Test ke liye pehle ek model chuno (ya default hi rakhna hai to test zaroori nahi)."; return; }
    subStatus.textContent = `Testing ${model}…`;
    try {
      const result = await api("/api/provider/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: subProfileSel.value, model, live: true }),
      });
      subStatus.textContent = result.ok
        ? `✓ Sub-agent model test passed: ${model}${result.live?.responsePreview ? ` — "${result.live.responsePreview.slice(0, 40)}"` : ""}`
        : `✗ Test failed: ${result.message || result.error || "unknown"}`;
    } catch (error) {
      subStatus.textContent = `Test failed: ${error.message}`;
    }
  });

  box.querySelector("#set-sub-save")?.addEventListener("click", async () => {
    subStatus.textContent = "Saving…";
    try {
      await api("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runtime: {
            subAgents: {
              provider: subProfileSel.value.trim(),
              model: subModelSel.value.trim(),
              fallbackModel: subFallbackSel.value.trim(),
              maxConcurrent: Math.max(1, Math.min(8, Number(box.querySelector("#set-sub-conc").value) || 3)),
              maxPerHour: Math.max(1, Math.min(200, Number(box.querySelector("#set-sub-hour").value) || 30)),
            },
          },
        }),
      });
      subStatus.textContent = `✓ Saved — sub-agents ab "${subModelSel.value || "main model"}" par chalenge (next spawn se).`;
    } catch (error) {
      subStatus.textContent = `Save failed: ${error.message}`;
    }
  });

  box.querySelector("#set-theme")?.addEventListener("click", () => {
    $("#theme-toggle").click();
    renderPanel("settings");
  });

  box.querySelector("#set-savekey")?.addEventListener("click", async () => {
    const pid = profileSel.value;
    const kp = keyProviderOf(pid);
    const key = box.querySelector("#set-key").value.trim();
    if (!key) { keyStatusEl.innerHTML = `<span class="badge bad">no key</span> <span class="muted">paste a key first</span>`; return; }
    keyStatusEl.textContent = "Saving key…";
    try {
      await api("/api/provider/key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: kp, apiKey: key }),
      });
      // Confirm by reading back the masked status from the server.
      const fresh = await api(`/api/provider/key/status?providerId=${encodeURIComponent(kp)}`);
      const st = (fresh.statuses && fresh.statuses[0]) || { configured: true, masked: "" };
      renderKeyStatus(st);
      box.querySelector("#set-key").value = "";
      statusEl.textContent = `Key saved for ${kp}.`;
    } catch (error) {
      keyStatusEl.innerHTML = `<span class="badge bad">save failed</span> <span class="muted">${esc(error.message)}</span>`;
    }
  });

  box.querySelector("#set-fetch-models")?.addEventListener("click", async () => {
    statusEl.textContent = "Fetching models…";
    try {
      const profileId = profileSel.value;
      const result = await api("/api/provider/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      if (result.ok === false) { statusEl.textContent = `Models fetch failed: ${result.error || "check API key"}`; return; }
      const models = result.models || [];
      const current = profiles[profileId]?.model || "";
      modelSel.innerHTML = models.length
        ? models.map((m) => `<option value="${esc(m.id)}"${m.id === current ? " selected" : ""}>${esc(m.id)}</option>`).join("")
        : `<option value="">No models returned</option>`;
      statusEl.textContent = `${models.length} models loaded.`;
    } catch (error) {
      statusEl.textContent = `Models fetch failed: ${error.message}`;
    }
  });

  box.querySelector("#set-test")?.addEventListener("click", async () => {
    const profileId = profileSel.value;
    const model = modelSel.value || "";
    statusEl.textContent = `Testing ${model || profiles[profileId]?.model || "model"}…`;
    try {
      const result = await api("/api/provider/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, model, live: true }),
      });
      statusEl.textContent = result.ok
        ? `✓ Test passed: ${result.candidate?.model || result.model || model || ""}${result.live?.responsePreview ? ` — "${result.live.responsePreview.slice(0, 40)}"` : ""}`
        : `✗ Test failed: ${result.message || result.error || "unknown"}`;
    } catch (error) {
      statusEl.textContent = `Test failed: ${error.message}`;
    }
  });

  box.querySelector("#set-apply")?.addEventListener("click", async () => {
    statusEl.textContent = "Applying…";
    try {
      const profileId = profileSel.value;
      const model = modelSel.value;
      await api("/api/provider/profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });
      if (model) {
        await api("/api/config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: { model } }),
        });
      }
      statusEl.textContent = `Applied: ${profileId}${model ? ` / ${model}` : ""}. New runs use this.`;
      loadStatus();
    } catch (error) {
      statusEl.textContent = `Apply failed: ${error.message}`;
    }
  });
}

// ─── Dock: preview browser + activity ───────────────────────────────────────

let dockTab = "mybrowser";
function openDock(tab = "mybrowser") {
  dockTab = tab;
  $("#dock").hidden = false;
  $$(".dock-tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  $$(".dock-pane").forEach((el) => el.classList.toggle("active", el.id === `pane-${tab}`));
  // Opening the browser pane should just work: attach to the agent if it is
  // driving a page, otherwise fall back to the real-Chrome connect flow.
  if (tab === "mybrowser") mbAutoOpen();
  // Switching AWAY from the browser pane must end the stream. A screencast
  // nobody can see is pure cost, and this is where most of it was leaked.
  else if (typeof mbCloseStream === "function") mbCloseStream();
}
$("#dock-toggle").addEventListener("click", () => {
  const dock = $("#dock");
  dock.hidden = !dock.hidden;
});
$("#run-inspector-btn")?.addEventListener("click", () => openDock("workspace"));
// The dock must not leave a screencast running behind a closed panel. A hidden
// dock used to keep streaming 20fps of JPEG forever: invisible, undiagnosable,
// and a permanent CPU charge. Every way the pane can go away ends the stream.
$("#dock-close").addEventListener("click", () => {
  $("#dock").hidden = true;
  if (typeof mbCloseStream === "function") mbCloseStream();
  if (typeof mbStopWatch === "function") mbStopWatch();
});
$("#dock-expand")?.addEventListener("click", () => {
  const dock = $("#dock");
  dock.classList.toggle("expanded");
  $("#dock-expand").title = dock.classList.contains("expanded") ? "Restore live workspace" : "Expand live workspace";
});
$("#terminal-copy")?.addEventListener("click", () => copyText($("#terminal-live")?.innerText || ""));
$("#terminal-search")?.addEventListener("click", () => {
  const term = prompt("Find in terminal output:");
  if (!term) return;
  const target = $("#terminal-live");
  const match = [...target.querySelectorAll("pre")].find((node) => node.textContent.toLowerCase().includes(term.toLowerCase()));
  match?.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#terminal-maximize")?.addEventListener("click", () => {
  openDock("terminal");
  $("#dock")?.classList.toggle("expanded");
});
$("#code-copy")?.addEventListener("click", () => copyText($("#code-live-output")?.innerText || ""));
$("#code-motion")?.addEventListener("click", (event) => {
  const modes = ["animated", "instant", "reduced"];
  codeRevealMode = modes[(modes.indexOf(codeRevealMode) + 1) % modes.length];
  localStorage.setItem("oc-code-reveal", codeRevealMode);
  event.currentTarget.textContent = codeRevealMode[0].toUpperCase() + codeRevealMode.slice(1);
  $("#code-live-output")?.setAttribute("data-reveal", codeRevealMode);
});
$$(".dock-tab").forEach((el) =>
  el.addEventListener("click", () => openDock(el.dataset.tab)));

// Drag the dock's left edge. Width is clamped so the dock can never eat the
// chat column or shrink below a usable live view.
const DOCK_WIDTH_KEY = "oc-dock-width";
const dockWidth = Number(localStorage.getItem(DOCK_WIDTH_KEY));
if (Number.isFinite(dockWidth) && dockWidth >= 280) $("#dock").style.width = `${dockWidth}px`;

$("#dock-grip").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const dock = $("#dock");
  const grip = $("#dock-grip");
  const startX = event.clientX;
  const startWidth = dock.getBoundingClientRect().width;
  grip.classList.add("dragging");
  document.body.classList.add("dock-resizing");
  grip.setPointerCapture(event.pointerId);

  const onMove = (move) => {
    // Dragging left (smaller clientX) widens the dock — it is right-docked.
    const max = Math.max(320, window.innerWidth - 420);
    const next = Math.min(max, Math.max(280, startWidth + (startX - move.clientX)));
    dock.style.width = `${Math.round(next)}px`;
  };
  const onUp = () => {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", onUp);
    grip.removeEventListener("pointercancel", onUp);
    grip.classList.remove("dragging");
    document.body.classList.remove("dock-resizing");
    localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(dock.getBoundingClientRect().width)));
  };
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", onUp);
  grip.addEventListener("pointercancel", onUp);
});

let dockPath = "";
function dockPreview(relPath) {
  const raw = String(relPath || "").trim();
  setLiveContext("Live Preview", raw || "Generated app preview");
  if (!raw) return;
  openDock("browser");
  $("#dock-url").value = raw;
  // External URL (http(s):// or a bare domain like google.com) -> load directly.
  // Note: some sites block iframing (X-Frame-Options) and will appear blank —
  // for a guaranteed render of any site, ask the agent to browser_open + screenshot.
  const isUrl = /^https?:\/\//i.test(raw);
  const looksLikeDomain = !raw.includes("/") && /^[\w-]+\.[\w.-]+$/.test(raw) &&
    !/\.(html?|css|js|json|png|jpe?g|gif|svg|webp|txt|md)$/i.test(raw);
  if (isUrl || looksLikeDomain) {
    dockPath = "";
    $("#dock-frame").src = isUrl ? raw : `https://${raw}`;
    return;
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  dockPath = normalized;
  $("#dock-frame").src = `/preview/${normalized.split("/").map(encodeURIComponent).join("/")}?t=${Date.now()}`;
}
$("#dock-go").addEventListener("click", () => dockPreview($("#dock-url").value));
$("#dock-url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") dockPreview($("#dock-url").value);
});
$("#dock-reload").addEventListener("click", () => dockPath && dockPreview(dockPath));
$("#dock-edit-send").addEventListener("click", () => {
  const instruction = $("#dock-edit-input").value.trim();
  if (!instruction || !dockPath) return;
  $("#dock-edit-input").value = "";
  switchView("chat");
  sendMessage(`${dockPath} file ko edit karo: ${instruction}. Edit ke baad read_file se verify karo. Koi aur file mat chhedna.`);
});

function maybeAutoPreview(data) {
  const outputs = Array.isArray(data?.toolOutputs) ? data.toolOutputs : [];
  const safe = (p) => p && !p.startsWith("..") && !/^[a-zA-Z]:/.test(p) && !p.startsWith("/");
  for (let i = outputs.length - 1; i >= 0; i -= 1) {
    // Auto-open any HTML the agent just built — root-level (pillow-store/) or
    // under output/ — not only a fixed set of folders.
    const candidate = String(outputs[i]?.output?.path || outputs[i]?.input?.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (/\.html?$/i.test(candidate) && safe(candidate)) {
      dockPreview(candidate);
      return;
    }
    const screenshot = String(outputs[i]?.output?.screenshotRelPath || "").replace(/\\/g, "/");
    if (screenshot && safe(screenshot)) {
      dockPreview(screenshot);
      return;
    }
  }
}

// ─── My Browser: live view of the user's OWN Chrome (CDP) ───────────────────
//
// Every action here goes through the SAME browser_remote_* tools the agent
// calls, over /api/tools/run. That is deliberate: the panel and the agent then
// share one connection and one "current tab" instead of drifting apart.
//
// Frames arrive over SSE from /api/browser/live, which is Chrome's own
// Page.startScreencast pushed straight through. Polling screenshots gave a
// slideshow of aftermaths; this shows the click landing.
//
// The panel deliberately never calls browser_remote_state: _state DRAINS the
// user-navigation log, so reading it here would swallow the "the user moved
// this tab" warning before the agent ever saw it.

const mb = {
  connected: false,
  connection: "",
  tabId: "",
  tabs: [],
  metadata: null,   // last screencast metadata — CSS pixels, not device pixels
  stream: null,
  frames: 0,
  fpsAt: 0,
  cursorTimer: null,
  // true == the chrome://inspect route == the user's REAL profile, logins
  // included. false == the separate profile OmniClaw launched itself.
  realProfile: null,
  watchTimer: null,   // poll that waits for the user to flip Chrome's toggle
  agentTimer: null,   // poll that waits for the agent to open its first page
  starting: false,
};

async function runTool(tool, input = {}) {
  const body = await api("/api/tools/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, input }),
  });
  const result = body.result || {};
  if (result.error) throw new Error(result.hint ? `${result.error} — ${result.hint}` : result.error);
  return result;
}

function mbError(message) {
  const el = $("#mb-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function mbRenderTabs() {
  const select = $("#mb-tabs");
  select.innerHTML = mb.tabs
    .map((tab) => `<option value="${esc(tab.id)}">${esc(String(tab.title || tab.url || "(untitled)").slice(0, 70))}</option>`)
    .join("");
  if (mb.tabId) select.value = mb.tabId;
  if (!select.value && mb.tabs[0]) {
    select.value = mb.tabs[0].id;
    mb.tabId = mb.tabs[0].id;
  }
  const current = mb.tabs.find((tab) => tab.id === mb.tabId);
  if (current && document.activeElement !== $("#mb-url")) $("#mb-url").value = current.url || "";
}

function mbHost() {
  return {
    host: $("#mb-host").value.trim() || "localhost",
    port: Number($("#mb-port").value.trim()) || 9222,
  };
}

// ── The agent's pointer ────────────────────────────────────────────────────
// CDP dispatches SYNTHETIC input: no real mouse pointer moves, so nothing in
// the captured frames ever shows where the agent is acting. The overlay is
// driven from the action bus instead, which is the only place that knows.

function mbShowCursor(action) {
  const img = $("#mb-shot");
  const cursor = $("#mb-cursor");
  const meta = mb.metadata;
  // Scrolling has no element to point at, so the action carries no x/y. Draw
  // the pointer near the top of the viewport instead of skipping it entirely —
  // a visible scroll cue is what makes the panel read as a person browsing
  // rather than a page silently changing underneath.
  const isScroll = action.type === "scroll";
  if (!isScroll && (!Number.isFinite(action.x) || !Number.isFinite(action.y))) return;
  if (!img.clientWidth || !meta?.deviceWidth || !meta?.deviceHeight) return;

  const scaleX = img.clientWidth / meta.deviceWidth;
  const scaleY = img.clientHeight / meta.deviceHeight;
  const px = isScroll ? img.clientWidth / 2 : action.x * scaleX;
  const py = isScroll ? 14 : action.y * scaleY;
  cursor.style.left = `${img.offsetLeft + px}px`;
  cursor.style.top = `${img.offsetTop + py}px`;
  cursor.hidden = false;
  cursor.classList.toggle("mb-cursor-scroll", isScroll);
  $("#mb-cursor-label").textContent = mbActionLabel(action);

  // Restart the ripple by removing the class and forcing a reflow, otherwise a
  // second click in the same spot animates nothing.
  cursor.classList.remove("clicking");
  void cursor.offsetWidth;
  if (action.type === "click" || action.type === "type" || action.type === "key" || isScroll) {
    cursor.classList.add("clicking");
  }

  clearTimeout(mb.cursorTimer);
  mb.cursorTimer = setTimeout(() => { cursor.hidden = true; }, 6000);
}

function mbActionLabel(action) {
  const who = action.actor === "user" ? "you" : "agent";
  if (action.type === "type") {
    const shown = action.secret ? "••••••" : String(action.text || "").slice(0, 24);
    return `${who}: type "${shown}"`;
  }
  if (action.type === "navigate") return `${who}: ${String(action.url || "").slice(0, 48)}`;
  if (action.type === "scroll") {
    return `${who}: scroll ${action.direction === "up" ? "up" : "down"}`;
  }
  if (action.type === "key") return `${who}: press ${action.text || "Enter"}`;
  return `${who}: ${action.label || action.type || "action"}`;
}

function mbOnAction(action) {
  if (!action) return;
  setLiveContext("Using Browser", action.url || mbActionLabel(action), "mybrowser");
  mbShowCursor(action);
  activityRow(`browser.${action.type || "action"}`, mbActionLabel(action));
  if (action.type === "navigate" && action.url && document.activeElement !== $("#mb-url")) {
    $("#mb-url").value = action.url;
  }
  // Follow the agent into whichever tab it opened, so a task that spawns a new
  // tab does not leave the panel staring at the old one.
  if ($("#mb-follow").checked && action.tabId && action.tabId !== mb.tabId) {
    mb.tabId = action.tabId;
    mbStream();
  }
}
// ── The live stream ────────────────────────────────────────────────────────

function mbCloseStream() {
  if (mb.stream) {
    try { mb.stream.close(); } catch { /* already gone */ }
    mb.stream = null;
  }
  mbStopAgentWatch();
}

// Wait for the agent to open its first page, then attach. Polls the cheap
// listing route rather than holding a stream open against a 404 — the panel must
// be ready BEFORE the agent starts clicking, not after.
function mbStopAgentWatch() {
  clearTimeout(mb.agentTimer);
  mb.agentTimer = null;
}

async function mbWatchAgent() {
  mbStopAgentWatch();
  if (!$("#mb-follow")?.checked) return;
  if (dockTab !== "mybrowser" || $("#pane-mybrowser").offsetParent === null) return;
  const targets = await api("/api/browser/agent-targets").catch(() => null);
  if (targets && targets.targets && targets.targets.length) {
    mbStopAgentWatch();
    mbStream();
    return;
  }
  mb.agentTimer = setTimeout(() => { mbWatchAgent(); }, 1200);
}

function mbStream() {
  mbCloseStream();
  const { host, port } = mbHost();
  const params = new URLSearchParams({ host, port: String(port) });
  if (mb.tabId) params.set("tabId", mb.tabId);
  $("#mb-placeholder").hidden = false;
  $("#mb-placeholder").textContent = "Live view shuru ho raha hai…";

  // Follow mode watches the AGENT. It must work whether the agent is driving
  // the user's own Chrome (CDP) or its own Playwright Chromium (the default) —
  // otherwise the panel is a blank box for the entire task, which is the one
  // thing the live view exists to prevent. Try the agent stream first, fall
  // back to the real-browser stream, and only then to the manual connect card.
  const open = (url, onFail) => {
    const stream = new EventSource(url);
    mb.stream = stream;

    stream.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "frame") return mbOnFrame(msg);
      if (msg.type === "action") return mbOnAction(msg.action);
      if (msg.type === "ready") return mbOnReady(msg);
    };

    // A 404/503 (nothing to watch yet) closes the stream for good; a network
    // blip leaves it CONNECTING and EventSource retries on its own.
    stream.onerror = async () => {
      if (stream !== mb.stream) return;
      if (stream.readyState === EventSource.CONNECTING) {
        $("#mb-placeholder").hidden = false;
        $("#mb-placeholder").textContent = "Stream toot gaya — dobara jod rahe hain…";
        return;
      }
      const wasAgent = url.includes("/api/browser/agent-stream");
      mbCloseStream();
      if (onFail) return onFail();
      if (wasAgent) {
        // No agent page open yet — the panel must stay patient, not dead-end.
        $("#mb-placeholder").hidden = false;
        $("#mb-placeholder").textContent = "Agent jab browser kholega, yahin live dikhega…";
        mb.starting = false;
        mbWatchAgent();
        return;
      }
      const status = await api(`/api/browser/launch-status?host=${encodeURIComponent(host)}&port=${port}`).catch(() => null);
      if (status && !status.portOpen) {
        mbDisconnectUi();
        mbError("Browser ka debug port band ho gaya — Chrome me chrome://inspect ka toggle dobara ON karo.");
      } else {
        mbError("Live stream ruk gaya. Reconnect dabao.");
      }
    };
    return stream;
  };

  const cdpUrl = `/api/browser/live?${params.toString()}`;
  if ($("#mb-follow").checked) {
    open("/api/browser/agent-stream", () => open(cdpUrl));
  } else {
    open(cdpUrl);
  }
}

function mbOnReady(msg) {
  setLiveContext("Browser connected", msg.url || "Live browser", "mybrowser");
  mb.connected = true;
  mb.connection = msg.connection || mb.connection;
  mb.tabId = msg.tabId || mb.tabId;
  mb.tabs = msg.tabs || [];
  mb.frames = 0;
  mb.fpsAt = Date.now();
  // An agent-streamed page is headless Chromium, not the user's profile. Say so
  // rather than claiming it is "aapka Chrome — logins ke saath".
  if (msg.connection === "agent") {
    mb.realProfile = false;
    $("#mb-profile").hidden = false;
    $("#mb-profile").classList.remove("real");
    $("#mb-profile").textContent = "Agent ka browser";
    $("#mb-profile").title = "Ye wahi page hai jisme agent kaam kar raha hai — live frames + clicks.";
  }
  mbStopWatch();
  mbStopAgentWatch();
  mbRenderTabs();
  mbShowProfile();
  mbError("");
  $("#mb-connect").hidden = true;
  $("#mb-live").hidden = false;
  if (document.activeElement !== $("#mb-url")) $("#mb-url").value = msg.url || "";
}

function mbOnFrame(msg) {
  setLiveContext("Using Browser", mb.tabs.find((tab) => tab.id === mb.tabId)?.url || "Live browser", "mybrowser");
  mb.metadata = msg.metadata || mb.metadata;
  const img = $("#mb-shot");
  img.src = `data:image/jpeg;base64,${msg.data}`;
  img.hidden = false;
  $("#mb-placeholder").hidden = true;

  mb.frames += 1;
  const elapsed = Date.now() - mb.fpsAt;
  if (elapsed >= 1000) {
    $("#mb-fps").textContent = `${Math.round((mb.frames * 1000) / elapsed)} fps`;
    mb.frames = 0;
    mb.fpsAt = Date.now();
  }
}

// ── Connect / launch ───────────────────────────────────────────────────────

// The steps come from the SERVER (browser-launcher's MY_CHROME_STEPS) rather
// than being duplicated here, so the panel, the tool hint and the docs cannot
// drift apart when the Chrome ritual changes again.
function mbRenderSteps(status) {
  const guide = status?.useMyChrome;
  if (!guide) return;
  const list = $("#mb-steps");
  if (list.dataset.filled === "1") return;
  list.innerHTML = (guide.steps || []).map((step) => `<li>${esc(step)}</li>`).join("");
  list.dataset.filled = "1";
  if (guide.url) $("#mb-inspect-url").value = guide.url;
  if (guide.why) $("#mb-why").textContent = guide.why;
}

// realProfile === the chrome://inspect route === the user's own logins. Worth
// saying out loud, because the whole point of route 1 is that this is NOT some
// throwaway profile.
function mbShowProfile(status) {
  const badge = $("#mb-profile");
  const real = status?.realProfile ?? mb.realProfile;
  if (real === undefined || real === null) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.classList.toggle("real", Boolean(real));
  badge.textContent = real ? "aapka Chrome — logins ke saath" : "OmniClaw profile";
  badge.title = real
    ? "Yeh aapka asli Chrome hai (chrome://inspect se enable kiya) — jo sites logged-in hain wahi use hongi."
    : "Yeh OmniClaw ka alag profile hai. Aapke asli Chrome ke logins yahan nahi hain.";
}

async function mbConnect() {
  mbError("");
  $("#mb-connect-btn").disabled = true;
  try {
    const { host, port } = mbHost();
    // Connect through the tool so the panel and the agent share ONE connection
    // and one current tab; the stream then just attaches to it.
    const result = await runTool("browser_remote_connect", { host, port });
    mb.connection = result.connection || `${host}:${port}`;
    mb.tabId = (result.tabs || [])[0]?.id || "";
    if (result.localDebugging !== undefined) mb.realProfile = Boolean(result.localDebugging);
    activityRow("browser.remote.connected", `${result.browser || "browser"} — ${(result.tabs || []).length} tab(s)`);
    mbStopWatch();
    mbStream();
  } catch (error) {
    mbError(error.message);
  } finally {
    $("#mb-connect-btn").disabled = false;
  }
}

// ── Waiting for the user's Chrome ──────────────────────────────────────────
// The user has to flip a toggle inside Chrome, which OmniClaw cannot do for
// them. Polling turns that into a hands-free handoff: the instant the port
// answers we connect, so nobody has to guess when to press Connect.

function mbStopWatch() {
  clearTimeout(mb.watchTimer);
  mb.watchTimer = null;
}

async function mbWatch() {
  mbStopWatch();
  if (mb.connected || mb.stream) return;
  if (!$("#mb-autowatch")?.checked) { $("#mb-watch").textContent = ""; return; }
  if (dockTab !== "mybrowser" || $("#pane-mybrowser").offsetParent === null) {
    // Not visible: stop polling rather than hammering the port forever.
    return;
  }

  const { host, port } = mbHost();
  const status = await api(`/api/browser/launch-status?host=${encodeURIComponent(host)}&port=${port}`).catch(() => null);
  mbRenderSteps(status);
  const watch = $("#mb-watch");

  if (status?.portOpen) {
    mb.realProfile = Boolean(status.realProfile);
    watch.classList.add("live");
    watch.textContent = status.realProfile ? "Aapka Chrome mil gaya — jud rahe hain…" : "Debug port khula hai — jud rahe hain…";
    await mbConnect();
    return;
  }

  watch.classList.remove("live");
  watch.textContent = status && !status.canLaunch
    ? "Chrome/Edge/Brave is machine pe nahi mila."
    : `${host}:${port} ka intezaar… (Chrome me toggle ON karo)`;
  mb.watchTimer = setTimeout(mbWatch, 2000);
}

// Chrome 136+ silently ignores --remote-debugging-port on the default profile,
// so "just add the flag" cannot work. This launches a real Chrome on a
// persistent OmniClaw profile — sign in once there and it stays signed in.
// It is the FALLBACK: route 1 above reaches the user's actual logins.
async function mbLaunch() {
  mbError("");
  const button = $("#mb-launch-btn");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Launching…";
  try {
    const { host, port } = mbHost();
    const result = await runTool("browser_remote_launch", { host, port });
    mb.connection = result.connection || `${host}:${port}`;
    mb.tabId = (result.tabs || [])[0]?.id || "";
    mb.realProfile = Boolean(result.realProfile);
    activityRow("browser.remote.launched", `${result.browser || "chrome"} on :${port}`);
    if (result.realProfile) {
      mbError("");
    } else if (result.signedIn === false) {
      mbError("Naya profile hai — is window me ek baar login kar lo, phir hamesha logged-in rahega.");
    }
    mbStopWatch();
    mbStream();
  } catch (error) {
    mbError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Opening the pane should just work: attach to whatever the agent is doing,
// and only fall back to the real-Chrome ritual when there is nothing to watch.
async function mbAutoOpen() {
  if (mb.stream || mb.starting) return;
  mb.starting = true;
  try {
    // A hidden tab must not hold a screencast. Coming back to the tab
    // re-attaches (visibilitychange below), so nothing is lost by pausing.
    if (document.hidden) { mb.starting = false; return; }

    if ($("#mb-follow").checked) {
      // The common case by far: the agent opened a page, so mirror it. This is
      // what makes the panel work without the user ever touching a toggle.
      const targets = await api("/api/browser/agent-targets").catch(() => null);
      if (targets && targets.targets && targets.targets.length) {
        mbStream();
        return;
      }
      // Nothing open yet — stay patient instead of showing a dead-end card.
      $("#mb-placeholder").hidden = false;
      $("#mb-placeholder").textContent = "Agent jab browser kholega, yahin live dikhega…";
      mbWatchAgent();
      return;
    }

    const { host, port } = mbHost();
    const status = await api(`/api/browser/launch-status?host=${encodeURIComponent(host)}&port=${port}`).catch(() => null);
    mbRenderSteps(status);
    if (status?.portOpen) {
      mb.realProfile = Boolean(status.realProfile);
      mbStream();
    } else {
      // No browser yet — sit on the port instead of showing a dead-end panel.
      mbWatch();
      if (status && !status.canLaunch) mbError("Chrome/Edge/Brave nahi mila is machine pe.");
    }
  } finally {
    mb.starting = false;
  }
}

// ── Stream lifecycle tied to the TAB, not just the panel ────────────────────
//
// The panel being open was never the right trigger. A screencast is a
// permanent CPU charge on the browser, so it runs exactly while someone can
// see it and stops the moment they cannot. These handlers are the difference
// between "the fan runs while I watch the agent" and "the fan runs forever".
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (typeof mbCloseStream === "function") mbCloseStream();
    return;
  }
  if (typeof mbAutoOpen === "function" && dockTab === "mybrowser" && $("#dock") && !$("#dock").hidden) {
    mbAutoOpen();
  }
});
window.addEventListener("pagehide", () => {
  if (typeof mbCloseStream === "function") mbCloseStream();
});
window.addEventListener("beforeunload", () => {
  if (typeof mbCloseStream === "function") mbCloseStream();
});

function mbDisconnectUi() {
  mbCloseStream();
  mb.connected = false;
  mb.tabs = [];
  mb.tabId = "";
  mb.metadata = null;
  clearTimeout(mb.cursorTimer);
  $("#mb-live").hidden = true;
  $("#mb-connect").hidden = false;
  $("#mb-shot").hidden = true;
  $("#mb-cursor").hidden = true;
  $("#mb-fps").textContent = "";
  $("#mb-placeholder").hidden = false;
  // Back to the connect card — start waiting for the port again so a Chrome
  // restart (which drops the toggle) reconnects on its own.
  mbWatch();
}

$("#mb-launch-btn").addEventListener("click", mbLaunch);
$("#mb-connect-btn").addEventListener("click", mbConnect);
$("#mb-port").addEventListener("keydown", (event) => { if (event.key === "Enter") mbConnect(); });
$("#mb-copy-inspect").addEventListener("click", async (event) => {
  await copyText($("#mb-inspect-url").value);
  const button = event.currentTarget;
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = original; }, 1400);
});
$("#mb-autowatch").addEventListener("change", (event) => {
  if (event.target.checked) mbWatch();
  else { mbStopWatch(); $("#mb-watch").textContent = ""; }
});
$("#mb-refresh").addEventListener("click", () => mbStream());
$("#mb-tabs").addEventListener("change", (event) => {
  mb.tabId = event.target.value;
  mbStream();
});

$("#mb-go").addEventListener("click", mbNavigate);
$("#mb-url").addEventListener("keydown", (event) => { if (event.key === "Enter") mbNavigate(); });
async function mbNavigate() {
  const url = $("#mb-url").value.trim();
  if (!url) return;
  try {
    await runTool("browser_remote_navigate", { url, actor: "user", ...(mb.tabId ? { tabId: mb.tabId } : {}) });
    mbError("");
  } catch (error) {
    mbError(error.message);
  }
}

// Click-through: translate a click on the <img> into a real click in the page.
// Screencast metadata reports the viewport in CSS pixels, which is exactly what
// CDP's Input domain wants — so this is a plain proportion, no dpr maths.
$("#mb-shot").addEventListener("click", async (event) => {
  const img = $("#mb-shot");
  const meta = mb.metadata;
  if (!img.clientWidth || !meta?.deviceWidth) return;
  const rect = img.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * meta.deviceWidth);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * meta.deviceHeight);
  try {
    await runTool("browser_remote_click", { x, y, actor: "user", ...(mb.tabId ? { tabId: mb.tabId } : {}) });
    mbError("");
  } catch (error) {
    mbError(error.message);
  }
});

// Type into whatever was just clicked, so there is no selector to write.
$("#mb-type").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const text = event.target.value;
  if (!text) return;
  event.target.value = "";
  try {
    await runTool("browser_remote_type", { selector: ":focus", text, actor: "user", ...(mb.tabId ? { tabId: mb.tabId } : {}) });
    mbError("");
  } catch (error) {
    mbError(`${error.message} — pehle live view me field pe click karo.`);
  }
});

$("#mb-disconnect").addEventListener("click", async () => {
  mbCloseStream();
  try {
    await runTool("browser_remote_disconnect", mb.connection ? { connection: mb.connection } : {});
  } catch { /* the browser may already be gone; the UI resets either way */ }
  mbDisconnectUi();
});

// ─── Right Dock Tab Switching ──────────────────────────────────────────────

let currentDockTab = "workspace";

function switchDockTab(tabName) {
  currentDockTab = tabName;
  $$(".dock-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));

  const paneMap = {
    workspace: "#pane-workspace",
    mybrowser: "#pane-mybrowser",
    browser: "#pane-browser",
    terminal: "#pane-terminal",
    code: "#pane-code",
    activity: "#pane-activity",
  };

  Object.values(paneMap).forEach((selector) => {
    const pane = $(selector);
    if (pane) pane.classList.remove("active");
  });

  const targetPane = $(paneMap[tabName] || `#pane-${tabName}`);
  if (targetPane) targetPane.classList.add("active");

  if (tabName === "mybrowser" && typeof mbAutoOpen === "function") {
    mbAutoOpen();
  }
}

$$(".dock-tab").forEach((tab) => {
  tab.addEventListener("click", () => switchDockTab(tab.dataset.tab));
});

// ─── Boot ───────────────────────────────────────────────────────────────────

async function boot(attempt = 0) {
  setConnection("connecting");
  setTaskState("IDLE");
  try { renderFilesPanel(); } catch { /* optional */ }
  await Promise.allSettled([loadStatus(), loadAgents(), loadSessions(), loadRepoPanel()]);
  try { setModeChip(detectAccessMode(await fetchConfig())); } catch { /* chip default */ }
  if (attempt < 3 && !$$(".session-item").length) {
    setTimeout(() => loadSessions(), 2500);
  }
}
boot();
setInterval(loadStatus, 15000);
setInterval(() => { if (!state.running) loadRepoPanel().catch(() => {}); }, 45000);
