import fs from "node:fs";
import path from "node:path";

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSkillFile(contents) {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (frontmatter) {
    const meta = {};
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const item = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (item) {
        meta[item[1].toLowerCase()] = item[2].replace(/^["']|["']$/g, "").trim();
      }
    }
    const body = contents.slice(frontmatter[0].length).trim();
    return {
      id: meta.id || slugify(meta.name || "skill"),
      name: meta.name || meta.id || "Unnamed Skill",
      triggers: parseList(meta.triggers || meta.keywords).map((item) => item.toLowerCase()),
      agents: parseList(meta.agents),
      description: meta.description || "",
      instructions: body,
      standard: "agentskills.io/frontmatter",
      license: meta.license || "",
      version: meta.version || "",
    };
  }

  const lines = contents.split(/\r?\n/);
  const meta = {};
  const body = [];
  let inMeta = true;

  for (const line of lines) {
    if (inMeta && line.includes(":")) {
      const index = line.indexOf(":");
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      meta[key] = value;
      continue;
    }

    inMeta = false;
    body.push(line);
  }

  return {
    id: meta.id || "unknown-skill",
    name: meta.name || meta.id || "Unnamed Skill",
    triggers: parseList(meta.triggers).map((item) => item.toLowerCase()),
    agents: parseList(meta.agents),
    description: meta.description || "",
    instructions: body.join("\n").trim(),
    standard: "omniclaw-skill",
  };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "custom-skill";
}

export class SkillRegistry {
  constructor(rootDir) {
    this.skillsDir = path.join(rootDir, "skills");
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  isVisibleToAgent(skill, agentId = "") {
    if (!agentId || !Array.isArray(skill.agents) || skill.agents.length === 0) {
      return true;
    }
    return skill.agents.includes(agentId);
  }

  getAll(agentId = "") {
    return fs
      .readdirSync(this.skillsDir)
      .filter((file) => file.endsWith(".skill"))
      .map((file) => {
        const fullPath = path.join(this.skillsDir, file);
        return {
          ...parseSkillFile(fs.readFileSync(fullPath, "utf8")),
          path: fullPath,
        };
      })
      .filter((skill) => this.isVisibleToAgent(skill, agentId));
  }

  match(message, options = {}) {
    const agentId = typeof options === "string" ? options : options.agentId;
    const lowered = String(message || "").toLowerCase();
    return this.getAll(agentId).filter((skill) => skill.triggers.some((trigger) => lowered.includes(trigger)));
  }

  createSkill({ name, triggers, description, instructions, agentId, agents }) {
    const id = slugify(name);
    const skillPath = path.join(this.skillsDir, `${id}.skill`);
    const normalizedTriggers = Array.isArray(triggers)
      ? triggers
      : String(triggers || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const normalizedAgents = Array.isArray(agents)
      ? agents
      : agentId
        ? [String(agentId).trim()]
        : [];

    const body = [
      `id: ${id}`,
      `name: ${name}`,
      `triggers: ${normalizedTriggers.join(", ")}`,
      `agents: ${normalizedAgents.join(", ")}`,
      `description: ${description || ""}`,
      "",
      String(instructions || "").trim() || "Custom OmniClaw skill.",
      "",
    ].join("\n");

    fs.writeFileSync(skillPath, body, "utf8");
    return {
      file: skillPath,
      skill: parseSkillFile(body),
    };
  }
}
