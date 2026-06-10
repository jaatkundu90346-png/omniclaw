/**
 * OpenClaw Skill Importer - Import skills from OpenClaw vendor.
 * Scans vendor/openclaw/skills/* and imports selected skills to OmniClaw.
 */

import fs from "node:fs";
import path from "node:path";

export class OpenClawSkillImporter {
  constructor({ rootDir, targetDir = null }) {
    this.rootDir = rootDir;
    this.vendorDir = path.join(rootDir, "vendor", "openclaw");
    this.skillsDir = path.join(this.vendorDir, "skills");
    this.targetDir = targetDir || path.join(rootDir, "skills");
  }

  /**
   * Scan OpenClaw skills directory for available skills.
   * @returns {Array} List of available skills
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

          skills.push({
            name: entry.name,
            path: skillPath,
            description: metadata.description || "",
            tags: metadata.tags || [],
            category: metadata.category || "general",
            complexity: metadata.complexity || "medium",
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
   * Parse skill metadata from SKILL.md content.
   */
  parseSkillMetadata(content, defaultName) {
    const result = {
      name: defaultName,
      description: "",
      tags: [],
      category: "general",
      complexity: "medium",
    };

    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const descMatch = fm.match(/description:\s*(.+)/i);
      const tagsMatch = fm.match(/tags:\s*\[(.*)\]/i);
      const catMatch = fm.match(/category:\s*(.+)/i);
      const complexMatch = fm.match(/complexity:\s*(.+)/i);

      if (descMatch) result.description = descMatch[1].trim();
      if (tagsMatch) result.tags = tagsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
      if (catMatch) result.category = catMatch[1].trim();
      if (complexMatch) result.complexity = complexMatch[1].trim();
    }

    // Fallback: first heading as description
    if (!result.description) {
      const headingMatch = content.match(/^#\s+(.+)/m);
      if (headingMatch) result.description = headingMatch[1].trim();
    }

    return result;
  }

  /**
   * Import a specific skill by name.
   * @param {string} name - Skill name
   * @param {Object} options - Import options
   * @returns {Object} Import result
   */
  importSkill(name, options = {}) {
    const {
      rename = null,
      transform = true,
      skipOpenClawDeps = true,
    } = options;

    const sourceSkillPath = path.join(this.skillsDir, name);
    const sourceSkillFile = path.join(sourceSkillPath, "SKILL.md");

    if (!fs.existsSync(sourceSkillFile)) {
      throw new Error(`OpenClaw skill not found: ${name}`);
    }

    const content = fs.readFileSync(sourceSkillFile, "utf-8");
    const newName = rename || name;
    const targetPath = path.join(this.targetDir, newName);

    let transformedContent = content;

    if (transform) {
      transformedContent = this.transformSkillContent(content, name, newName, skipOpenClawDeps);
    }

    // Create target directory
    fs.mkdirSync(targetPath, { recursive: true });

    // Write the skill file
    const targetSkillFile = path.join(targetPath, "SKILL.md");
    fs.writeFileSync(targetSkillFile, transformedContent, "utf-8");

    // Copy additional files if present
    this.copySkillAssets(sourceSkillPath, targetPath);

    return {
      success: true,
      name: newName,
      source: name,
      sourcePath: sourceSkillPath,
      targetPath,
      transformed: transform,
    };
  }

  /**
   * Transform skill content for OmniClaw compatibility.
   */
  transformSkillContent(content, oldName, newName, skipOpenClawDeps) {
    let transformed = content;

    // Update skill name in frontmatter
    transformed = transformed.replace(new RegExp(`^name:\\s*${oldName}`, "m"), `name: ${newName}`);

    // Remove OpenClaw-specific imports/references
    if (skipOpenClawDeps) {
      // Remove openclaw imports
      transformed = transformed.replace(/openclaw\./g, "omniclaw.");
      transformed = transformed.replace(/from\s+['"]openclaw[^\n'"]+['"]/g, "");
      transformed = transformed.replace(/import\s+.*openclaw.*from.*/g, "");
    }

    // Update skill description to indicate origin
    if (transformed.includes("description:")) {
      transformed = transformed.replace(
        /(description:\s*)(.+)/,
        `$1$2 (ported from OpenClaw)`
      );
    } else {
      // Add description after name in frontmatter
      transformed = transformed.replace(
        /^(name:\s*.+)$/m,
        `$1\ndescription: Imported from OpenClaw skill '${oldName}'`
      );
    }

    // Add OmniClaw compatibility tag
    if (transformed.includes("tags:")) {
      transformed = transformed.replace(
        /(tags:\s*\[)(.*)(\])/,
        `$1$2, "openclaw-import"$3`
      );
    }

    // Fix any broken tool references
    transformed = this.fixToolReferences(transformed);

    return transformed;
  }

