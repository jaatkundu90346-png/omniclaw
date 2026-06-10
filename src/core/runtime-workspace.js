import path from "node:path";

export const REQUIRED_WORKSPACE_FILES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "AGENT_LOOP.md",
  "AGENT_WORKSPACE.md",
  "AGENT_RUNTIME.md",
  "HARNESS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
]);

function normalizeName(value = "") {
  return String(value || "").replace(/\\/g, "/").trim();
}

function countByScope(files = []) {
  return files.reduce((counts, file) => {
    const scope = String(file.scope || "unknown").trim() || "unknown";
    counts[scope] = (counts[scope] || 0) + 1;
    return counts;
  }, {});
}

export function buildRuntimeWorkspaceManifest({
  rootDir = "",
  sharedWorkspace = "",
  agentWorkspace = "",
  agent = {},
  files = [],
} = {}) {
  const names = new Set(files.map((file) => normalizeName(file.name).toUpperCase()));
  const missingRequiredFiles = REQUIRED_WORKSPACE_FILES.filter((name) => !names.has(name.toUpperCase()));
  const today = new Date().toISOString().slice(0, 10);
  const agentWorkspacePath = path.resolve(agentWorkspace || ".");
  const sharedWorkspacePath = path.resolve(sharedWorkspace || ".");

  return {
    role: "runtime-workspace",
    agentId: agent.id || "main",
    agentName: agent.name || agent.id || "main",
    rootDir: path.resolve(rootDir || "."),
    sharedWorkspace: sharedWorkspacePath,
    agentWorkspace: agentWorkspacePath,
    defaultWorkingDirectory: agentWorkspacePath,
    sessionStore: path.resolve(rootDir || ".", "data", "sessions"),
    transcriptStore: path.resolve(rootDir || ".", "data", "sessions", "transcripts"),
    dailyMemoryPath: path.join(agentWorkspacePath, "memory", `${today}.md`),
    longTermMemoryPath: path.join(agentWorkspacePath, "MEMORY.md"),
    skillsDir: path.join(agentWorkspacePath, "skills"),
    fileCount: files.length,
    fileCountsByScope: countByScope(files),
    loadedFiles: files.map((file) => ({
      name: normalizeName(file.name),
      scope: file.scope || "",
      path: file.path || "",
    })),
    missingRequiredFiles,
    complete: missingRequiredFiles.length === 0,
    privacyContract:
      "Workspace files are agent memory/instructions. Runtime secrets, provider keys, channel auth, and internal session cache stay outside workspace.",
    actionContract:
      "Relative workspace file actions default to the active agent workspace; host/computer access outside it requires explicit tool permission and evidence.",
  };
}
