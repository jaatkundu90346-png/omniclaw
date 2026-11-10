// Publish OmniClaw v1 and remove v0.1.0.
//
// Same GitHub REST path as publish-release-asset.mjs: the stored OAuth token has
// repo admin but not gh's read:org scope, so `gh` cannot be used.
//
// The token is read from a temp file, never printed, and the file is deleted
// afterwards. Nothing here echoes it.
//
// ORDER MATTERS. The new release is created and its asset uploaded BEFORE the
// old release is deleted. If the upload fails half-way, the repo still has a
// working v0.1.0 download -- the reverse order would leave the project with no
// downloadable build at all.
import fs from "node:fs";
import path from "node:path";

const OWNER = "jaatkundu90346-png";
const REPO = "omniclaw";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN_FILE = path.join(process.env.TEMP || ".", "oc-gh-token.tmp");

const NEW_TAG = process.env.OC_NEW_TAG || "v1";
const OLD_TAG = process.env.OC_OLD_TAG || "v0.1.0";
const ZIP = path.resolve(process.argv[2] || "");
const NOTES = path.resolve(process.argv[3] || "");
const TARGET_COMMIT = process.argv[4] || "";
const ASSET_NAME = `${REPO === "omniclaw" ? "OmniClaw" : REPO}-Windows-${NEW_TAG}.zip`;
const DESCRIPTION = "Local-first AI agent platform for Windows. Agents, tools, memory, sessions — all on your machine.";

if (!fs.existsSync(ZIP)) { console.error(`FAIL: ZIP not found: ${ZIP}`); process.exit(1); }
if (!fs.existsSync(NOTES)) { console.error(`FAIL: notes not found: ${NOTES}`); process.exit(1); }
if (!fs.existsSync(TOKEN_FILE)) { console.error(`FAIL: token file not found: ${TOKEN_FILE}`); process.exit(1); }

const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const h = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "omniclaw-release",
};
const json = (extra = {}) => ({ ...h, "Content-Type": "application/json", ...extra });

