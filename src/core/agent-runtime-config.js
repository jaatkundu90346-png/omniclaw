function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSecretRef(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  const secretRef = String(value.secretRef || value.$secret || value.secretId || "").trim();
  if (secretRef) {
    return true;
  }
  const ref = String(value.ref || "").trim();
  if (ref.toLowerCase().startsWith("secret:")) {
    return true;
  }
  return String(value.type || "").toLowerCase() === "secret_ref" && Boolean(String(value.id || "").trim());
}

export function hasNestedSecretRef(value) {
  if (isSecretRef(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNestedSecretRef(entry));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).some((entry) => hasNestedSecretRef(entry));
}

export function collectNestedSecretRefPaths(value, basePath = "", maxPaths = 24) {
  const paths = [];
  const walk = (entry, currentPath) => {
    if (paths.length >= maxPaths) {
      return;
    }
    if (isSecretRef(entry)) {
      paths.push(currentPath || "$");
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (!isPlainObject(entry)) {
      return;
    }
    for (const [key, child] of Object.entries(entry)) {
      walk(child, currentPath ? `${currentPath}.${key}` : key);
      if (paths.length >= maxPaths) {
        break;
      }
    }
  };
  walk(value, basePath);
  return paths;
}

export function getAgentRuntimeSecretTargets(config = {}, { includeChannelTargets = false } = {}) {
  const targets = [
    ["provider", config.provider],
    ["providerProfiles", config.providerProfiles],
    ["agents", config.agents],
    ["runtime.activeMemory", config.runtime?.activeMemory],
    ["skills", config.skills],
    ["tools.web", config.tools?.web],
    ["tools.webResearch", config.tools?.webResearch],
    ["connectors", config.connectors],
    ["plugins", config.plugins],
  ];

  if (includeChannelTargets) {
    targets.push(["channels", config.channels]);
  }

  return targets;
}

export function hasAgentRuntimeSecretRefs({ config = {}, includeChannelTargets = false } = {}) {
  return getAgentRuntimeSecretTargets(config, { includeChannelTargets })
    .some(([, target]) => hasNestedSecretRef(target));
}

export function summarizeAgentRuntimeSecretRefs(config = {}, options = {}) {
  const includeChannelTargets = options.includeChannelTargets === true;
  const paths = getAgentRuntimeSecretTargets(config, { includeChannelTargets })
    .flatMap(([basePath, target]) => collectNestedSecretRefPaths(target, basePath, options.maxPaths || 24));
  return {
    present: paths.length > 0,
    count: paths.length,
    paths,
    includeChannelTargets,
  };
}
