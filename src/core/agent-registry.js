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
    const entries = Object.entries(agents).map(([id, agent]) => this.normalizeAgent(id, agent));

    if (entries.length === 0) {
      return [this.normalizeAgent("main", {})];
    }

    return entries;
  }

  getDefaultAgent() {
    return this.getAll()[0];
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
    const workspacePath = this.workspaceBootstrap.getAgentWorkspaceDir(id);
    return {
      id: String(id || "main"),
      name: String(agent.name || id),
      description: String(agent.description || "OmniClaw routed agent."),
      profileId: String(agent.profile || this.configStore.getConfig().runtime.activeProfile || "balanced"),
      workspacePath,
      routeKey: `agent:${id}`,
      allowedTools: asStringList(agent.allowedTools),
      blockedTools: asStringList(agent.blockedTools),
      blockedPermissions: asStringList(agent.blockedPermissions),
      allowedSkillIds: asStringList(agent.allowedSkillIds),
      blockedSkillIds: asStringList(agent.blockedSkillIds),
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