let step = "start";
try {
  const zipBytes = fs.readFileSync(ZIP);
  console.log(`ok: zip ${path.basename(ZIP)} = ${(zipBytes.length / 1048576).toFixed(1)} MB`);
  const notes = fs.readFileSync(NOTES, "utf8");

  step = "make sure the new tag exists";
  const sha = TARGET_COMMIT || (await (await fetch(`${API}/commits/main`, { headers: h })).json()).sha;
  if (!sha) throw new Error("could not resolve the commit for the new tag");
  const existingTag = await (await fetch(`${API}/git/ref/tags/${encodeURIComponent(NEW_TAG)}`, { headers: h })).json();
  if (existingTag.ref) {
    console.log(`ok: tag ${NEW_TAG} already exists -> ${existingTag.object.sha.slice(0, 8)}`);
  } else {
    const created = await fetch(`${API}/git/refs`, {
      method: "POST",
      headers: json(),
      body: JSON.stringify({ ref: `refs/tags/${NEW_TAG}`, sha }),
    });
    const createdJson = await created.json();
    if (!createdJson.ref) throw new Error(`tag create failed: ${created.status} ${JSON.stringify(createdJson).slice(0, 200)}`);
    console.log(`ok: created tag ${NEW_TAG} -> ${sha.slice(0, 8)}`);
  }

  step = "create the new release";
  const created = await fetch(`${API}/releases`, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({
      tag_name: NEW_TAG,
      name: `OmniClaw ${NEW_TAG}`,
      body: notes,
      draft: false,
      prerelease: false,
      // MUST be the string "true", not the boolean — GitHub rejects a boolean
      // here with a 422 that reads like the whole release is malformed.
      make_latest: "true",
    }),
  });
  const rel = await created.json();
  if (!rel.id) throw new Error(`release create failed: ${created.status} ${JSON.stringify(rel).slice(0, 300)}`);
  console.log(`ok: release ${rel.id} -> ${rel.html_url}`);

  step = "upload the build";
  const uploaded = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`,
    {
      method: "POST",
      headers: { ...h, "Content-Type": "application/zip", "Content-Length": String(zipBytes.length) },
      body: zipBytes,
    },
  );
  const asset = await uploaded.json();
  if (!asset.id) throw new Error(`upload failed: ${uploaded.status} ${JSON.stringify(asset).slice(0, 300)}`);
  console.log(`ok: uploaded ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)`);

  step = "verify the new release is downloadable BEFORE removing the old one";
  const head = await fetch(asset.browser_download_url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`new asset is not downloadable yet (${head.status})`);
  const headLen = Number(head.headers.get("content-length") || 0);
  if (headLen !== zipBytes.length) {
    throw new Error(`served size ${headLen} != uploaded ${zipBytes.length} — the upload is truncated`);
  }
  console.log(`ok: v${NEW_TAG} asset serves ${(headLen / 1048576).toFixed(1)} MB`);

  step = "remove the old release";
  const oldByTag = await (await fetch(`${API}/releases/tags/${encodeURIComponent(OLD_TAG)}`, { headers: h })).json();
  if (oldByTag.id) {
    for (const a of oldByTag.assets || []) {
      const d = await fetch(`${API}/releases/assets/${a.id}`, { method: "DELETE", headers: h });
      console.log(`ok: removed old asset ${a.name} (${d.status})`);
    }
    const d = await fetch(`${API}/releases/${oldByTag.id}`, { method: "DELETE", headers: h });
    if (d.status !== 204 && d.status !== 404) {
      throw new Error(`release delete failed: ${d.status} ${(await d.text()).slice(0, 200)}`);
    }
    console.log(`ok: deleted release ${OLD_TAG}`);
  } else {
    console.log(`ok: ${OLD_TAG} release already absent`);
  }

  step = "remove the old tag";
  const delTag = await fetch(`${API}/git/refs/tags/${encodeURIComponent(OLD_TAG)}`, { method: "DELETE", headers: h });
  if (delTag.status === 204) console.log(`ok: deleted tag ${OLD_TAG}`);
  else if (delTag.status === 422) console.log(`ok: tag ${OLD_TAG} already gone`);
  else throw new Error(`tag delete failed: ${delTag.status} ${(await delTag.text()).slice(0, 200)}`);

  step = "update the repository blurb";
  const repoPatch = await fetch(API, {
    method: "PATCH",
    headers: json(),
    body: JSON.stringify({ description: DESCRIPTION, topics: ["ai-agent", "local-first", "windows", "cli", "automation", "llm", "self-hosted"] }),
  });
  const repoJson = await repoPatch.json();
  if (!repoJson.full_name) throw new Error(`repo update failed: ${repoPatch.status} ${JSON.stringify(repoJson).slice(0, 200)}`);
  console.log(`ok: description + topics updated`);

  step = "final verification";
  const releases = await (await fetch(`${API}/releases`, { headers: h })).json();
  const tagsNow = await (await fetch(`${API}/tags`, { headers: h })).json();
  console.log(`   releases: ${releases.map((r) => `${r.tag_name} (${r.assets.length} asset(s))`).join(", ") || "(none)"}`);
  console.log(`   tags    : ${tagsNow.map((t) => t.name).join(", ") || "(none)"}`);
  console.log(`   latest  : ${(await (await fetch(`${API}/releases/latest`, { headers: h })).json()).tag_name}`);
  if (releases.length !== 1 || releases[0].tag_name !== NEW_TAG) {
    throw new Error(`expected exactly one release named ${NEW_TAG}, got ${releases.map((r) => r.tag_name).join(",")}`);
  }
  if (tagsNow.some((t) => t.name === OLD_TAG)) throw new Error(`the ${OLD_TAG} tag still exists`);
  console.log("\nRELEASE v1: OK");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch {}
}