  /**
   * Fix tool references for OmniClaw compatibility.
   */
  fixToolReferences(content) {
    const toolMapping = {
      "read_url": "read_url",
      "web_search": "web_search",
      "browser": "browser",
      "exec": "exec",
      "shell": "shell",
      "terminal": "terminal",
      "memory": "memory",
      "sessions": "sessions",
      "skills": "skills",
      "subagents": "subagents",
    };

    let fixed = content;

    for (const [openclawTool, omniclawTool] of Object.entries(toolMapping)) {
      // Only replace if not already the same
      if (openclawTool !== omniclawTool) {
        // Match tool invocations
        fixed = fixed.replace(
          new RegExp(`\\b${openclawTool}\\b`, "g"),
          omniclawTool
        );
      }
    }

    return fixed;
  }

  /**
   * Copy additional assets from skill directory.
   */
  copySkillAssets(sourcePath, targetPath) {
    try {
      const entries = fs.readdirSync(sourcePath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name === "SKILL.md") continue;
        if (entry.isDirectory()) {
          const subDir = path.join(targetPath, entry.name);
          fs.mkdirSync(subDir, { recursive: true });
          fs.cpSync(path.join(sourcePath, entry.name), subDir, { recursive: true });
        } else {
          fs.copyFileSync(
            path.join(sourcePath, entry.name),
            path.join(targetPath, entry.name)
          );
        }
      }
    } catch {
      // Ignore asset copy errors
    }
  }

  /**
   * Import multiple skills in batch.
   * @param {Array} names - Array of skill names to import
   * @param {Object} options - Import options
   * @returns {Object} Batch import results
   */
  importBatch(names, options = {}) {
    const results = {
      imported: [],
      failed: [],
      skipped: [],
    };

    for (const name of names) {
      try {
        const result = this.importSkill(name, options);
        results.imported.push({
          name,
          newName: result.name,
          success: true,
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
      summary: `Imported ${results.imported.length}/${names.length} skills`,
    };
  }

  /**
   * Preview a skill transformation without importing.
   * @param {string} name - Skill name
   * @returns {Object} Preview result
   */
  previewTransform(name) {
    const sourceSkillFile = path.join(this.skillsDir, name, "SKILL.md");

    if (!fs.existsSync(sourceSkillFile)) {
      throw new Error(`OpenClaw skill not found: ${name}`);
    }

    const originalContent = fs.readFileSync(sourceSkillFile, "utf-8");
    const transformedContent = this.transformSkillContent(
      originalContent,
      name,
      `omniclaw_${name}`,
      true
    );

    return {
      name,
      originalSize: originalContent.length,
      transformedSize: transformedContent.length,
      changes: this.detectChanges(originalContent, transformedContent),
      originalPreview: originalContent.slice(0, 500),
      transformedPreview: transformedContent.slice(0, 500),
    };
  }

  /**
   * Detect changes between original and transformed content.
   */
  detectChanges(original, transformed) {
    const changes = [];

    if (original.length !== transformed.length) {
      changes.push({
        type: "size",
        original: original.length,
        transformed: transformed.length,
        delta: transformed.length - original.length,
      });
    }

    const openclawCount = (original.match(/openclaw\./g) || []).length;
    const transformedOpenclawCount = (transformed.match(/openclaw\./g) || []).length;

    if (openclawCount !== transformedOpenclawCount) {
      changes.push({
        type: "openclaw_references",
        original: openclawCount,
        transformed: transformedOpenclawCount,
      });
    }

    return changes;
  }
}

export default OpenClawSkillImporter;