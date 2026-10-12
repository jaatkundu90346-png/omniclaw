// Smoke test: SemanticMemory single-dimension guard (iteration 13).
// Bug: an embeddings-API flap (1536-dim up, 256-dim lexical fallback down)
// fragmented the index into two dimensions; cosineSimilarity returns 0 across
// dims, so a query could only ever match one subset — silent partial recall
// loss. Fix: pin the store to one dimension; skip conflicting-dim adds.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { SemanticMemory } = await import(pathToFileURL(path.join(ROOT, "src/core/semantic-memory.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

// Controllable embedder: `dim` decides the vector length it returns. A simple
// deterministic vector so same-text embeddings match themselves.
const embedder = {
  dim: 8,
  async embed(text = "") {
    const v = new Array(this.dim).fill(0);
    for (let i = 0; i < String(text).length; i += 1) v[i % this.dim] += (text.charCodeAt(i) % 7) + 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-semdim-"));
const mem = new SemanticMemory({ rootDir: tmp, embedder });

// ── 1. First embeddings pin the canonical dimension ─────────────────────────
await mem.addText("a1", "alpha login token flow");
await mem.addText("a2", "beta deploy runbook");
check("canonical dimension pinned to 8", mem.canonicalDimension() === 8, String(mem.canonicalDimension()));
check("two entries indexed", mem.embeddings.size === 2, String(mem.embeddings.size));

// ── 2. API "flap": embedder now returns a DIFFERENT dimension → skipped ─────
embedder.dim = 4; // simulate fallback/degraded embedder
const added = await mem.addText("a3", "gamma conflicting dim item").catch(() => null);
check("conflicting-dim add skipped (not stored)", !mem.embeddings.has("a3"), JSON.stringify([...mem.embeddings.keys()]));
const info1 = mem.dimensionInfo();
check("dimensionInfo: store NOT fragmented", info1.fragmented === false, JSON.stringify(info1));
check("dimensionInfo: conflict counted", info1.conflictsSkipped >= 1, JSON.stringify(info1));

// ── 3. Search at wrong dim finds nothing; at canonical dim finds matches ────
const wrongDimResults = await mem.searchText("alpha login", 10, 0.1); // embedder.dim=4 now → query is 4-dim
check("query at conflicting dim returns nothing (no garbage)", wrongDimResults.length === 0, JSON.stringify(wrongDimResults.map((r) => r.id)));

embedder.dim = 8; // API recovers
const goodResults = await mem.searchText("alpha login token", 10, 0.1);
check("query at canonical dim finds the canonical entry", goodResults.some((r) => r.id === "a1"), JSON.stringify(goodResults.map((r) => r.id)));

// ── 4. backfill skips conflicting-dim items, reports the count ──────────────
embedder.dim = 4; // degraded again during a backfill
const bf = await mem.backfillFromItems([
  { id: "b1", text: "delta item during degraded embedder", layer: "longTerm", title: "d" },
], { max: 10 });
check("backfill indexed nothing while degraded", bf.indexed === 0, JSON.stringify(bf));
check("backfill reports skippedDimensionConflicts", (bf.skippedDimensionConflicts || 0) >= 1, JSON.stringify(bf));
check("store still single-dimension after degraded backfill", mem.dimensionInfo().fragmented === false, JSON.stringify(mem.dimensionInfo()));

// ── 5. When embedder recovers, the same item indexes fine ───────────────────
embedder.dim = 8;
const bf2 = await mem.backfillFromItems([
  { id: "b1", text: "delta item during degraded embedder", layer: "longTerm", title: "d" },
], { max: 10 });
check("recovered backfill indexes the previously-skipped item", bf2.indexed === 1 && mem.embeddings.has("b1"), JSON.stringify(bf2));
check("final store is single-dimension (dim 8 everywhere)", mem.dimensionInfo().fragmented === false && mem.canonicalDimension() === 8, JSON.stringify(mem.dimensionInfo()));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
