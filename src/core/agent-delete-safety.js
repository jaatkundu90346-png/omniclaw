import fs from "node:fs";
import path from "node:path";

function normalizeWorkspacePathForComparison(input) {
  const resolved = path.resolve(String(input || "").replace(/\0/g, ""));
  let normalized = resolved;
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Non-existent paths still compare lexically.
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function workspacePathsOverlap(left, right) {
  const normalizedLeft = normalizeWorkspacePathForComparison(left);
  const normalizedRight = normalizeWorkspacePathForComparison(right);
  return isPathInside(normalizedLeft, normalizedRight) || isPathInside(normalizedRight, normalizedLeft);
}

export function findOverlappingWorkspaceAgentIds(agentRegistry, agentId, workspaceDir) {
  const currentAgentId = String(agentId || "main").trim().toLowerCase();
  const agents = agentRegistry?.getAll?.() || [];
  const overlappingAgentIds = [];
  for (const agent of agents) {
    const otherAgentId = String(agent.id || "").trim().toLowerCase();
    if (!otherAgentId || otherAgentId === currentAgentId) {
      continue;
    }
    const otherWorkspace = agent.workspacePath || agentRegistry?.workspaceBootstrap?.getAgentWorkspaceDir?.(agent.id);
    if (otherWorkspace && workspacePathsOverlap(workspaceDir, otherWorkspace)) {
      overlappingAgentIds.push(agent.id);
    }
  }
  return overlappingAgentIds;
}
