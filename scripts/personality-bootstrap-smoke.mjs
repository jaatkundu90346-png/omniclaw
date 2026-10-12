// Smoke test: PERSONALITY.md as a first-class editable bootstrap file + the
// improved live identity files (identity/personality/soul/user bootstrap).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { WorkspaceBootstrap } = await import(pathToFileURL(path.join(ROOT, "src/core/workspace-bootstrap.js")).href);
const { REQUIRED_WORKSPACE_FILES } = await import(pathToFileURL(path.join(ROOT, "src/core/runtime-workspace.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

// ── 1. REQUIRED list now includes PERSONALITY.md (and IDENTITY.md) ──────────
check("REQUIRED_WORKSPACE_FILES has PERSONALITY.md", REQUIRED_WORKSPACE_FILES.includes("PERSONALITY.md"));
check("REQUIRED_WORKSPACE_FILES has IDENTITY.md", REQUIRED_WORKSPACE_FILES.includes("IDENTITY.md"));

// ── 2. Bootstrap creates PERSONALITY.md in BOTH shared and agent scope ──────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-boot-"));
const boot = new WorkspaceBootstrap(tmp);
boot.ensure(); // shared workspace
const sharedPersonality = path.join(tmp, "workspace", "PERSONALITY.md");
check("shared workspace gets PERSONALITY.md", fs.existsSync(sharedPersonality), sharedPersonality);
check("shared PERSONALITY.md has real content", fs.existsSync(sharedPersonality) && /Voice|Tuning|talk/i.test(fs.readFileSync(sharedPersonality, "utf8")));

const agentDir = boot.ensureAgentWorkspace({ id: "tester", name: "Tester", description: "test agent" });
const agentPersonality = path.join(agentDir, "PERSONALITY.md");
check("agent workspace gets PERSONALITY.md", fs.existsSync(agentPersonality), agentPersonality);

// getStatus manifest should list PERSONALITY.md
const status = boot.getStatus();
check("bootstrap status lists PERSONALITY.md", status.some((f) => f.name === "PERSONALITY.md" && f.exists), JSON.stringify(status.map((f) => f.name)));

fs.rmSync(tmp, { recursive: true, force: true });

// ── 3. loadWorkspaceContext (agent.js) reads PERSONALITY.md ─────────────────
const agentSrc = fs.readFileSync(path.join(ROOT, "src/core/agent.js"), "utf8");
const fileNamesBlock = agentSrc.slice(agentSrc.indexOf("const fileNames = ["), agentSrc.indexOf("const fileNames = [") + 600);
check("loadWorkspaceContext fileNames includes PERSONALITY.md", /"PERSONALITY\.md"/.test(fileNamesBlock), fileNamesBlock.slice(0, 200));

// ── 4. Live agent identity files carry the improved OmniClaw content ────────
const live = (name) => {
  const p = path.join(ROOT, "workspace/agents/main", name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};
check("live IDENTITY.md names OmniClaw + Mankush", /OmniClaw/.test(live("IDENTITY.md")) && /Mankush/.test(live("IDENTITY.md")));
check("live IDENTITY.md states the mission (beat Claude Code/Codex/Hermes)", /Claude Code/i.test(live("IDENTITY.md")) && /Hermes/i.test(live("IDENTITY.md")));
check("live PERSONALITY.md exists with Voice/Hard lines", /Voice/i.test(live("PERSONALITY.md")) && /Hard lines/i.test(live("PERSONALITY.md")));
check("live SOUL.md is OmniClaw-specific (not the OpenClaw web template)", /OmniClaw/.test(live("SOUL.md")) && !/concepts\/soul/.test(live("SOUL.md")));
check("live USER.md has Mankush + Haryana", /Mankush/.test(live("USER.md")) && /Haryana/i.test(live("USER.md")));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
