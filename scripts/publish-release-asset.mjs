// Replace the v0.1.0 release asset with a newer Windows build and refresh the
// notes. Same GitHub REST path as before (the stored OAuth token has repo admin
// but not gh's read:org scope, so gh cannot be used).
//
// The token is read from a temp file that is never printed and deleted after.
import fs from "node:fs";
import path from "node:path";

const OWNER = "jaatkundu90346-png";
const REPO = "omniclaw";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN_FILE = path.join(process.env.TEMP || ".", "oc-gh-token.tmp");
const ZIP = path.resolve(process.argv[2] || "dist/releases/OmniClaw-Windows-v0.1.0-2026.10.12-195039.zip");
const NOTES = path.resolve(process.argv[3] || "dist/RELEASE_NOTES_v0.1.0.md");

const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const h = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "omniclaw-release",
};

let step = "start";
try {
  step = "load the existing release";
  const rel = await (await fetch(`${API}/releases/tags/v0.1.0`, { headers: h })).json();
  if (!rel.id) throw new Error(`release v0.1.0 not found: ${JSON.stringify(rel).slice(0, 200)}`);
  console.log(`ok: release id ${rel.id}`);

  step = "update the release notes";
  const notes = fs.readFileSync(NOTES, "utf8");
  const upd = await fetch(`${API}/releases/${rel.id}`, {
    method: "PATCH",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ body: notes }),
  });
  const updJson = await upd.json();
  if (updJson.id) console.log("ok: notes refreshed");
  else throw new Error(`notes update failed: ${upd.status} ${JSON.stringify(updJson).slice(0, 200)}`);

  step = "delete the stale asset";
  for (const a of rel.assets || []) {
    const d = await fetch(`${API}/releases/assets/${a.id}`, { method: "DELETE", headers: h });
    console.log(`ok: removed old asset ${a.name} (${d.status})`);
  }

  step = "upload the new build";
  const bytes = fs.readFileSync(ZIP);
  const asset = await (await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=OmniClaw-Windows-v0.1.0.zip`,
    {
      method: "POST",
      headers: { ...h, "Content-Type": "application/zip", "Content-Length": String(bytes.length) },
      body: bytes,
    },
  )).json();
  if (!asset.id) throw new Error(`upload failed: ${JSON.stringify(asset).slice(0, 300)}`);
  console.log(`ok: uploaded ${(asset.size / 1048576).toFixed(1)} MB -> ${asset.browser_download_url}`);

  step = "verify";
  const check = await (await fetch(`${API}/releases/latest`, { headers: h })).json();
  console.log(`   release: ${check.html_url}`);
  console.log(`   assets : ${(check.assets || []).map((a) => `${a.name} (${(a.size / 1048576).toFixed(1)} MB)`).join(", ")}`);
  console.log("RELEASE UPDATE: OK");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch {}
}