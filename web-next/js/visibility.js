// Model visibility preferences (chat picker scope). Nonsecret localStorage,
// versioned + validated, recovers gracefully. Keyed by connection identity +
// exact model ID so renames/catalog refreshes preserve choices.
//
// Default policy: every newly discovered model is VISIBLE. Hiding is explicit
// per model (or per whole connection). Hiding never disconnects, never revokes
// credentials, never deletes history — the picker just stops listing it.
// Manual entries (user-typed model IDs for discovery-unsupported endpoints)
// are always listed here and toggleable like discovered models.

const LS_KEY = "omniclaw.next.modelVisibility.v1";

function blank() {
  return { version: 1, hidden: [], manual: {} };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (!raw || typeof raw !== "object" || raw.version !== 1) return blank();
    return {
      version: 1,
      hidden: Array.isArray(raw.hidden) ? raw.hidden.filter((x) => typeof x === "string") : [],
      manual: (raw.manual && typeof raw.manual === "object" && !Array.isArray(raw.manual)) ? raw.manual : {},
    };
  } catch {
    return blank();
  }
}

function save(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      version: 1,
      hidden: [...new Set(state.hidden)].slice(0, 2000),
      manual: Object.fromEntries(Object.entries(state.manual || {}).slice(0, 200)
        .map(([k, v]) => [k, (Array.isArray(v) ? v : []).filter((x) => typeof x === "string").slice(0, 200)])),
    }));
  } catch { /* private mode etc: visibility just won't persist */ }
}

export function visibilityKey(connKey, modelId) {
  return `${connKey}|${modelId}`;
}

export function isHidden(connKey, modelId) {
  return load().hidden.includes(visibilityKey(connKey, modelId));
}

export function setHidden(connKey, modelId, hidden) {
  const state = load();
  const key = visibilityKey(connKey, modelId);
  state.hidden = hidden
    ? [...new Set([...state.hidden, key])]
    : state.hidden.filter((x) => x !== key);
  save(state);
}

export function setConnectionHidden(connKey, modelIds, hidden) {
  const state = load();
  const keys = new Set(state.hidden);
  for (const id of modelIds || []) {
    const key = visibilityKey(connKey, id);
    if (hidden) keys.add(key);
    else keys.delete(key);
  }
  state.hidden = [...keys];
  save(state);
}

export function manualModels(connKey) {
  const list = load().manual[connKey];
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

export function addManualModel(connKey, modelId) {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("Model ID is required.");
  if (id.length > 200) throw new Error("Model ID is too long.");
  const state = load();
  const list = manualModels(connKey);
  if (!list.includes(id)) {
    state.manual = { ...state.manual, [connKey]: [...list, id].slice(0, 200) };
    save(state);
  }
  return id;
}

export function removeManualModel(connKey, modelId) {
  const state = load();
  const list = (state.manual[connKey] || []).filter((x) => x !== modelId);
  state.manual = { ...state.manual, [connKey]: list };
  // Removing the manual entry also clears any hidden flag for it.
  state.hidden = state.hidden.filter((x) => x !== visibilityKey(connKey, modelId));
  save(state);
}
