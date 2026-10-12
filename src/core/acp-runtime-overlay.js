export function isAcpSessionKey(sessionKey = "") {
  return /^agent:[^:]+:acp:[^:]+$/i.test(String(sessionKey || "").trim());
}

export function applyAcpRuntimeOverlay(meta = {}, sessionKey = "", acpRuntime = false, acpBackend = "") {
  if (acpRuntime === true && isAcpSessionKey(sessionKey)) {
    const id = String(acpBackend || "").trim() || "acpx";
    return { id, source: "session-key" };
  }
  return {
    id: String(meta.id || "implicit").trim(),
    source: String(meta.source || "implicit").trim(),
  };
}

export function getAcpSessionRuntimeMetadata(session = {}) {
  return applyAcpRuntimeOverlay(
    {
      id: session.runtime || session.backend || "implicit",
      source: session.runtime ? "provider" : "implicit",
    },
    session.key,
    session.runtime === "acp" || Boolean(session.acpRuntime),
    session.backend,
  );
}
