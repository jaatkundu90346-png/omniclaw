export const DEFAULT_BLOCKED_PATTERNS = [
  String.raw`\brm\s+-rf\b`,
  String.raw`\bRemove-Item\b[\s\S]*-Recurse\b[\s\S]*-Force\b`,
  String.raw`\bdel\s+/[sq]\b`,
  String.raw`\brmdir\s+/[sq]\b`,
  String.raw`\bformat\b`,
  String.raw`\bdiskpart\b`,
  String.raw`\bshutdown\b`,
  String.raw`\bRestart-Computer\b`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+clean\s+-fd\b`,
];

export const DEFAULT_ALLOWLIST_PATTERNS = [
  String.raw`^node\s+(-v|--version)$`,
  String.raw`^npm\s+(-v|--version)$`,
  String.raw`^npm\.cmd\s+(?:run\s+)?(build|test|portable:build|release:windows|sidecar:build)$`,
  String.raw`^pnpm\s+(-v|--version)$`,
  String.raw`^git\s+(status|branch|log|show|diff)\b`,
  String.raw`^(dir|ls)(\s+.*)?$`,
  String.raw`^Get-ChildItem\b`,
  String.raw`^Get-Content\b`,
  String.raw`^Select-String\b`,
  String.raw`^Get-Date$`,
  String.raw`^pwd$`,
];

const HIGH_RISK_PATTERNS = [
  { pattern: String.raw`\bInvoke-WebRequest\b|\bcurl\b|\bwget\b`, reason: "network download" },
  { pattern: String.raw`\|\s*(powershell|pwsh|bash|sh)\b`, reason: "download-or-pipe-to-shell pattern" },
  { pattern: String.raw`\bSet-ExecutionPolicy\b`, reason: "execution policy change" },
  { pattern: String.raw`\bStart-Process\b`, reason: "starts another process" },
  { pattern: String.raw`>\s*[^&]`, reason: "writes output to disk" },
  { pattern: String.raw`\b(npm|pnpm|yarn)\s+(install|add|remove|update)\b`, reason: "package mutation" },
  { pattern: String.raw`\bgit\s+(checkout|switch|merge|rebase|commit|push|pull)\b`, reason: "git mutation" },
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: String.raw`\|`, reason: "command pipeline" },
  { pattern: String.raw`\bpython\b|\bnode\b\s+(-e|--eval)\b`, reason: "executes inline code" },
  { pattern: String.raw`\bNew-Item\b|\bSet-Content\b|\bAdd-Content\b|\bCopy-Item\b|\bMove-Item\b`, reason: "file mutation" },
];

function matchPattern(command, patterns = []) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) {
      return pattern;
    }
  }
  return "";
}

function collectReasons(command, rules) {
  return rules.filter((rule) => new RegExp(rule.pattern, "i").test(command)).map((rule) => rule.reason);
}

export function normalizeShellPolicy(policy = {}) {
  return {
    allowlistMode: String(policy.allowlistMode || "advisory").toLowerCase(),
    allowlistPatterns: Array.isArray(policy.allowlistPatterns)
      ? policy.allowlistPatterns
      : DEFAULT_ALLOWLIST_PATTERNS,
    blockedPatterns: Array.isArray(policy.blockedPatterns)
      ? policy.blockedPatterns
      : DEFAULT_BLOCKED_PATTERNS,
    trustLevel: String(policy.trustLevel || "protected").toLowerCase(),
  };
}

export function analyzeShellCommand(command, policy = {}) {
  const normalized = normalizeShellPolicy(policy);
  const text = String(command || "").trim();
  const blockedPattern = matchPattern(text, normalized.blockedPatterns);
  const matchedAllowlist = matchPattern(text, normalized.allowlistPatterns);
  const highReasons = collectReasons(text, HIGH_RISK_PATTERNS);
  const mediumReasons = collectReasons(text, MEDIUM_RISK_PATTERNS);

  if (!text) {
    return {
      risk: "blocked",
      allowlisted: false,
      allowlistMode: normalized.allowlistMode,
      matchedAllowlist: "",
      blockedPattern: "",
      reasons: ["empty command"],
      requiresApproval: true,
    };
  }

  if (blockedPattern) {
    return {
      risk: "blocked",
      allowlisted: false,
      allowlistMode: normalized.allowlistMode,
      matchedAllowlist: "",
      blockedPattern,
      reasons: [`blocked pattern: ${blockedPattern}`],
      requiresApproval: true,
    };
  }

  const allowlisted = Boolean(matchedAllowlist);
  const reasons = [];
  if (allowlisted) {
    reasons.push(`allowlist match: ${matchedAllowlist}`);
  } else {
    reasons.push("not in allowlist");
  }
  reasons.push(...highReasons, ...mediumReasons);

  let risk = "medium";
  if (allowlisted && highReasons.length === 0 && mediumReasons.length === 0) {
    risk = "low";
  } else if (highReasons.length > 0 || (!allowlisted && normalized.allowlistMode === "enforce")) {
    risk = "high";
  }

  let requiresApproval = true;
  if (normalized.trustLevel === "full" && risk !== "blocked") {
    requiresApproval = false;
  } else if (normalized.trustLevel === "balanced") {
    requiresApproval = risk !== "low";
  }

  return {
    risk,
    allowlisted,
    allowlistMode: normalized.allowlistMode,
    trustLevel: normalized.trustLevel,
    matchedAllowlist,
    blockedPattern: "",
    reasons: [...new Set(reasons)],
    requiresApproval,
  };
}
