// T2.1 context diet — priority budget allocator (pure, dependency-free).
// Total ≤ 28000 chars; lower priorities truncate first; memory (pri 3) is
// RESERVED and can never starve. See docs/AGENT_DESIGN_V2.md D1.

import fs from "node:fs";
import path from "node:path";

export const V2_TOTAL_CAP = 28000;
export const V2_MEMORY_FLOOR = 6000;
// Model-aware ceiling: the diet was designed for small windows. Feeding a
// 1M-token model only 28k chars (~7k tokens) starves it — live 2026-09-23:
// used 25054/28000 with 311 items omitted EVERY turn, so the model kept
// re-discovering state instead of building. Scale at ~0.5 chars per context
// token (≈12.5% of the window in tokens), floor = the designed diet,
// ceiling = 120k chars (~30k tokens) so focus and cost stay bounded.
export const V2_TOTAL_CAP_CEILING = 120000;
export function modelAwareCap(base, contextTokens = 0, ceiling = 160000) {
  const tokens = Number(contextTokens) || 0;
  if (!(tokens > 0)) return base;
  return Math.floor(Math.min(Math.max(base, tokens * 0.5), ceiling));
}

export const V2_CAPS = {
  identity: 3500, // SOUL 1200 + IDENTITY 800 + PERSONALITY 800 + USER 700
  identityFiles: { "SOUL.MD": 1200, "IDENTITY.MD": 800, "PERSONALITY.MD": 800, "USER.MD": 700 },
  hardConstraints: 1200,
  memoryActive: 2500,
  memoryLongTerm: 2000,
  memoryNotes: 1500,
  loopContract: 2000,
  plan: 1000,
  skills: 1500,
  skillsTop: 5,
  snapshotTree: 2500,
  snapshotReadme: 1500,
  mcp: 2000,
};

export const IDENTITY_FILES = ["SOUL.MD", "IDENTITY.MD", "PERSONALITY.MD", "USER.MD"];

export function trimMarker(what, n) {
  return `[... ${n} chars trimmed from ${what}: read it with read_file for the rest]`;
}

// Tail-window: durable facts accumulate at file end; newest-last wins.
// scale (>1) grows the per-file cap with the model-aware total budget.
export function capIdentityFile(name, content, scale = 1) {
  const base = V2_CAPS.identityFiles[String(name || "").toUpperCase()] || 700;
  const cap = Math.floor(base * Math.max(1, Number(scale) || 1));
  const text = String(content || "");
  if (text.length <= cap) return { text, trimmed: 0 };
  return {
    text: text.slice(-cap).trimStart() + "\n" + trimMarker(name, text.length - cap),
    trimmed: text.length - cap,
  };
}

// Workspace snapshot: tree top-2 levels + README head. Never throws.
// scale (>1) grows the tree/readme caps with the model-aware total budget.
export function buildSnapshot(workspaceDir, scale = 1) {
  const s = Math.max(1, Number(scale) || 1);
  const treeCap = Math.floor(V2_CAPS.snapshotTree * s);
  const readmeCap = Math.floor(V2_CAPS.snapshotReadme * s);
  const tree = [];
  let treeChars = 0;
  const push = (line) => {
    if (treeChars + line.length + 1 > treeCap) return false;
    tree.push(line);
    treeChars += line.length + 1;
    return true;
  };
  try {
    const root = String(workspaceDir || "");
    if (!root || !fs.existsSync(root)) {
      return { tree: "(no workspace)", readme: "", treeTrimmed: true, readmeTrimmed: false };
    }
    let treeTrimmed = false;
    const top = fs.readdirSync(root, { withFileTypes: true });
    let shown = 0;
    for (const entry of top) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (shown >= 60) { treeTrimmed = true; break; }
      shown++;
      const rel = entry.name + (entry.isDirectory() ? "/" : "");
      if (!push(rel)) { treeTrimmed = true; break; }
      if (entry.isDirectory() && shown <= 30) {
        try {
          const sub = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
          let subShown = 0;
          for (const s of sub) {
            if (s.name.startsWith(".")) continue;
            if (subShown >= 12) { treeTrimmed = true; break; }
            subShown++;
            if (!push(`  ${s.name}${s.isDirectory() ? "/" : ""}`)) { treeTrimmed = true; break; }
          }
        } catch { /* unreadable dir — skip */ }
      }
    }
    let readme = "";
    let readmeTrimmed = false;
    try {
      const names = fs.readdirSync(root);
      const hit = names.find((n) => /^readme\.md$/i.test(n));
      if (hit) {
        const full = fs.readFileSync(path.join(root, hit), "utf8");
        if (full.length > readmeCap) {
          readme = full.slice(0, readmeCap).trimEnd() + "\n" + trimMarker(hit, full.length - readmeCap);
          readmeTrimmed = true;
        } else {
          readme = full;
        }
      }
    } catch { /* no readable README — fine */ }
    return { tree: tree.join("\n") || "(empty workspace)", readme, treeTrimmed, readmeTrimmed };
  } catch {
    return { tree: "(unreadable workspace)", readme: "", treeTrimmed: true, readmeTrimmed: false };
  }
}

// Manuals one-liner for the files the diet drops from the prompt.
export function manualsLine(files = []) {
  const names = [];
  for (const f of files || []) {
    const n = String(f.name || "").toUpperCase();
    if (!IDENTITY_FILES.includes(n) && /^[A-Z0-9_]+\.(MD|JSON)$/.test(n)) {
      if (!names.includes(f.name)) names.push(f.name);
    }
  }
  if (!names.length) return "";
  return `Manuals available via read_file: ${names.join(", ")}`;
}

// Priority allocator over pre-measured sections.
// sections: [{id, chars}] in priority order (memory sections carry .memory=true).
// Returns {kept: Map(id->chars), truncated: string[], used, memoryKept}.
export function allocate(sections = [], totalCap = V2_TOTAL_CAP, memoryFloor = V2_MEMORY_FLOOR) {
  const kept = new Map();
  const truncated = [];
  let used = 0;
  let memoryKept = 0;
  const take = (id, want, cap) => {
    const room = Math.max(0, totalCap - used);
    const give = Math.max(0, Math.min(want, cap, room));
    kept.set(id, give);
    if (give < want) truncated.push(id);
    used += give;
    return give;
  };
  // Pass 1: everything EXCEPT memory and the rest-pool, in priority order.
  // (Caller orders: identity, constraints, loopContract, plan, skills,
  // workspace-snapshot, mcp.)
  for (const s of sections) {
    if (s.memory || s.rest) continue;
    take(s.id, s.chars, s.cap);
  }
  // Pass 2: memory floor — guaranteed, never truncated for the rest pool.
  for (const s of sections) {
    if (!s.memory) continue;
    const give = take(s.id, s.chars, s.cap);
    memoryKept += give;
  }
  // Pass 3: rest pool shares whatever remains.
  for (const s of sections) {
    if (!s.rest) continue;
    take(s.id, s.chars, s.cap);
  }
  return { kept, truncated, used, memoryKept };
}
