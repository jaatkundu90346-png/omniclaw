/**
 * Skill Registry - Mavis-style skill management for OmniClaw.
 * Supports global (all agents) and agent-private skills.
 */

import fs from "node:fs";
import path from "node:path";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSkillId(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

export class SkillRegistry {
  constructor({ rootDir, agentName = "main" }) {
    this.rootDir = rootDir;
    this.agentName = agentName;
    this.skillsDir = path.join(rootDir, "skills");
    this.globalSkillsDir = path.join(process.env.HOME || process.env.USERPROFILE || rootDir, ".mavis", "skills");
    this.agentSkillsDir = path.join(process.env.HOME || process.env.USERPROFILE || rootDir, ".mavis", "agents", agentName, "skills");
    this.vendorDir = path.join(rootDir, "vendor");
    this.ensureDirs();
  }

  ensureDirs() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.globalSkillsDir, { recursive: true });
    fs.mkdirSync(this.agentSkillsDir, { recursive: true });
  }

  // ─── Skill Discovery ─────────────────────────────────────────────

  /**
   * List all visible skills for an agent.
   * @param {string} agentId - Agent ID (optional)
   * @param {Object} options - List options
   * @returns {Array} List of skills with metadata
   */
  listSkills(agentId = this.agentName, options = {}) {
    const { scope = "all" } = options;
    const orderedSources = [];
    const workspaceAgentDir = path.join(this.rootDir, "workspace", "agents", agentId, "skills");
    const workspaceDir = path.join(this.rootDir, "workspace", "skills");
    const managedDir = path.join(this.rootDir, "data", "skills");

    if (scope === "all" || scope === "workspace") {
      orderedSources.push([workspaceAgentDir, "workspace-agent", agentId]);
      orderedSources.push([workspaceDir, "workspace", null]);
    }
    if (scope === "all" || scope === "agent") {
      const agentDir = path.join(process.env.HOME || process.env.USERPROFILE || this.rootDir, ".mavis", "agents", agentId, "skills");
      orderedSources.push([agentDir, "personal-agent", agentId]);
    }
    if (scope === "all" || scope === "managed") {
      orderedSources.push([managedDir, "managed", null]);
    }
    if (scope === "all" || scope === "global") {
      orderedSources.push([this.globalSkillsDir, "personal", null]);
      orderedSources.push([this.skillsDir, "bundled", null]);
    }

    const byId = new Map();
    orderedSources.forEach(([dir, source, sourceAgentId], sourceIndex) => {
      for (const skill of this.scanSkillDir(dir, source, sourceAgentId)) {
        const id = normalizeSkillId(skill.id || skill.name);
        if (byId.has(id)) {
          continue;
        }
        byId.set(id, {
          ...skill,
          id,
          precedence: sourceIndex + 1,
          source,
        });
      }
    });

    return [...byId.values()];
  }

  getAll(options = {}) {
    const agentId = (typeof options === "string" ? options : options.agentId) || this.agentName;
    return this.listSkills(agentId, typeof options === "object" ? options : {});
  }

  list(options = {}) {
    return this.getAll(options);
  }

  match(message = "", options = {}) {
    const text = String(message || "").toLowerCase();
    if (!text.trim()) return [];

    return this.getAll(options)
      .map((skill) => {
        const haystack = [
          skill.name,
          skill.description,
          ...(skill.tags || []),
          ...(skill.triggers || []),
        ].join(" ").toLowerCase();
        const score = haystack
          .split(/\s+/)
          .filter((token) => token.length > 2 && text.includes(token)).length;
        const triggerHit = (skill.triggers || []).some((trigger) => text.includes(String(trigger).toLowerCase()));
        return {
          ...skill,
          id: skill.id || skill.name,
          score: score + (triggerHit ? 5 : 0),
        };
      })
      .filter((skill) => skill.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(options.limit || 8));
  }

  /**
   * Scan a skill directory for skill files.
   * @param {string} dir - Directory to scan
   * @param {string} scopeType - 'global', 'builtin', or 'agent'
   * @param {string} agentId - Agent ID for agent scope
   * @returns {Array} Skills found
   */
  scanSkillDir(dir, scopeType, agentId = null) {
    if (!fs.existsSync(dir)) {
      return [];
    }

    const results = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(dir, entry.name);
        const skillFile = path.join(skillPath, "SKILL.md");

        if (!fs.existsSync(skillFile)) continue;

        try {
          const stat = fs.statSync(skillFile);
          const content = fs.readFileSync(skillFile, "utf-8");
          const metadata = this.parseSkillMetadata(content, entry.name);

          results.push({
            id: normalizeSkillId(metadata.name || entry.name),
            name: metadata.name || entry.name,
            path: skillPath,
            skillFile,
            file: "SKILL.md",
            scope: scopeType,
            agentId,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            description: metadata.description || "",
            tags: metadata.tags || [],
            triggers: metadata.triggers || [],
          });
        } catch {
          // Skip invalid skill directories
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return results;
  }

  /**
   * Parse skill metadata from SKILL.md content.
   * @param {string} content - File content
   * @param {string} defaultName - Default name if not in frontmatter
   * @returns {Object} Parsed metadata
   */
  parseSkillMetadata(content, defaultName) {
    const result = {
      name: defaultName,
      description: "",
      tags: [],
      triggers: [],
    };

    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const nameMatch = fm.match(/name:\s*(.+)/);
      const descMatch = fm.match(/description:\s*(.+)/);
      const tagsMatch = fm.match(/tags:\s*\[(.*)\]/);
      const triggersMatch = fm.match(/triggers:\s*\[(.*)\]/);

      if (nameMatch) result.name = nameMatch[1].trim();
      if (descMatch) result.description = descMatch[1].trim();
      if (tagsMatch) result.tags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
      if (triggersMatch) result.triggers = triggersMatch[1].split(",").map(t => t.trim()).filter(Boolean);
    }

    // Fallback: extract first heading as name
    if (!result.description) {
      const headingMatch = content.match(/^#\s+(.+)/m);
      if (headingMatch) result.description = headingMatch[1].trim();
    }

    return result;
  }

  /**
   * Get skill content.
   * @param {string} name - Skill name
   * @param {string} scope - 'global', 'builtin', or 'agent'
   * @param {string} agentId - Agent ID
   * @returns {Object} Skill content and metadata
   */
  getSkill(name, scope = "global", agentId = null) {
    const id = normalizeSkillId(name);
    if (scope === "all") {
      const listed = this.listSkills(agentId || this.agentName, { scope: "all" });
      const match = listed.find((skill) => skill.id === id || normalizeSkillId(skill.name) === id);
      if (match?.skillFile && fs.existsSync(match.skillFile)) {
        const content = fs.readFileSync(match.skillFile, "utf-8");
        return {
          name: match.name,
          id: match.id,
          path: match.path,
          scope: match.scope,
          source: match.source,
          agentId: match.agentId,
          content,
          metadata: this.parseSkillMetadata(content, match.name),
        };
      }
    }

    const skillPaths = this.getSkillPaths(name, scope, agentId);

    for (const skillPath of skillPaths) {
      const skillFile = path.join(skillPath, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, "utf-8");
        const metadata = this.parseSkillMetadata(content, name);

        return {
          name,
          path: skillPath,
          scope: scope,
          agentId,
          content,
          metadata,
        };
      }
    }

    throw new Error(`Skill not found: ${name} (scope: ${scope})`);
  }

  /**
   * Get possible skill paths for a name/scope.
   */
  getSkillPaths(name, scope, agentId) {
    switch (scope) {
      case "builtin":
        return [path.join(this.skillsDir, name)];
      case "workspace":
        return [
          path.join(this.rootDir, "workspace", "agents", agentId || this.agentName, "skills", name),
          path.join(this.rootDir, "workspace", "skills", name),
        ];
      case "agent":
        return [
          path.join(process.env.HOME || process.env.USERPROFILE || this.rootDir, ".mavis", "agents", agentId || this.agentName, "skills", name),
          path.join(this.globalSkillsDir, name),
        ];
      case "global":
      default:
        return [
          path.join(this.globalSkillsDir, name),
          path.join(this.skillsDir, name),
        ];
    }
  }

  // ─── Skill CRUD Operations ───────────────────────────────────────

  /**
   * Create a new skill.
   * @param {string} name - Skill name
   * @param {Object} options - Skill options
   * @returns {Object} Created skill info
   */
  createSkill(name, options = {}) {
    const {
      scope = "global",
      agentId = this.agentName,
      description = "",
      content = "",
      triggers = [],
      tags = [],
    } = options;

    const targetDir = this.getSkillPaths(name, scope, agentId)[0];
    fs.mkdirSync(targetDir, { recursive: true });

    const skillContent = [
      "---",
      `name: ${name}`,
      `description: ${description || name}`,
      `tags: [${tags.join(", ")}]`,
      `triggers: [${triggers.join(", ")}]`,
      "---",
      "",
      `# ${name}`,
      "",
      content || `## Usage\n\nDescribe how to use this skill.\n`,
      "",
      `## Examples\n\nAdd usage examples here.\n`,
    ].join("\n");

    const skillFile = path.join(targetDir, "SKILL.md");
    fs.writeFileSync(skillFile, skillContent, "utf-8");

    return {
      name,
      path: targetDir,
      scope,
      agentId: scope === "agent" ? agentId : null,
      file: skillFile,
    };
  }

  /**
   * Update an existing skill.
   * @param {string} name - Skill name
   * @param {Object} updates - Updates to apply
   * @returns {Object} Updated skill info
   */
  updateSkill(name, updates = {}) {
    const { scope = "global", agentId = null, content, description, tags, triggers } = updates;

    const skill = this.getSkill(name, scope, agentId);
    let skillContent = skill.content;

    if (content !== undefined) {
      // Replace content after frontmatter
      const fmEnd = skillContent.indexOf("---", 4);
      if (fmEnd !== -1) {
        skillContent = skillContent.slice(fmEnd + 4);
      }
      skillContent = `---${skillContent}\n${content}`;
    }

    if (description !== undefined || tags !== undefined || triggers !== undefined) {
      // Update frontmatter
      let fm = skillContent.match(/^---\n([\s\S]*?)\n---\n/)?.[1] || "";

      if (description !== undefined) {
        fm = fm.replace(/description:\s*.+/, `description: ${description}`);
      }
      if (tags !== undefined) {
        fm = fm.replace(/tags:\s*\[.*\]/, `tags: [${tags.join(", ")}]`);
      }
      if (triggers !== undefined) {
        fm = fm.replace(/triggers:\s*\[.*\]/, `triggers: [${triggers.join(", ")}]`);
      }

      skillContent = `---\n${fm}\n---\n${skillContent.split("---").slice(2).join("---")}`;
    }

    fs.writeFileSync(skill.path, skillContent, "utf-8");
    return { name, path: skill.path, scope, agentId };
  }

  /**
   * Delete a skill.
   * @param {string} name - Skill name
   * @param {string} scope - 'global' or 'agent'
   * @param {string} agentId - Agent ID
   */
  deleteSkill(name, scope = "global", agentId = null) {
    const skill = this.getSkill(name, scope, agentId);
    fs.rmSync(skill.path, { recursive: true, force: true });
    return { deleted: name, scope, agentId };
  }

  /**
   * Copy a global skill to agent-private.
   * @param {string} name - Skill name
   * @param {string} targetAgentId - Target agent ID
   * @returns {Object} Copied skill info
   */
  copyToAgent(name, targetAgentId) {
    const skill = this.getSkill(name, "global");
    const targetDir = path.join(
      process.env.HOME || process.env.USERPROFILE || this.rootDir,
      ".mavis",
      "agents",
      targetAgentId,
      "skills",
      name
    );

    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(skill.path, targetDir, { recursive: true });

    return {
      name,
      from: "global",
      to: targetAgentId,
      path: targetDir,
    };
  }

  // ─── Git-based Skill Installation ────────────────────────────────

  /**
   * Install skill from git URL.
   * @param {string} gitUrl - Git repository URL
   * @param {Object} options - Install options
   * @returns {Object} Installed skill info
   */
  async installFromGit(gitUrl, options = {}) {
    const { scope = "global", agentId = this.agentName, branch = "main" } = options;

    // Extract skill name from URL or use provided name
    const urlMatch = gitUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    const skillName = options.name || (urlMatch ? urlMatch[1] : "unknown");

    const targetDir = path.join(
      scope === "agent" ? this.agentSkillsDir : this.globalSkillsDir,
      skillName
    );

    // Clone the repository
    const { execSync } = await import("node:child_process");

    try {
      execSync(`git clone --branch ${branch} --depth 1 ${gitUrl} "${targetDir}"`, {
        stdio: "pipe",
      });

      // Remove .git directory
      fs.rmSync(path.join(targetDir, ".git"), { recursive: true, force: true });

      return {
        name: skillName,
        path: targetDir,
        scope,
        agentId: scope === "agent" ? agentId : null,
        source: gitUrl,
      };
    } catch (error) {
      // Clean up on failure
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`Failed to install skill from ${gitUrl}: ${error.message}`);
    }
  }

  // ─── Skill Search ────────────────────────────────────────────────

  /**
   * Search skills by name, description, or tags.
   * @param {string} query - Search query
   * @param {string} agentId - Optional agent filter
   * @returns {Array} Matching skills
   */
  searchSkills(query, agentId = null) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];

    const skills = this.listSkills(agentId || this.agentName);
    const results = [];

    for (const skill of skills) {
      const searchable = [
        skill.name,
        skill.description,
        ...skill.tags,
        ...skill.triggers,
      ].join(" ").toLowerCase();

      if (searchable.includes(q)) {
        results.push(skill);
      }
    }

    return results;
  }

  // ─── Skill Compatibility ─────────────────────────────────────────

  /**
   * Check skill compatibility with OmniClaw.
   * @param {string} name - Skill name
   * @param {string} source - 'openclaw', 'hermes', or 'omniclaw'
   * @returns {Object} Compatibility status
   */
  checkCompatibility(name, source) {
    try {
      const skill = this.getSkill(name);
      const content = skill.content.toLowerCase();

      // Check for Python dependencies (Hermes)
      const hasPythonDeps = content.includes("python") || content.includes("pip install");

      // Check for OpenClaw-specific features
      const hasOpenClawDeps = content.includes("openclaw") || content.includes("openclaw.");

      // Check for Node.js compatibility
      const hasNodeDeps = content.includes("node") || content.includes("npm") || content.includes("pnpm");

      return {
        name,
        source,
        compatible: source === "omniclaw" || (source === "hermes" && !hasPythonDeps) || (source === "openclaw" && !hasOpenClawDeps),
        warnings: [
          hasPythonDeps && "Skill has Python dependencies - may need adapter",
          hasOpenClawDeps && "Skill uses OpenClaw-specific features",
        ].filter(Boolean),
        status: hasPythonDeps ? "partial" : "full",
      };
    } catch {
      return {
        name,
        source,
        compatible: false,
        warnings: ["Skill not found"],
        status: "missing",
      };
    }
  }
}

export default SkillRegistry;
