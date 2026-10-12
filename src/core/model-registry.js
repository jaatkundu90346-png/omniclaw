// Per-(endpoint, model) health + capability registry.
//
// A model id is meaningless without its endpoint (an OpenRouter id sent to
// Nvidia 404s; a retired Nvidia default 410s). Sub-agent binding resolution
// (A2/A3/A5), the fallback ladder, D2 model tests, and the D1/D4 pickers all
// read this instead of guessing: retired models are excluded everywhere,
// test results persist across restarts.
//
// Stored at <rootDir>/data/model-registry.json:
//   { version: 1, models: { "<baseUrl>::<model>": {
//       status, lastTested, lastError, toolCalling, parallel, retired } } }
// Statuses: ok | retired | rate_limited | no_credit | auth_error |
//           unreachable | unknown. All IO is sync + best-effort (a registry
//           failure must never break a spawn or a request).
import fs from "node:fs";
import path from "node:path";

export const MODEL_STATUS = {
  OK: "ok",
  RETIRED: "retired",
  RATE_LIMITED: "rate_limited",
  NO_CREDIT: "no_credit",
  AUTH_ERROR: "auth_error",
  UNREACHABLE: "unreachable",
  UNKNOWN: "unknown",
};

export function registryKey(baseUrl = "", model = "") {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  return `${base}::${String(model || "").trim()}`;
}

function registryFile(rootDir) {
  return path.join(rootDir || process.cwd(), "data", "model-registry.json");
}

function blankRegistry() {
  return { version: 1, models: {} };
}

export function loadModelRegistry(rootDir) {
  try {
    const raw = fs.readFileSync(registryFile(rootDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.models || typeof parsed.models !== "object") {
      return blankRegistry();
    }
    return { version: 1, models: parsed.models };
  } catch {
    return blankRegistry();
  }
}

export function saveModelRegistry(rootDir, reg) {
  try {
    const file = registryFile(rootDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(reg || blankRegistry(), null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function getModelState(rootDir, baseUrl, model) {
  if (!String(model || "").trim()) return null;
  try {
    const reg = loadModelRegistry(rootDir);
    return reg.models[registryKey(baseUrl, model)] || null;
  } catch {
    return null;
  }
}

export function isModelRetired(rootDir, baseUrl, model) {
  const state = getModelState(rootDir, baseUrl, model);
  return Boolean(state && (state.retired === true || state.status === MODEL_STATUS.RETIRED));
}

// Map a classifier reason onto a registry status (for D2 recording + ladder).
export function statusFromReason(reason = "") {
  switch (String(reason || "")) {
    case "model_retired": return MODEL_STATUS.RETIRED;
    case "rate_limit": return MODEL_STATUS.RATE_LIMITED;
    case "billing": return MODEL_STATUS.NO_CREDIT;
    case "auth": return MODEL_STATUS.AUTH_ERROR;
    case "timeout":
    case "server_error":
    case "overloaded": return MODEL_STATUS.UNREACHABLE;
    default: return MODEL_STATUS.UNKNOWN;
  }
}

function upsert(rootDir, baseUrl, model, patch) {
  try {
    const reg = loadModelRegistry(rootDir);
    const key = registryKey(baseUrl, model);
    const prev = reg.models[key] || {};
    reg.models[key] = {
      status: MODEL_STATUS.UNKNOWN,
      lastTested: "",
      lastError: "",
      toolCalling: null,
      parallel: null,
      retired: false,
      ...prev,
      ...patch,
    };
    // Keep the file bounded: newest 300 entries win (Map preserves insertion).
    const keys = Object.keys(reg.models);
    if (keys.length > 300) {
      const fresh = {};
      for (const k of keys.slice(keys.length - 300)) fresh[k] = reg.models[k];
      reg.models = fresh;
    }
    saveModelRegistry(rootDir, reg);
    return reg.models[key];
  } catch {
    return null;
  }
}

// Persist a D2 model-test outcome (or a ladder observation).
export function recordModelTest(rootDir, { baseUrl = "", model = "", ok = false, toolCalling = null, parallel = null, error = "", status = "" } = {}) {
  if (!String(model || "").trim()) return null;
  return upsert(rootDir, baseUrl, model, {
    status: status || (ok ? MODEL_STATUS.OK : MODEL_STATUS.UNKNOWN),
    lastTested: new Date().toISOString(),
    lastError: ok ? "" : String(error || "").slice(0, 300),
    ...(toolCalling !== null ? { toolCalling: Boolean(toolCalling) } : {}),
    ...(parallel !== null ? { parallel: Boolean(parallel) } : {}),
    ...(ok ? { retired: false } : {}),
  });
}

// A 404/410 (or explicit retire notice) for this exact (endpoint, model):
// never offer it again until a later test clears it.
export function markModelRetired(rootDir, baseUrl, model, error = "") {
  if (!String(model || "").trim()) return null;
  return upsert(rootDir, baseUrl, model, {
    status: MODEL_STATUS.RETIRED,
    retired: true,
    lastTested: new Date().toISOString(),
    lastError: String(error || "model retired on endpoint").slice(0, 300),
  });
}

// Every model id the registry knows for one endpoint (for pickers/D4).
export function knownModelsForEndpoint(rootDir, baseUrl) {
  try {
    const reg = loadModelRegistry(rootDir);
    const base = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
    return Object.entries(reg.models)
      .filter(([key]) => key.startsWith(`${base}::`))
      .map(([key, entry]) => ({ model: key.slice(base.length + 2), ...entry }));
  } catch {
    return [];
  }
}
