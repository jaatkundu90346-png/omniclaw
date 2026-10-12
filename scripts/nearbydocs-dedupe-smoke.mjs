// Smoke test: nearby-doc once-per-run dedup (iteration 5 — goose/Hermes
// SubdirectoryHintTracker pattern). Module docs (AGENTS/ARCHITECTURE excerpts)
// attach to the FIRST read in an area only; repeat reads in the same folder no
// longer re-bill the same excerpt tokens every round.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { dedupeNearbyDocs } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

const surfaced = new Set();

// First read in a module → docs attach and are remembered.
let out = { path: "game/src/core/Game.ts", content: "...", nearbyDocs: [
  { path: "game/AGENTS.md", excerpt: "module rules" },
  { path: "game/src/ARCHITECTURE.md", excerpt: "arch" },
] };
out = dedupeNearbyDocs(out, surfaced);
check("first read: both docs kept", out.nearbyDocs?.length === 2, JSON.stringify(out.nearbyDocs));

// Second read in the same folder → same docs stripped entirely.
out = { path: "game/src/core/Types.ts", content: "...", nearbyDocs: [
  { path: "game/AGENTS.md", excerpt: "module rules" },
  { path: "game/src/ARCHITECTURE.md", excerpt: "arch" },
] };
out = dedupeNearbyDocs(out, surfaced);
check("repeat read: docs stripped (no re-billing)", out.nearbyDocs === undefined, JSON.stringify(out.nearbyDocs));

// New area → only the UNSEEN doc attaches.
out = { path: "game/src/ui/HUD.ts", content: "...", nearbyDocs: [
  { path: "game/AGENTS.md", excerpt: "module rules" },
  { path: "game/src/ui/CONSTRAINTS.md", excerpt: "ui rules" },
] };
out = dedupeNearbyDocs(out, surfaced);
check("new area: only unseen doc kept", out.nearbyDocs?.length === 1 && out.nearbyDocs[0].path === "game/src/ui/CONSTRAINTS.md", JSON.stringify(out.nearbyDocs));

// Outputs without nearbyDocs pass through untouched (no crash, no mutation).
const plain = { path: "x.js", content: "code" };
check("no-docs output untouched", dedupeNearbyDocs(plain, surfaced) === plain && plain.nearbyDocs === undefined);
check("null output safe", dedupeNearbyDocs(null, surfaced) === null);
check("missing set safe", dedupeNearbyDocs({ nearbyDocs: [{ path: "a" }] }, null)?.nearbyDocs?.length === 1);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
