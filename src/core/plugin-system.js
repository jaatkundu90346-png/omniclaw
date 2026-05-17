import fs from "node:fs";
import path from "node:path";

export class PluginSDK {
  constructor({ rootDir, configStore, toolRegistry }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.toolRegistry = toolRegistry;
    this.pluginsDir = path.join(rootDir, "plugins");
    fs.mkdirSync(this.pluginsDir, { recursive: true });
  }

  createPluginManifest({ id, name, description, version, author, entryPoint, tools = [], hooks = [] }) {
    return {
      id,
      name,
      description,
      version: version || "0.1.0",
      author: author || "",
      entryPoint: entryPoint || `${id}.js`,
      tools,
      hooks,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
  }

  savePlugin(manifest) {
    const pluginDir = path.join(this.pluginsDir, manifest.id);
    fs.mkdirSync(pluginDir, { recursive: true });
    const manifestPath = path.join(pluginDir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { saved: true, path: manifestPath };
  }

  loadPlugin(id) {
    const manifestPath = path.join(this.pluginsDir, id, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Plugin "${id}" not found.`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest;
  }

  listPlugins() {
    if (!fs.existsSync(this.pluginsDir)) return [];
    const dirs = fs.readdirSync(this.pluginsDir).filter((d) => {
      const manifestPath = path.join(this.pluginsDir, d, "manifest.json");
      return fs.existsSync(manifestPath);
    });
    return dirs.map((id) => this.loadPlugin(id));
  }

  deletePlugin(id) {
    const pluginDir = path.join(this.pluginsDir, id);
    if (!fs.existsSync(pluginDir)) {
      throw new Error(`Plugin "${id}" not found.`);
    }
    fs.rmSync(pluginDir, { recursive: true, force: true });
    return { deleted: true, id };
  }

  togglePlugin(id, enabled) {
    const manifest = this.loadPlugin(id);
    manifest.enabled = enabled;
    this.savePlugin(manifest);
    return { toggled: true, id, enabled };
  }

  registerTool(pluginId, toolDef) {
    if (!this.toolRegistry) {
      throw new Error("Tool registry not available.");
    }
    this.toolRegistry.registerPluginTool(pluginId, toolDef);
    return { registered: true, pluginId, toolId: toolDef.id };
  }
}

export class PluginLoader {
  constructor({ rootDir, configStore }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.loadedPlugins = new Map();
    this.pluginHooks = new Map();
  }

  async loadPlugin(manifest) {
    if (this.loadedPlugins.has(manifest.id)) {
      return { loaded: false, reason: "already-loaded", id: manifest.id };
    }

    const pluginDir = path.join(this.rootDir, "plugins", manifest.id);
    const entryPath = path.join(pluginDir, manifest.entryPoint);

    let exports = null;
    if (fs.existsSync(entryPath)) {
      try {
        exports = await import(`file://${entryPath}`);
      } catch (error) {
        return { loaded: false, reason: "import-failed", id: manifest.id, error: error.message };
      }
    }

    const plugin = {
      manifest,
      exports,
      loadedAt: new Date().toISOString(),
      status: "loaded",
    };

    this.loadedPlugins.set(manifest.id, plugin);

    if (exports?.onLoad) {
      try {
        await exports.onLoad({ config: this.configStore?.getConfig?.() || {} });
      } catch (error) {
        plugin.status = "onLoad-failed";
        plugin.error = error.message;
      }
    }

    return { loaded: true, id: manifest.id };
  }

  async unloadPlugin(id) {
    const plugin = this.loadedPlugins.get(id);
    if (!plugin) {
      return { unloaded: false, reason: "not-loaded", id };
    }

    if (plugin.exports?.onUnload) {
      try {
        await plugin.exports.onUnload();
      } catch {}
    }

    this.loadedPlugins.delete(id);
    return { unloaded: true, id };
  }

  async reloadPlugin(id, manifest) {
    await this.unloadPlugin(id);
    return this.loadPlugin(manifest);
  }

  registerHook(hookName, pluginId, handler) {
    if (!this.pluginHooks.has(hookName)) {
      this.pluginHooks.set(hookName, []);
    }
    this.pluginHooks.get(hookName).push({ pluginId, handler });
  }

  async runHook(hookName, params) {
    const hooks = this.pluginHooks.get(hookName) || [];
    const results = [];
    for (const { pluginId, handler } of hooks) {
      try {
        const result = await handler(params);
        results.push({ pluginId, result });
      } catch (error) {
        results.push({ pluginId, error: error.message });
      }
    }
    return results;
  }

  getLoadedPlugins() {
    return Array.from(this.loadedPlugins.values()).map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      status: p.status,
      loadedAt: p.loadedAt,
      tools: p.manifest.tools?.length || 0,
      hooks: p.manifest.hooks?.length || 0,
    }));
  }

  getStatus() {
    return {
      loaded: this.loadedPlugins.size,
      plugins: this.getLoadedPlugins(),
      hooks: Array.from(this.pluginHooks.keys()),
    };
  }
}
