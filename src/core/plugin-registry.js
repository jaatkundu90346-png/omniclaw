import fs from "node:fs";
import path from "node:path";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickObject(value) {
  return isPlainObject(value) ? value : {};
}

function asStringList(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
}

function humanizeKey(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function createFingerprint(value) {
  return JSON.stringify(value);
}

export class PluginRegistry {
  constructor(rootDir, configStore = null, gatewayStore = null) {
    this.pluginsDir = path.join(rootDir, "plugins");
    this.configStore = configStore;
    this.gatewayStore = gatewayStore;
    this.lastLifecycleState = new Map();
    fs.mkdirSync(this.pluginsDir, { recursive: true });
  }

  listPluginDirs() {
    return fs
      .readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.pluginsDir, entry.name));
  }

  getAll() {
    return this.scanPlugins();
  }

  getById(pluginId) {
    return this.scanPlugins().find((plugin) => plugin.id === pluginId) || null;
  }

  getDetail(pluginId) {
    return this.scanPlugins({ includeRawManifest: true }).find((plugin) => plugin.id === pluginId) || null;
  }

  refreshLifecycle(reason = "manual-refresh") {
    return this.scanPlugins({
      emitEvents: true,
      reason,
    });
  }

  scanPlugins({ includeRawManifest = false, emitEvents = false, reason = "scan" } = {}) {
    const plugins = this.listPluginDirs()
      .map((pluginDir) => this.readManifest(pluginDir, { includeRawManifest }))
      .filter(Boolean);

    if (emitEvents) {
      this.emitLifecycleEvents(plugins, reason);
    }

    return plugins;
  }

  emitLifecycleEvents(plugins, reason) {
    if (!this.gatewayStore) {
      return;
    }

    const nextState = new Map();

    for (const plugin of plugins) {
      const lifecycleState = {
        fingerprint: createFingerprint({
          id: plugin.id,
          version: plugin.version,
          enabled: plugin.enabled,
          status: plugin.status,
          config: plugin.config,
          toolIds: plugin.runtime.tools.map((tool) => tool.id),
          manifestErrors: plugin.errors,
          configErrors: plugin.configStatus.errors,
        }),
        status: plugin.status,
      };
      const previous = this.lastLifecycleState.get(plugin.id);

      nextState.set(plugin.id, lifecycleState);

      if (!previous) {
        this.gatewayStore.addEvent("plugin.discovered", {
          pluginId: plugin.id,
          status: plugin.status,
          reason,
        });
      } else if (previous.fingerprint !== lifecycleState.fingerprint) {
        this.gatewayStore.addEvent("plugin.reloaded", {
          pluginId: plugin.id,
          status: plugin.status,
          reason,
        });
      }

      if (!previous || previous.status !== plugin.status) {
        this.gatewayStore.addEvent("plugin.status_changed", {
          pluginId: plugin.id,
          from: previous?.status || "unknown",
          to: plugin.status,
          reason,
        });
      }

      if (!plugin.valid) {
        this.gatewayStore.addEvent("plugin.validation_failed", {
          pluginId: plugin.id,
          errors: plugin.errors,
          reason,
        });
      } else if (!plugin.configStatus.valid) {
        this.gatewayStore.addEvent("plugin.config_invalid", {
          pluginId: plugin.id,
          errors: plugin.configStatus.errors,
          reason,
        });
      } else if (plugin.enabled) {
        this.gatewayStore.addEvent("plugin.ready", {
          pluginId: plugin.id,
          toolCount: plugin.runtime.tools.length,
          reason,
        });
      }
    }

    for (const [pluginId] of this.lastLifecycleState.entries()) {
      if (!nextState.has(pluginId)) {
        this.gatewayStore.addEvent("plugin.removed", {
          pluginId,
          reason,
        });
      }
    }

    this.lastLifecycleState = nextState;
  }

  readManifest(pluginDir, { includeRawManifest = false } = {}) {
    const manifestPath = path.join(pluginDir, "plugin.json");
    if (!fs.existsSync(manifestPath)) {
      return null;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      const pluginId = path.basename(pluginDir);
      return this.buildPluginRecord({
        pluginDir,
        manifestPath,
        manifest: {
          id: pluginId,
          name: pluginId,
          version: "0.0.0",
          description: "",
        },
        validation: {
          valid: false,
          errors: [`Invalid JSON: ${error.message}`],
          warnings: [],
        },
        includeRawManifest,
      });
    }

    return this.buildPluginRecord({
      pluginDir,
      manifestPath,
      manifest,
      validation: this.validateManifest(manifest),
      includeRawManifest,
    });
  }

  buildPluginRecord({ pluginDir, manifestPath, manifest, validation, includeRawManifest }) {
    const pluginId = String(manifest?.id || path.basename(pluginDir)).trim();
    const setup = this.normalizeSetup(manifest?.setup);
    const runtime = this.normalizeRuntime(manifest);
    const configSchema = this.normalizeConfigSchema(manifest?.configSchema, manifest?.configDefaults);
    const configDefaults = this.buildConfigDefaults(configSchema);
    const savedConfig = pickObject(this.configStore?.readUserConfig?.().pluginConfig?.[pluginId]);
    const effectiveConfig = {
      ...configDefaults,
      ...savedConfig,
    };
    const enabled = this.getEnabledState(pluginId, manifest);
    const configStatus = this.validateConfig(effectiveConfig, configSchema);
    const status = this.resolveStatus({
      enabled,
      validManifest: validation.valid,
      validConfig: configStatus.valid,
    });

    return {
      id: pluginId,
      name: String(manifest?.name || pluginId),
      version: String(manifest?.version || "0.0.0"),
      description: String(manifest?.description || ""),
      enabled,
      status,
      capabilities: asStringList(manifest?.capabilities),
      setup,
      runtime,
      tools: runtime.tools,
      configDefaults,
      configSchema,
      configFields: Object.entries(configSchema).map(([key, field]) => ({
        key,
        ...field,
        value: effectiveConfig[key],
      })),
      config: effectiveConfig,
      savedConfig,
      configStatus,
      path: pluginDir,
      manifestPath,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      rawManifest: includeRawManifest ? manifest : undefined,
    };
  }

  validateManifest(manifest) {
    const errors = [];
    const warnings = [];

    if (!isPlainObject(manifest)) {
      errors.push("Manifest must be an object.");
      return { valid: false, errors, warnings };
    }

    if (!manifest.id || typeof manifest.id !== "string") {
      errors.push("Plugin id is required.");
    }

    if (manifest.id && !/^[a-z0-9][a-z0-9_-]*$/i.test(manifest.id)) {
      errors.push("Plugin id may only contain letters, numbers, dashes, and underscores.");
    }

    if (manifest.capabilities != null && !Array.isArray(manifest.capabilities)) {
      errors.push("capabilities must be an array.");
    }

    if (manifest.setup != null && !isPlainObject(manifest.setup)) {
      errors.push("setup must be an object.");
    }

    if (manifest.runtime != null && !isPlainObject(manifest.runtime)) {
      errors.push("runtime must be an object.");
    }

    if (
      manifest.configDefaults != null &&
      (typeof manifest.configDefaults !== "object" || Array.isArray(manifest.configDefaults))
    ) {
      errors.push("configDefaults must be an object.");
    }

    if (
      manifest.configSchema != null &&
      (typeof manifest.configSchema !== "object" || Array.isArray(manifest.configSchema))
    ) {
      errors.push("configSchema must be an object.");
    }

    if (manifest.tools != null && !Array.isArray(manifest.tools)) {
      errors.push("tools must be an array when provided.");
    }

    if (Array.isArray(manifest.tools) && isPlainObject(manifest.runtime) && Array.isArray(manifest.runtime.tools)) {
      warnings.push("runtime.tools overrides legacy top-level tools.");
    }

    const runtime = pickObject(manifest.runtime);
    if (runtime.tools != null && !Array.isArray(runtime.tools)) {
      errors.push("runtime.tools must be an array.");
    }

    if (runtime.jobs != null && !isPlainObject(runtime.jobs)) {
      errors.push("runtime.jobs must be an object.");
    }

    for (const tool of this.normalizeRuntime(manifest).tools) {
      if (!tool.id || typeof tool.id !== "string") {
        errors.push("Every runtime tool requires an id.");
        continue;
      }

      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(tool.id)) {
        errors.push(`Tool id ${tool.id} is invalid.`);
      }
    }

    for (const [key, field] of Object.entries(pickObject(manifest.configSchema))) {
      if (!isPlainObject(field)) {
        errors.push(`configSchema.${key} must be an object.`);
        continue;
      }

      const type = String(field.type || "").trim() || this.inferFieldType(field.default);
      if (!["string", "number", "boolean"].includes(type)) {
        errors.push(`configSchema.${key}.type must be string, number, or boolean.`);
      }

      if (field.enum != null && !Array.isArray(field.enum)) {
        errors.push(`configSchema.${key}.enum must be an array.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  normalizeSetup(input) {
    const setup = pickObject(input);
    return {
      kind: String(setup.kind || "local-manifest"),
      summary: String(setup.summary || "Declarative local plugin setup."),
      requires: asStringList(setup.requires),
      steps: asStringList(setup.steps),
      health: pickObject(setup.health),
    };
  }

  normalizeRuntime(manifest) {
    const runtime = pickObject(manifest?.runtime);
    const rawTools = Array.isArray(runtime.tools)
      ? runtime.tools
      : Array.isArray(manifest?.tools)
        ? manifest.tools
        : [];

    const tools = rawTools
      .map((tool) => this.normalizeTool(tool))
      .filter((tool) => Boolean(tool && tool.id));

    const jobs = pickObject(runtime.jobs);
    const concurrency = Number(jobs.concurrency);

    return {
      tools,
      defaultToolId: String(runtime.defaultToolId || tools[0]?.id || ""),
      jobs: {
        enabled: jobs.enabled != null ? Boolean(jobs.enabled) : tools.length > 0,
        queue: String(jobs.queue || "default"),
        concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
      },
    };
  }

  normalizeTool(input) {
    const tool = pickObject(input);
    return {
      id: String(tool.id || "").trim(),
      description: String(tool.description || ""),
      permission: String(tool.permission || "plugin"),
      response: String(tool.response || "Plugin tool completed."),
      inputSchema: pickObject(tool.inputSchema),
      defaultInput: pickObject(tool.defaultInput),
    };
  }

  normalizeConfigSchema(rawSchema, rawDefaults) {
    const schema = pickObject(rawSchema);
    const defaults = pickObject(rawDefaults);
    const keys = new Set([...Object.keys(defaults), ...Object.keys(schema)]);
    const fields = {};

    for (const key of keys) {
      const field = pickObject(schema[key]);
      const defaultValue = field.default !== undefined ? field.default : defaults[key];
      const type = String(field.type || this.inferFieldType(defaultValue));

      fields[key] = {
        type: ["string", "number", "boolean"].includes(type) ? type : "string",
        label: String(field.label || humanizeKey(key)),
        description: String(field.description || ""),
        default: defaultValue,
        required: Boolean(field.required),
        enum: Array.isArray(field.enum) ? field.enum.map((item) => item) : [],
        min: field.min != null ? Number(field.min) : null,
        max: field.max != null ? Number(field.max) : null,
        minLength: field.minLength != null ? Number(field.minLength) : null,
        maxLength: field.maxLength != null ? Number(field.maxLength) : null,
        placeholder: String(field.placeholder || ""),
        multiline: Boolean(field.multiline),
        secret: Boolean(field.secret),
      };
    }

    return fields;
  }

  inferFieldType(defaultValue) {
    if (typeof defaultValue === "boolean") {
      return "boolean";
    }
    if (typeof defaultValue === "number") {
      return "number";
    }
    return "string";
  }

  buildConfigDefaults(configSchema) {
    const defaults = {};
    for (const [key, field] of Object.entries(configSchema)) {
      if (field.default !== undefined) {
        defaults[key] = field.default;
      }
    }
    return defaults;
  }

  getEnabledState(pluginId, manifest) {
    const config = this.configStore?.getConfig?.() || {};
    const override = config.pluginState?.[pluginId]?.enabled;
    if (override == null) {
      return manifest?.enabled !== false;
    }
    return Boolean(override);
  }

  resolveStatus({ enabled, validManifest, validConfig }) {
    if (!validManifest) {
      return "invalid-manifest";
    }
    if (!validConfig) {
      return enabled ? "invalid-config" : "disabled-invalid";
    }
    return enabled ? "ready" : "disabled";
  }

  validateConfig(config, schema) {
    const errors = [];
    const warnings = [];
    const schemaKeys = Object.keys(schema);

    for (const [key, field] of Object.entries(schema)) {
      const value = config[key];

      if (field.required && (value == null || value === "")) {
        errors.push(`${key} is required.`);
        continue;
      }

      if (value == null) {
        continue;
      }

      if (field.type === "boolean" && typeof value !== "boolean") {
        errors.push(`${key} must be a boolean.`);
        continue;
      }

      if (field.type === "boolean") {
        continue;
      }

      if (field.type === "number") {
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors.push(`${key} must be a number.`);
          continue;
        }
        if (field.min != null && value < field.min) {
          errors.push(`${key} must be >= ${field.min}.`);
        }
        if (field.max != null && value > field.max) {
          errors.push(`${key} must be <= ${field.max}.`);
        }
        if (field.enum.length > 0 && !field.enum.includes(value)) {
          errors.push(`${key} must match one of: ${field.enum.join(", ")}.`);
        }
        continue;
      }

      if (typeof value !== "string") {
        errors.push(`${key} must be a string.`);
        continue;
      }

      if (field.minLength != null && value.length < field.minLength) {
        errors.push(`${key} must be at least ${field.minLength} characters.`);
      }
      if (field.maxLength != null && value.length > field.maxLength) {
        errors.push(`${key} must be at most ${field.maxLength} characters.`);
      }
      if (field.enum.length > 0 && !field.enum.includes(value)) {
        errors.push(`${key} must match one of: ${field.enum.join(", ")}.`);
      }
    }

    const unknownKeys = Object.keys(config).filter((key) => !schemaKeys.includes(key));
    if (unknownKeys.length > 0) {
      warnings.push(`Unknown config keys: ${unknownKeys.join(", ")}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      unknownKeys,
    };
  }

  setEnabled(pluginId, enabled) {
    const plugin = this.getDetail(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    const current = this.configStore.readUserConfig();
    const nextPluginState = {
      ...(pickObject(current.pluginState)),
      [pluginId]: {
        ...(pickObject(current.pluginState?.[pluginId])),
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
      },
    };

    this.configStore.updateUserConfig({
      pluginState: nextPluginState,
    });

    return this.getById(pluginId);
  }

  updatePluginConfig(pluginId, patch = {}) {
    const plugin = this.getDetail(pluginId);
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    if (!isPlainObject(patch)) {
      throw new Error("Plugin config patch must be an object.");
    }

    if (Object.keys(plugin.configSchema).length > 0) {
      const unknownKeys = Object.keys(patch).filter((key) => !plugin.configSchema[key]);
      if (unknownKeys.length > 0) {
        throw new Error(`Unknown plugin config key(s): ${unknownKeys.join(", ")}`);
      }
    }

    const current = this.configStore.readUserConfig();
    const currentPluginConfig = pickObject(current.pluginConfig?.[pluginId]);
    const nextPluginConfig = {
      ...currentPluginConfig,
      ...patch,
    };
    const nextEffectiveConfig = {
      ...plugin.configDefaults,
      ...nextPluginConfig,
    };
    const validation = this.validateConfig(nextEffectiveConfig, plugin.configSchema);

    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    this.configStore.updateUserConfig({
      pluginConfig: {
        ...pickObject(current.pluginConfig),
        [pluginId]: nextPluginConfig,
      },
    });

    return this.getById(pluginId);
  }

  getToolDefinitions() {
    return this.getAll()
      .filter((plugin) => plugin.enabled && plugin.valid && plugin.configStatus.valid)
      .flatMap((plugin) =>
        plugin.runtime.tools.map((tool) => ({
          id: tool.id,
          description: tool.description || `Plugin tool from ${plugin.name}`,
          permission: tool.permission || "plugin",
          pluginId: plugin.id,
        })),
      );
  }

  hasTool(toolId) {
    return this.getToolDefinitions().some((tool) => tool.id === toolId);
  }

  async runTool(toolId, input = {}) {
    const plugin = this.getAll()
      .filter((item) => item.enabled && item.valid && item.configStatus.valid)
      .find((item) => item.runtime.tools.some((tool) => tool.id === toolId));

    if (!plugin) {
      throw new Error(`Unknown plugin tool: ${toolId}`);
    }

    const tool = plugin.runtime.tools.find((item) => item.id === toolId);
    const renderContext = {
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginVersion: plugin.version,
      pluginStatus: plugin.status,
      statusSuffix: plugin.config.statusBadge === false ? "" : " ready",
      ...plugin.config,
      ...tool.defaultInput,
      ...input,
    };

    return {
      pluginId: plugin.id,
      toolId,
      input,
      config: plugin.config,
      output: this.renderResponse(tool.response || "", renderContext),
    };
  }

  renderResponse(template, input) {
    return String(template || "Plugin tool completed.").replace(/\{\{(\w+)\}\}/g, (_, key) =>
      input[key] == null ? "" : String(input[key]),
    );
  }
}
