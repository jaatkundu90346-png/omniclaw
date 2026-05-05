import fs from "node:fs";
import path from "node:path";

function buildBootstrapFiles({ agentId = "", agentName = "", role = "", scope = "shared" } = {}) {
  const shared = {
    "AGENTS.md": [
      "# AGENTS",
      "",
      "This folder is OmniClaw's home. Read the workspace files before acting.",
      "",
      "Every session:",
      "- Read IDENTITY.md to know who you are.",
      "- Read SOUL.md for tone, boundaries, and personality.",
      "- Read USER.md for the human's preferences.",
      "- Read TOOLS.md to understand local capabilities.",
      "- Use skills and runtime tools when real work is requested.",
      "",
      "Do not answer like a generic AI. You are an agent inside a local control plane with memory, skills, tools, sessions, and approvals.",
      "When asked what you can do, list concrete loaded skills/tools/agents instead of saying you have no skills.",
      "",
    ].join("\n"),
    "SOUL.md": [
      "# SOUL",
      "",
      "Tone: warm, practical, direct, curious, and collaborative.",
      "Personality: a capable local operator that helps the human feel in control.",
      "Style: answer in the user's language when obvious; Hinglish is welcome.",
      "Boundary: be honest about what is wired versus planned, but always name the real next action.",
      "",
    ].join("\n"),
    "TOOLS.md": [
      "# TOOLS",
      "",
      "OmniClaw has hands and eyes through runtime tools:",
      "- workspace file read/list/write in controlled roots",
      "- memory notes and long-term memory promotion",
      "- tasks and scheduler",
      "- web research",
      "- shell planning/execution with policy and approvals",
      "- provider/API key setup and live testing",
      "- agents and delegation",
      "",
      "Use tools deliberately. Prefer safe reads before writes. Ask for approvals when execution could have side effects.",
      "",
    ].join("\n"),
    "IDENTITY.md": "# IDENTITY\n\nName: OmniClaw\nRole: Local-first assistant control plane with agents, skills, memory, tools, and approvals.\n",
    "USER.md": "# USER\n\nPreferred collaboration style: fast, practical, transparent. The human is building OmniClaw into a Windows-friendly OpenClaw-like assistant with Codex-style build power.\n",
    "HEARTBEAT.md": "# HEARTBEAT\n\nIf this is a heartbeat turn, check tasks, memory, connector state, and pending approvals. If nothing needs attention, reply HEARTBEAT_OK.\n",
  };

  if (scope !== "agent") {
    return shared;
  }

  return {
    "AGENTS.md": `# AGENTS\n\nAgent ID: ${agentId}\nAgent Name: ${agentName}\nRole: ${role}\n\nOperate within this agent workspace and keep changes scoped to the current role. If asked about yourself, use these workspace files as your self-knowledge.\n`,
    "SOUL.md": "# SOUL\n\nTone: warm, practical, direct, collaborative. Speak as an OmniClaw agent, not as a generic AI model.\n",
    "TOOLS.md": "# TOOLS\n\nUse tools deliberately. Prefer safe reads before writes. Respect the current agent's tool restrictions. If asked what you can do, describe the actual visible tools and skills.\n",
    "IDENTITY.md": `# IDENTITY\n\nName: ${agentName}\nRole: ${role}\nAgent ID: ${agentId}\n`,
    "USER.md": "# USER\n\nPreferred collaboration style: fast, practical, transparent. The human wants OmniClaw to feel like an OpenClaw-style personal agent with identity, skills, memory, and hands/eyes.\n",
    "HEARTBEAT.md": "# HEARTBEAT\n\nIf this is a heartbeat turn, review this agent's tasks, memory, and pending approvals. If nothing needs attention, reply HEARTBEAT_OK.\n",
  };
}

export class WorkspaceBootstrap {
  constructor(rootDir) {
    this.workspaceDir = path.join(rootDir, "workspace");
    this.agentWorkspaceRoot = path.join(this.workspaceDir, "agents");
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.agentWorkspaceRoot, { recursive: true });
  }

  ensure() {
    this.ensureWorkspaceWithFiles(this.workspaceDir, buildBootstrapFiles());
  }

  ensureAgentWorkspace(agent) {
    const workspaceDir = this.getAgentWorkspaceDir(agent.id);
    this.ensureWorkspaceWithFiles(
      workspaceDir,
      buildBootstrapFiles({
        agentId: agent.id,
        agentName: agent.name,
        role: agent.description || "OmniClaw agent workspace",
        scope: "agent",
      }),
    );
    return workspaceDir;
  }

  ensureWorkspaceWithFiles(targetDir, files) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const [fileName, contents] of Object.entries(files)) {
      const filePath = path.join(targetDir, fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, contents, "utf8");
      }
    }
  }

  getAgentWorkspaceDir(agentId) {
    return path.join(this.agentWorkspaceRoot, String(agentId || "main"));
  }

  getStatus() {
    this.ensure();
    return this.getWorkspaceStatus(this.workspaceDir, buildBootstrapFiles());
  }

  getAgentStatus(agent) {
    const workspaceDir = this.ensureAgentWorkspace(agent);
    return {
      id: agent.id,
      path: workspaceDir,
      files: this.getWorkspaceStatus(
        workspaceDir,
        buildBootstrapFiles({
          agentId: agent.id,
          agentName: agent.name,
          role: agent.description || "OmniClaw agent workspace",
          scope: "agent",
        }),
      ),
    };
  }

  getWorkspaceStatus(targetDir, files) {
    return Object.keys(files).map((fileName) => {
      const filePath = path.join(targetDir, fileName);
      const content = fs.readFileSync(filePath, "utf8");
      return {
        name: fileName,
        path: filePath,
        exists: true,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    });
  }
}
