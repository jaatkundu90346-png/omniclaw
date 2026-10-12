// Reference plugin entry point.
//
// Every exported function whose name matches a tool id in plugin.json is called
// as `handler(input, context)`. `context` carries:
//   pluginId, pluginName, pluginVersion, pluginDir, rootDir
//   config  — plugin config after defaults + saved user values
//   log(...)— captured, returned alongside the tool result
//
// Instead of named exports you may export a `tools` object, or a single
// `runTool(toolId, input, context)` dispatcher. This project is `"type":
// "module"`, so a plugin `.js` file is ESM — use `export`. Name the file
// `.cjs` if you would rather write CommonJS; the loader accepts both.

export async function hello_ping(input = {}, context = {}) {
  const name = String(input.name || "world").trim() || "world";
  context.log?.(`hello_ping called for ${name}`);
  return {
    message: `${context.config?.greeting || "Hello"}, ${name}!`,
    // Computed at call time — a manifest template could not produce these.
    computedAt: new Date().toISOString(),
    plugin: `${context.pluginName} v${context.pluginVersion}`,
    node: process.version,
  };
}

export async function hello_sum(input = {}, context = {}) {
  const numbers = Array.isArray(input.numbers) ? input.numbers : [];
  const parsed = numbers.map(Number).filter((value) => Number.isFinite(value));
  if (parsed.length !== numbers.length) {
    throw new Error("numbers must be an array of finite numbers.");
  }
  context.log?.(`summing ${parsed.length} value(s)`);
  return { count: parsed.length, sum: parsed.reduce((total, value) => total + value, 0) };
}
