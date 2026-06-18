/**
 * Hermes Agent Skill Importer - Import skills from Hermes Agent vendor.
 * Scans vendor/hermes-agent/skills/* and maps to OmniClaw equivalents.
 */

import fs from "node:fs";
import path from "node:path";

export class HermesSkillImporter {
  constructor({ rootDir, targetDir = null }) {
    this.rootDir = rootDir;
    this.vendorDir = path.join(rootDir, "vendor", "hermes-agent");
    this.skillsDir = path.join(this.vendorDir, "skills");
    this.targetDir = targetDir || path.join(rootDir, "skills");
  }

  /**
   * Scan Hermes Agent skills directory.
   * @returns {Object} Available skills with compatibility info
   */
  scanSkills() {
    if (!fs.existsSync(this.skillsDir)) {
      return { skills: [], total: 0 };
    }

    const skills = [];

    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsDir, entry.name);
        const skillFile = path.join(skillPath, "SKILL.md");

        if (!fs.existsSync(skillFile)) continue;

        try {
          const content = fs.readFileSync(skillFile, "utf-8");
          const metadata = this.parseSkillMetadata(content, entry.name);
          const compatibility = this.checkCompatibility(content);

          skills.push({
            name: entry.name,
            path: skillPath,
            description: metadata.description || "",
            tags: metadata.tags || [],
            tools: metadata.tools || [],
            compatibility,
            pythonOnly: compatibility.pythonOnly,
            hasAdapter: compatibility.hasOmniClawEquivalent,
          });
        } catch {
          // Skip invalid skill directories
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return {
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
      total: skills.length,
    };
  }

