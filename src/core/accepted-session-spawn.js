function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeOptionalString(value) {
  const text = String(value == null ? "" : value).trim();
  return text || "";
}

export function normalizeAcceptedSessionSpawnResult(result) {
  const details = asRecord(asRecord(result)?.details);
  if (!details || details.status !== "accepted") {
    return null;
  }
  const runId = normalizeOptionalString(details.runId);
  const childSessionKey = normalizeOptionalString(details.childSessionKey);
  if (!runId || !childSessionKey) {
    return null;
  }
  return { runId, childSessionKey };
}

export function hasAcceptedSessionSpawn(acceptedSessionSpawns = []) {
  return (Array.isArray(acceptedSessionSpawns) ? acceptedSessionSpawns : []).some((spawn) => {
    const record = asRecord(spawn);
    return Boolean(
      normalizeOptionalString(record?.runId) &&
        normalizeOptionalString(record?.childSessionKey),
    );
  });
}
