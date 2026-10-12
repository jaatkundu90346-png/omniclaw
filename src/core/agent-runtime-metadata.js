import { applyAcpRuntimeOverlay } from "./acp-runtime-overlay.js";

export function resolveProviderRuntimeMetadata(providerInfo = {}) {
  const mode = String(providerInfo.mode || "").trim();
  const id = String(providerInfo.id || "").trim();
  const command = String(providerInfo.command || "").trim();

  if (mode === "account-bridge" || id === "codex-cli") {
    return {
      id: id || command || "account-bridge",
      source: "provider",
    };
  }

  if (id) {
    return {
      id,
      source: "provider",
    };
  }

  if (mode) {
    return {
      id: mode,
      source: "provider",
    };
  }

  return {
    id: "auto",
    source: "implicit",
  };
}

export function resolveSessionRuntimeMetadata({
  providerInfo = {},
  session = {},
  acpRuntime = false,
  acpBackend = "",
} = {}) {
  return applyAcpRuntimeOverlay(
    resolveProviderRuntimeMetadata(providerInfo),
    session.key,
    acpRuntime || session.runtime === "acp" || Boolean(session.acpRuntime),
    acpBackend || session.backend || "",
  );
}
