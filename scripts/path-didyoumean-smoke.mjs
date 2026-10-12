// Smoke test: file-path "did you mean" self-healing (iteration 4).
// Real-run failure: read_file/edit with a wrong path got a raw ENOENT and the
// model spun retrying guessed variations. Now: File-not-found errors suggest
// real candidate paths (exact basename first) + tell the model how to search.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { FileStore } = await import(pathToFileURL(path.join(ROOT, "src/core/file-store.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

// Synthetic workspace mirroring the real failure (neon-open-world/src/core/Game.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-dym-"));
fs.mkdirSync(path.join(tmp, "game/src/core"), { recursive: true });
fs.mkdirSync(path.join(tmp, "game/src/systems"), { recursive: true });
fs.mkdirSync(path.join(tmp, "node_modules/junk"), { recursive: true });
fs.writeFileSync(path.join(tmp, "game/src/core/Game.ts"), "export class Game {}\n");
fs.writeFileSync(path.join(tmp, "game/src/systems/PhysicsSystem.ts"), "export class PhysicsSystem {}\n");
fs.writeFileSync(path.join(tmp, "node_modules/junk/Game.ts"), "// decoy — must not be suggested\n");
const store = new FileStore(tmp);

// Wrong path (missing folder segment) → error names the real path.
let err = null;
try { store.readText("src/core/Game.ts", 64 * 1024); } catch (e) { err = e; }
check("wrong path throws friendly error", /File not found: src\/core\/Game\.ts/.test(String(err?.message)), err?.message);
check("did-you-mean suggests the real path", String(err?.message).includes("game/src/core/Game.ts"), err?.message);
check("node_modules decoy NOT suggested", !String(err?.message).includes("node_modules"), err?.message);
check("guides to list_files/search_text, no blind retries", /list_files|search_text/.test(String(err?.message)) && /do NOT retry/.test(String(err?.message)), err?.message);

// Case drift in the basename still finds it.
err = null;
try { store.readText("game.ts", 64 * 1024); } catch (e) { err = e; }
check("case-insensitive basename match", String(err?.message).includes("game/src/core/Game.ts"), err?.message);

// Totally unknown file → clean error, no bogus suggestions.
err = null;
try { store.readText("DoesNotExistAnywhere.xyz", 64 * 1024); } catch (e) { err = e; }
check("unknown file: no phantom suggestions", /File not found/.test(String(err?.message)) && !/Did you mean/.test(String(err?.message)), err?.message);

// Directory instead of file → actionable message.
err = null;
try { store.readText("game/src", 64 * 1024); } catch (e) { err = e; }
check("directory read: clear 'is a directory' error", /is a directory/.test(String(err?.message)), err?.message);

// Existing file still reads normally (no behavior change on the happy path).
const ok = store.readText("game/src/core/Game.ts", 64 * 1024);
check("happy path unchanged", ok.content.includes("export class Game"), JSON.stringify(ok).slice(0, 120));

// Real repo sanity: a truly wrong path suggests the real Game.ts.
const realStore = new FileStore(ROOT);
err = null;
try { realStore.readText("src/core/Game.ts", 64 * 1024); } catch (e) { err = e; }
check("real repo: suggests neon-open-world/src/core/Game.ts", String(err?.message).includes("neon-open-world/src/core/Game.ts"), err?.message);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
