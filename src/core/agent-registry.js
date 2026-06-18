import path from "node:path";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
}

function normalizeAgentId(value) {
  return String(value || "main").trim() || "main";
}

function normalizePathForComparison(input) {
  const resolved = path.resolve(String(input || "").replace(/\0/g, ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export class AgentRegistry {
  constructor({ rootDir, configStore, workspaceBootstrap }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.workspaceBootstrap = workspaceBootstrap;
  }

  ensure() {
    for (const agent of this.getAll()) {
      this.workspaceBootstrap.ensureAgentWorkspace(agent);
    }
  }

  refreshAgentIdentity(agentId) {
    const agent = this.resolveAgent(agentId);
    this.workspaceBootstrap.ensureAgentWorkspace(agent);
  }

  getAll() {
    const config = this.configStore.getConfig();
    const agents = isPlainObject(config.agents) ? config.agents : {};
    const entries = Array.isArray(agents.list)
      ? agents.list
          .filter((agent) => isPlainObject(agent))
          .map((agent) => this.normalizeAgent(agent.id, agent))
      : Object.entries(agents)
          .filter(([id]) => id !== "defaults" && id !== "list")
          .filter(([, agent]) => isPlainObject(agent))
          .map(([id, agent]) => this.normalizeAgent(id, agent));

    if (entries.length === 0) {
      return [this.normalizeAgent("main", {})];
    }

    return entries;
  }

  getDefaultAgent() {
    const agents = this.getAll();
    return agents.find((agent) => agent.default) || agents[0];
  }

  listAgentIds() {
    const ids = [];
    const seen = new Set();
    for (const agent of this.getAll()) {
      if (seen.has(agent.id)) {
        continue;
      }
      seen.add(agent.id);
      ids.push(agent.id);
    }
    return ids.length > 0 ? ids : ["main"];
  }

  resolveAgent(agentId = "") {
    const normalized = String(agentId || "").trim();
    const match = this.getAll().find((agent) => agent.id === normalized);
    return match || this.getDefaultAgent();
  }

  getProfileForAgent(agentId = "") {
    const agent = this.resolveAgent(agentId);
    const profile = this.configStore.getProfile(agent.profileId);
    if (profile?.description) {
      return profile;
    }
    return this.configStore.getActiveProfile();
  }

  normalizeAgent(id, raw) {
    const agent = isPlainObject(raw) ? raw : {};
    const agentId = normalizeAgentId(id);
    const workspacePath = this.workspaceBootstrap.getAgentWorkspaceDir(agentId);
    return {
      id: agentId,
      name: String(agent.name || agentId),
      description: String(agent.description || "OmniClaw routed agent."),
      default: Boolean(agent.default),
      profileId: String(agent.profile || this.configStore.getConfig().runtime.activeProfile || "balanced"),
      workspacePath,
      routeKey: `agent:${agentId}`,
      allowedTools: asStringList(agent.allowedTools),
      blockedTools: asStringList(agent.blockedTools),
      blockedPermissions: asStringList(agent.blockedPermissions),
      allowedSkillIds: asStringList(agent.allowedSkillIds),
      blockedSkillIds: asStringList(agent.blockedSkillIds),
      fallbackChain: asStringList(agent.fallbackChain || agent.providerFallbacks),
      channels: asStringList(agent.channels),
    };
  }

  filterSkills(skills, agentId = "") {
    const agent = this.resolveAgent(agentId);
    return (skills || []).filter((skill) => {
      const visibleAgents = asStringList(skill?.agents);
      if (visibleAgents.length > 0 && !visibleAgents.includes(agent.id)) {
        return false;
      }
      if (agent.allowedSkillIds.length > 0 && !agent.allowedSkillIds.includes(skill.id)) {
        return false;
      }
      if (agent.blockedSkillIds.includes(skill.id)) {
        return false;
      }
      return true;
    });
  }

  filterTools(tools, agentId = "") {
    const agent = this.resolveAgent(agentId);
    return (tools || []).filter((tool) => this.isToolAllowed(agent.id, tool));
  }

  isToolAllowed(agentId = "", tool) {
    const agent = this.resolveAgent(agentId);
    if (!tool) {
      return false;
    }

    if (agent.allowedTools.length > 0 && !agent.allowedTools.includes(tool.id)) {
      return false;
    }

    if (agent.blockedTools.includes(tool.id)) {
      return false;
    }

    if (tool.permission && agent.blockedPermissions.includes(tool.permission)) {
      return false;
    }

    return true;
  }

  getWorkspaceStatus(agentId = "") {
    const agent = this.resolveAgent(agentId);
    return this.workspaceBootstrap.getAgentStatus(agent);
  }

  resolveAgentIdsByWorkspacePath(workspacePath = "") {
    const target = normalizePathForComparison(workspacePath);
    const matches = [];
    const agents = this.getAll();

    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      const workspaceDir = normalizePathForComparison(agent.workspacePath);
      if (!isPathInside(workspaceDir, target)) {
        continue;
      }
      matches.push({ id: agent.id, workspaceDir, order: index });
    }

    matches.sort((left, right) => {
      const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
      return workspaceLengthDelta || left.order - right.order;
    });

    return matches.map((entry) => entry.id);
  }

  resolveAgentIdByWorkspacePath(workspacePath = "") {
    return this.resolveAgentIdsByWorkspacePath(workspacePath)[0] || "";
  }

  summarizeAgents({ sessions = [], memoryStore = null, taskStore = null, skillRegistry = null, toolRegistry = null } = {}) {
    return this.getAll().map((agent) => {
      const workspace = this.getWorkspaceStatus(agent.id);
      const profile = this.getProfileForAgent(agent.id);
      const notes = memoryStore?.getNotes?.(agent.id) || [];
      const conversations = memoryStore?.getRecentConversations?.(999, agent.id) || [];
      const tasks = taskStore?.listTasks?.(agent.id) || [];
      const skills = this.filterSkills(skillRegistry?.getAll?.() || [], agent.id);
      const tools = toolRegistry?.getAll?.({ agentId: agent.id }) || [];
      const scopedSessions = (sessions || []).filter((session) => session.agentId === agent.id);
      return {
        ...agent,
        profile,
        workspace,
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          triggers: skill.triggers,
          agents: skill.agents,
        })),
        tools: tools.map((tool) => ({
          id: tool.id,
          description: tool.description,
          permission: tool.permission,
          pluginId: tool.pluginId || "",
        })),
        stats: {
          sessionCount: scopedSessions.length,
          activeSessionCount: scopedSessions.filter((session) => session.lifecycleState !== "archived").length,
          noteCount: notes.length,
          conversationCount: conversations.length,
          taskCount: tasks.length,
          skillCount: skills.length,
          toolCount: tools.length,
        },
      };
    });
  }
}
