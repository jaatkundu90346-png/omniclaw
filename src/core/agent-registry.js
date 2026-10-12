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

export function normalizeAgentId(value) {
  // Strict slug — agentId is used to build filesystem paths (workspace/agents/
  // <id>/..., ~/.mavis/agents/<id>/...). Trimming alone allowed "../" traversal
  // to read/scan sibling/parent agent dirs. Strip to [a-z0-9_-] so no separator,
  // "..", or drive letter can survive.
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "")
    .slice(0, 64);
  return slug || "main";
}

function normalizePathForComparison(input) {
  const resolved = path.resolve(String(input || "").replace(/\0/g, ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// ── Agent presentation fields ───────────────────────────────────────────────
// Every field is OPTIONAL and pass-through: an agent written before these fields
// existed (config/default.json, a user's data/config.json, a hand-edited map)
// must normalize to exactly the same usable agent as before, never throw.
//
// label/avatar/color/model/computerProvider are all attacker-ish input (they
// come from a user-editable config file and are echoed to the UI), so each one
// is sanitized here — the single choke point every agent passes through.
// `createdAt`/`updatedAt` are NOT stored state: normalizeAgent() is called on
// every getAll(), so stamping "now" there would report a different createdAt on
// every poll. They only pass through when the config already carries them.

const AGENT_LABEL_MAX = 40;
const AGENT_AVATAR_MAX = 8;
// Shape ids are rendered as CSS classes / looked up in an icon map — keep them
// to a tiny safe alphabet so a config value can never inject a selector.
const AGENT_AVATAR_RE = /^[a-z0-9_-]{1,8}$/i;
const AGENT_COLOR_RE = /^#[0-9a-f]{6}$/i;
const AGENT_MODEL_MAX = 120;
export const AGENT_COMPUTER_PROVIDERS = ["local", "cloud"];
// There is deliberately no DEFAULT_COLOR constant: the fallback is derived per
// agent id from FALLBACK_PALETTE (see defaultAgentColor), so two agents never
// render the same face. A single default colour would be a lie.
export const DEFAULT_AGENT_AVATAR = "blob";

// Deterministic fallback color so an agent with no configured color still gets
// a distinct face instead of every agent rendering identical. Derived from the
// agent id (stable across restarts and across GET /api/agents polls).
const FALLBACK_PALETTE = ["#7c8cf8", "#4fb783", "#e0883c", "#c8577e", "#3ca7d8", "#b07ce8", "#d8a13c", "#5aa84f"];

export function defaultAgentColor(agentId) {
  const slug = String(agentId || "main");
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

export function normalizeAgentLabel(value) {
  // Control chars / newlines out: the label is rendered as a DOM text node and
  // used in a title attribute.
  const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, AGENT_LABEL_MAX);
}

export function normalizeAgentAvatar(value, fallback = DEFAULT_AGENT_AVATAR) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return fallback;
  // An avatar longer than the cap is almost always a pasted string/URL, not a
  // shape id: reject it rather than truncating into something that accidentally
  // matches a real shape.
  if (text.length > AGENT_AVATAR_MAX || !AGENT_AVATAR_RE.test(text)) return fallback;
  return text;
}

export function normalizeAgentColor(value, agentId = "main") {
  const text = String(value == null ? "" : value).trim();
  if (!text) return defaultAgentColor(agentId);
  // Only #rrggbb. 3/4/8-digit hex and named colors are accepted by CSS but
  // would break a client that parses the value itself; rgb()/var() would be a
  // CSS-injection vector.
  if (!AGENT_COLOR_RE.test(text)) return defaultAgentColor(agentId);
  return text.toLowerCase();
}

export function normalizeAgentModel(value) {
  // Empty = inherit the global model.
  const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, AGENT_MODEL_MAX);
}

export function normalizeComputerProvider(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return AGENT_COMPUTER_PROVIDERS.includes(text) ? text : "local";
}

function normalizeIsoTimestamp(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
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
      // ── presentation + capability fields (all optional) ──
      // label defaults to `name` so a hand-written agent still renders a real title.
      label: normalizeAgentLabel(agent.label || agent.name || agentId),
      avatar: normalizeAgentAvatar(agent.avatar),
      color: normalizeAgentColor(agent.color, agentId),
      // Empty string means "inherit the global model".
      model: normalizeAgentModel(agent.model),
      // computerProvider === "cloud" is a FAIL-CLOSED marker only. Nothing
      // provisions a cloud machine, so any code that reads this value MUST treat
      // "cloud" as "not supported" and refuse / report it — it must NEVER
      // silently fall back to running locally.
      computerProvider: normalizeComputerProvider(agent.computerProvider),
      // Pass-through only: normalizeAgent runs on every getAll(), so stamping
      // "now" here would make createdAt change on every poll.
      createdAt: normalizeIsoTimestamp(agent.createdAt),
      updatedAt: normalizeIsoTimestamp(agent.updatedAt),
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
