// Review tab: git status + diff + stage/unstage/revert.
// B1 routes: GET /api/git/status, GET /api/git/diff, POST stage/unstage/revert.
// Legacy GET /api/workspace/git is left untouched.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { gitStatus, gitDiff, gitStage, gitUnstage, gitRevert } from "../api.js";
import { toast } from "../ui/toast.js";
import { middleEllipsis } from "../utils/path.js";

const STATUS_COLOR = { M: "mod", A: "add", D: "del", R: "ren", U: "conf", "?": "new" };

function normRel(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function parseDiff(patch) {
  // [{header, lines:[{t:' '|'+'|'-', old, new, text}]}]
  const hunks = [];
  let cur = null;
  let oldN = 0;
  let newN = 0;
  for (const raw of String(patch || "").split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      oldN = Number(m[1]);
      newN = Number(m[2]);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const first = raw[0];
    if (first === "+") {
      cur.lines.push({ t: "+", old: null, new: newN++, text: raw.slice(1) });
    } else if (first === "-") {
      cur.lines.push({ t: "-", old: oldN++, new: null, text: raw.slice(1) });
    } else if (first === " ") {
      cur.lines.push({ t: " ", old: oldN++, new: newN++, text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      cur.lines.push({ t: " ", old: null, new: null, text: raw });
    }
  }
  return hunks;
}

export function mountReviewTab(el, ctx, arg = {}) {
  el.innerHTML = "";
  const wrap = h("div", { class: "rev" });
  const head = h("div", { class: "tab-head" },
    h("span", { class: "tab-title", text: "Review" }),
    h("span", { class: "tab-actions" }));
  const body = h("div", { class: "rev-body" });
  wrap.append(head, body);
  el.append(wrap);
  const actions = head.querySelector(".tab-actions");

  const state = {
    status: null,
    files: [],
    selected: (arg && arg.path) || "",
    filter: "",
    loading: false,
    dead: false,
  };

  function setActions(extra) {
    actions.innerHTML = "";
    const ref = h("button", { class: "icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh", html: "⟳" });
    ref.addEventListener("click", () => load(true));
    actions.append(ref);
    if (extra) actions.append(extra);
  }

  function centerNote(title, sub) {
    body.innerHTML = "";
    body.append(h("div", { class: "panel-empty" }, h("strong", { text: title }), sub ? h("p", { class: "muted small", text: sub }) : null));
  }

  async function load(manual) {
    if (state.dead || state.loading) return;
    state.loading = true;
    if (manual) centerNote("Loading…", "");
    try {
      const st = await gitStatus();
      if (!st || !st.isRepo) {
        const wsPath = (ctx.workspace && ctx.workspace.activePath) || "";
        centerNote("Not a git repository", wsPath);
        setActions(null);
        state.loading = false;
        return;
      }
      state.status = st;
      state.files = Array.isArray(st.files) ? st.files : [];
      if (!state.selected || !state.files.some((f) => normRel(f.path) === normRel(state.selected))) {
        const first = state.files[0];
        state.selected = first ? first.path : "";
      }
      paint();
    } catch (e) {
      centerNote("Couldn't load git status", e.message);
    } finally {
      state.loading = false;
    }
  }

  function summaryText() {
    const s = (state.status && state.status.summary) || { added: 0, deleted: 0 };
    return `+${s.added || 0} −${s.deleted || 0}`;
  }

  function paint() {
    const st = state.status;
    body.innerHTML = "";
    setActions(null);
    if (!st) return;
    const branch = h("span", { class: "branch-pill", title: st.branch || "" },
      h("span", { text: "⑂" }), h("span", { text: st.branch || "?" }));
    const ab = (st.ahead || st.behind)
      ? h("span", { class: "muted small", text: `+${st.ahead || 0}/−${st.behind || 0}` })
      : null;
    const sum = h("span", { class: "diff-sum", text: summaryText() });
    const hb = h("div", { class: "rev-top" }, branch, ab, sum);
    const act = h("span", null);
    const hasFiles = state.files.length > 0;
    if (hasFiles) {
      const sa = h("button", { class: "mini-btn", type: "button", text: "Stage all" });
      sa.addEventListener("click", () => stageAll(false));
      const ua = h("button", { class: "mini-btn", type: "button", text: "Unstage all" });
      ua.addEventListener("click", () => stageAll(true));
      act.append(sa, ua);
      const actionsEl = head.querySelector(".tab-actions");
      actionsEl.append(act);
    }
    body.append(hb);

    const split = h("div", { class: "rev-split" });
    const left = h("div", { class: "rev-files" });
    const filter = h("input", {
      type: "text", placeholder: "Filter files…", "aria-label": "Filter files",
      value: state.filter,
    });
    filter.addEventListener("input", () => {
      state.filter = filter.value;
      paintList(listHost);
    });
    const listHost = h("div", { class: "rev-list" });
    left.append(filter, listHost);
    const right = h("div", { class: "rev-diff" });
    split.append(left, right);
    body.append(split);
    paintList(listHost);
    paintDiff(right);
  }

  function grouped() {
    const needle = state.filter.trim().toLowerCase();
    const match = (f) => !needle || String(f.path || "").toLowerCase().includes(needle);
    const staged = [];
    const changes = [];
    const untracked = [];
    for (const f of state.files) {
      if (!match(f)) continue;
      if (f.status === "?") untracked.push(f);
      else if (f.staged) staged.push(f);
      else changes.push(f);
    }
    return [["Staged", staged], ["Changes", changes], ["Untracked", untracked]];
  }

  function paintList(host) {
    host.innerHTML = "";
    const root = (state.status && state.status.root) || "";
    for (const [label, files] of grouped()) {
      if (!files.length) continue;
      host.append(h("div", { class: "pop-label", text: `${label} (${files.length})` }));
      for (const f of files) {
        const row = h("div", {
          class: `rev-file${normRel(f.path) === normRel(state.selected) ? " active" : ""}`,
          role: "button", tabindex: "0",
          title: root ? `${root}\\${String(f.path).replace(/\//g, "\\")}` : f.path,
        });
        const badge = h("span", { class: `st-badge ${STATUS_COLOR[f.status] || "mod"}`, text: f.status });
        const name = h("span", { class: "truncate", text: middleEllipsis(f.path, 40) });
        name.title = f.path;
        const box = h("input", { type: "checkbox", title: f.staged ? "Unstage" : "Stage", "aria-label": `${f.staged ? "Unstage" : "Stage"} ${f.path}` });
        box.checked = !!f.staged;
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", async () => {
          box.disabled = true;
          try {
            if (box.checked) await gitStage(f.path);
            else await gitUnstage(f.path);
            scheduleLoad();
          } catch (err) {
            box.checked = !box.checked;
            toast(`Stage failed: ${err.message}`, "error");
          } finally {
            box.disabled = false;
          }
        });
        const rev = h("button", { class: "mini-icon", type: "button", title: "Revert file", "aria-label": `Revert ${f.path}`, text: "↺" });
        rev.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!window.confirm(`Revert ${f.path} to HEAD? Local changes will be lost.`)) return;
          try {
            await gitRevert(f.path);
            toast("Reverted", "success");
            scheduleLoad();
          } catch (err) {
            toast(`Revert failed: ${err.message}`, "error");
          }
        });
        const open = h("button", { class: "mini-icon", type: "button", title: "Open in editor", "aria-label": `Open ${f.path} in editor`, text: "✎" });
        open.addEventListener("click", (e) => {
          e.stopPropagation();
          try { ctx.panel.openFiles(absFor(f.path)); } catch {}
        });
        const hov = h("span", { class: "rev-hov" }, rev, open);
        row.append(badge, name, box, hov);
        const pick = () => {
          state.selected = f.path;
          paint();
        };
        row.addEventListener("click", pick);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
        });
        host.append(row);
      }
    }
    if (!host.children.length) {
      host.append(h("div", { class: "muted small", text: state.filter ? "No matches." : "Working tree clean." }));
    }
  }

  function absFor(relPath) {
    const root = (state.status && state.status.root) || "";
    if (!root) return relPath;
    return `${root.replace(/[/\\]+$/, "")}\\${String(relPath).replace(/\//g, "\\")}`;
  }

  async function stageAll(unstage) {
    try {
      const files = state.files.filter((f) => (unstage ? f.staged : !f.staged && f.status !== "?") || (!unstage && !f.staged));
      for (const f of files) {
        if (unstage) await gitUnstage(f.path);
        else if (f.status !== "?") await gitStage(f.path);
      }
      scheduleLoad();
    } catch (e) {
      toast(`Bulk ${unstage ? "unstage" : "stage"} failed: ${e.message}`, "error");
    }
  }

  async function paintDiff(host) {
    host.innerHTML = "";
    const f = state.files.find((x) => normRel(x.path) === normRel(state.selected));
    if (!f) {
      host.append(h("div", { class: "panel-empty small", text: state.files.length ? "Select a file." : "Nothing to review." }));
      return;
    }
    const idx = state.files.indexOf(f);
    const bar = h("div", { class: "diff-bar" });
    const prev = h("button", { class: "mini-icon", type: "button", title: "Previous file", text: "‹" });
    const next = h("button", { class: "mini-icon", type: "button", title: "Next file", text: "›" });
    prev.disabled = idx <= 0;
    next.disabled = idx >= state.files.length - 1;
    prev.addEventListener("click", () => { state.selected = state.files[idx - 1].path; paint(); });
    next.addEventListener("click", () => { state.selected = state.files[idx + 1].path; paint(); });
    const open = h("button", { class: "mini-btn", type: "button", text: "Open in editor" });
    open.addEventListener("click", () => { try { ctx.panel.openFiles(absFor(f.path)); } catch {} });
    bar.append(
      h("strong", { class: "truncate", text: f.path, title: f.path }),
      h("span", { class: "diff-sum small", text: "" }),
      prev, next, open,
    );
    host.append(bar);
    const view = h("div", { class: "diff-view" }, h("div", { class: "muted small", text: "Loading diff…" }));
    host.append(view);
    try {
      const d = await gitDiff(f.path, !!f.staged);
      const sumEl = bar.querySelector(".diff-sum");
      if (sumEl) sumEl.textContent = `+${d.added || 0} −${d.deleted || 0}`;
      view.innerHTML = "";
      if (d.binary) {
        view.append(h("div", { class: "panel-empty small", text: "Binary file." }));
        return;
      }
      if (d.truncated) {
        view.append(h("div", { class: "trunc-banner", text: "Diff truncated." }));
      }
      const hunks = parseDiff(d.patch || "");
      if (!hunks.length) {
        view.append(h("div", { class: "panel-empty small", text: d.patch ? "No hunks parsed." : "No differences." }));
        return;
      }
      for (const hk of hunks) {
        const table = h("div", { class: "hunk" });
        table.append(h("div", { class: "hunk-head", text: hk.header }));
        for (const ln of hk.lines) {
          const row = h("div", { class: `dl ${ln.t === "+" ? "add" : ln.t === "-" ? "del" : "ctx"}` });
          row.append(
            h("span", { class: "gutter", text: ln.old == null ? "" : String(ln.old) }),
            h("span", { class: "gutter", text: ln.new == null ? "" : String(ln.new) }),
            h("span", { class: "code", text: ln.text }),
          );
          table.append(row);
        }
        view.append(table);
      }
    } catch (e) {
      view.innerHTML = "";
      view.append(h("div", { class: "panel-empty small", text: `Diff failed: ${e.message}` }));
    }
  }

  let refreshTimer = null;
  function scheduleLoad() {
    if (state.dead) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load(false), 800);
  }

  const onFs = () => scheduleLoad();
  const onRun = () => scheduleLoad();
  window.addEventListener("oc:fs-changed", onFs);
  window.addEventListener("oc:run-done", onRun);
  document.addEventListener("visibilitychange", onFs);

  load(false);

  return {
    update(c) {
      // Re-selected file from a thread step row.
      if (c && c.arg && c.arg.path && normRel(c.arg.path) !== normRel(state.selected)) {
        const hit = state.files.find((f) => {
          const a = normRel(f.path);
          const b = normRel(c.arg.path);
          return a === b || a.endsWith(`/${b.split("/").pop()}`) || b.endsWith(`/${a.split("/").pop()}`);
        });
        if (hit) {
          state.selected = hit.path;
          paint();
        } else {
          state.selected = c.arg.path;
          scheduleLoad();
        }
      }
    },
    unmount() {
      state.dead = true;
      clearTimeout(refreshTimer);
      window.removeEventListener("oc:fs-changed", onFs);
      window.removeEventListener("oc:run-done", onRun);
      document.removeEventListener("visibilitychange", onFs);
    },
  };
}