  /**
   * Parse Hermes skill metadata.
   */
  parseSkillMetadata(content, defaultName) {
    const result = {
      name: defaultName,
      description: "",
      tags: [],
      tools: [],
      requirements: [],
    };

    // Extract YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const descMatch = fm.match(/description:\s*(.+)/i);
      const tagsMatch = fm.match(/tags:\s*\[(.*)\]/i);
      const toolsMatch = fm.match(/tools:\s*\[(.*)\]/i);
      const reqMatch = fm.match(/requirements:\s*\n((?:\s*-\s*.+\n)*)/i);

      if (descMatch) result.description = descMatch[1].trim();
      if (tagsMatch) result.tags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
      if (toolsMatch) result.tools = toolsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
      if (reqMatch) result.requirements = reqMatch[1].split("\n").map(r => r.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    }

    // Fallback: first heading as description
    if (!result.description) {
      const headingMatch = content.match(/^#\s+(.+)/m);
      if (headingMatch) result.description = headingMatch[1].trim();
    }

    return result;
  }

  /**
   * Check skill compatibility with OmniClaw.
   */
  checkCompatibility(content) {
    const pythonIndicators = [
      "python",
      "pip install",
      "pip3 install",
      "requirements.txt",
      "import asyncio",
      "from langchain",
      "from openai import",
      ".py",
    ];

    const omniclawEquivalentTools = {
      "web_search": "web_search",
      "browser_navigate": "browser",
      "browser_click": "browser_click",
      "browser_type": "browser_type",
      "terminal": "terminal",
      "exec": "exec",
      "read_file": "read_file",
      "write_file": "write_file",
      "memory_search": "memory_search",
      "memory_get": "memory_get",
      "sessions_list": "sessions_list",
      "skills_list": "skills_list",
      "todo": "todo",
      "vision_analyze": "vision_analyze",
      "video_analyze": "video_analyze",
    };

    const lowerContent = content.toLowerCase();

    const pythonOnly = pythonIndicators.some(indicator => lowerContent.includes(indicator));

    const usedTools = [];
    for (const [hermesTool, omniclawTool] of Object.entries(omniclawEquivalentTools)) {
      if (lowerContent.includes(hermesTool)) {
        usedTools.push({
          hermes: hermesTool,
          omniclaw: omniclawTool,
          compatible: true,
        });
      }
    }

    const hasOmniClawEquivalent = usedTools.length > 0 && !pythonOnly;

    return {
      pythonOnly,
      hasOmniClawEquivalent,
      usedTools,
      compatibilityScore: pythonOnly ? 0 : (usedTools.length > 0 ? 0.8 : 0.3),
      status: pythonOnly ? "needs_adapter" : hasOmniClawEquivalent ? "native" : "partial",
    };
  }

  /**
   * Import a Hermes skill.
   * @param {string} name - Skill name
   * @param {Object} options - Import options
   * @returns {Object} Import result
   */
  importSkill(name, options = {}) {
    const {
      rename = null,
      includePythonWarning = true,
      mapTools = true,
    } = options;

    const sourceSkillPath = path.join(this.skillsDir, name);
    const sourceSkillFile = path.join(sourceSkillPath, "SKILL.md");

    if (!fs.existsSync(sourceSkillFile)) {
      throw new Error(`Hermes skill not found: ${name}`);
    }

    const content = fs.readFileSync(sourceSkillFile, "utf-8");
    const compatibility = this.checkCompatibility(content);
    const newName = rename || `hermes_${name}`;
    const targetPath = path.join(this.targetDir, newName);

    let transformedContent = content;

    if (mapTools) {
      transformedContent = this.mapToolReferences(content, compatibility);
    }

    // Add compatibility warning if Python
    if (includePythonWarning && compatibility.pythonOnly) {
      transformedContent = this.addPythonWarning(transformedContent, name);
    }

    // Update metadata for OmniClaw
    transformedContent = this.updateMetadata(transformedContent, name, newName, compatibility);

    // Create target directory
    fs.mkdirSync(targetPath, { recursive: true });

    // Write the skill file
    const targetSkillFile = path.join(targetPath, "SKILL.md");
    fs.writeFileSync(targetSkillFile, transformedContent, "utf-8");

    return {
      success: true,
      name: newName,
      source: name,
      sourcePath: sourceSkillPath,
      targetPath,
      compatibility,
      pythonOnly: compatibility.pythonOnly,
    };
  }

  /**
   * Map Hermes tool references to OmniClaw equivalents.
   */
  mapToolReferences(content, compatibility) {
    const toolMapping = {
      "browser_navigate": "browser",
      "browser_click": "browser_click",
      "browser_type": "browser_type",
      "browser_scroll": "browser_scroll",
      "browser_screenshot": "browser_screenshot",
      "browser_back": "browser_back",
      "web_extract": "read_url",
      "read": "read_file",
      "write": "write_file",
      "edit": "edit_file",
      "execute_code": "exec",
      "run_terminal_command": "terminal",
      "session_search": "sessions_list",
      "skill_view": "skills_list",
      "vision_analyze": "vision_analyze",
      "video_analyze": "video_analyze",
    };

    let mapped = content;

    for (const [hermesTool, omniclawTool] of Object.entries(toolMapping)) {
      // Match tool invocations in code blocks
      mapped = mapped.replace(
        new RegExp(`\`\`\`\\w*\\n([\\s\\S]*?)${hermesTool}([\\s\\S]*?)\`\`\``, "g"),
        (match, before, after) => {
          return match.replace(hermesTool, omniclawTool);
        }
      );

      // Match inline tool references
      mapped = mapped.replace(
        new RegExp(`\\b${hermesTool}\\b`, "g"),
        omniclawTool
      );
    }

    return mapped;
  }

  /**
   * Add Python compatibility warning to skill.
   */
  addPythonWarning(content, originalName) {
    const warning = [
      "",
      ":::warning",
      "This skill was imported from Hermes Agent and may contain Python dependencies.",
      "Some features may require a Python adapter or manual adaptation for OmniClaw.",
      ":::",
      "",
    ].join("\n");

    // Add after frontmatter
    const fmEnd = content.indexOf("---", 4);
    if (fmEnd !== -1) {
      const afterFm = content.slice(fmEnd + 4);
      return content.slice(0, fmEnd + 4) + warning + afterFm;
    }

    return content + warning;
  }

  /**
   * Update skill metadata for OmniClaw.
   */
  updateMetadata(content, oldName, newName, compatibility) {
    let updated = content;

    // Update name
    updated = updated.replace(
      new RegExp(`^name:\\s*${oldName}`, "m"),
      `name: ${newName}`
    );

    // Add Hermes origin tag
    if (updated.includes("tags:")) {
      updated = updated.replace(
        /(tags:\s*\[)(.*)(\])/,
        `$1$2, "hermes-import"$3`
      );
    } else {
      // Add tags after name
      updated = updated.replace(
        /^(name:\s*.+)$/m,
        `$1\ntags: ["hermes-import"]`
      );
    }

    // Add compatibility info
    const compatInfo = compatibility.pythonOnly
      ? "Status: requires_python_adapter"
      : "Status: native";

    if (updated.includes("description:")) {
      updated = updated.replace(
        /(description:\s*)(.+)/,
        `$1$2 (Hermes import - ${compatInfo})`
      );
    }

    return updated;
  }

  /**
   * Import multiple Hermes skills.
   * @param {Array} names - Skill names to import
   * @param {Object} options - Import options
   * @returns {Object} Import results
   */
  importBatch(names, options = {}) {
    const results = {
      imported: [],
      failed: [],
      skipped: [],
    };

    for (const name of names) {
      try {
        const compatibility = this.checkCompatibility(
          fs.readFileSync(path.join(this.skillsDir, name, "SKILL.md"), "utf-8")
        );

        if (compatibility.pythonOnly && !options.includePython) {
          results.skipped.push({
            name,
            reason: "Python-only skill",
          });
          continue;
        }

        const result = this.importSkill(name, options);
        results.imported.push({
          name,
          newName: result.name,
          success: true,
          pythonOnly: result.pythonOnly,
        });
      } catch (error) {
        results.failed.push({
          name,
          error: error.message,
        });
      }
    }

    return {
      ...results,
      summary: `Imported ${results.imported.length}/${names.length} skills (${results.skipped.length} skipped, ${results.failed.length} failed)`,
    };
  }

  /**
   * Get tool compatibility matrix.
   * @returns {Object} Matrix of Hermes tools vs OmniClaw equivalents
   */
  getToolCompatibilityMatrix() {
    return {
      native: [
        "web_search",
        "terminal",
        "exec",
        "read_file",
        "write_file",
        "browser",
        "memory_search",
        "sessions_list",
        "skills_list",
        "todo",
        "vision_analyze",
      ],
      partial: [
        "browser_navigate → browser",
        "browser_click → browser_click",
        "browser_type → browser_type",
        "web_extract → read_url",
        "session_search → sessions_list",
      ],
      needs_adapter: [
        "execute_code (Python)",
        "run_terminal_command → terminal (shell only)",
        "skill_view → skills_list (partial)",
      ],
      incompatible: [
        "Python-specific skills",
        "pip install dependencies",
        "requirements.txt based",
      ],
    };
  }
}

export default HermesSkillImporter;