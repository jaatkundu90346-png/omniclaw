export const DEFAULT_BLOCKED_PATTERNS = [
  String.raw`\brm\s+-rf\b`,
  String.raw`\bRemove-Item\b[\s\S]*-Recurse\b[\s\S]*-Force\b`,
  String.raw`\bdel\s+/[sq]\b`,
  String.raw`\brmdir\s+/[sq]\b`,
  // Disk-format ONLY (format C:, format /FS:NTFS D:) — must NOT blanket-block the
  // PowerShell Format-* cmdlets (Format-Table/List) or a `--format json` flag.
  String.raw`\bformat\s+(?:/\S+\s+)*[A-Za-z]:`,
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
  { pattern: String.raw`-e(nc|ncodedcommand)\b`, reason: "powershell encoded command" },
  { pattern: String.raw`\biex\b|\binvoke-expression\b`, reason: "dynamic code execution" },
  { pattern: String.raw`\bfrombase64string\b`, reason: "base64-decoded execution" },
  { pattern: String.raw`>\s*[^&]`, reason: "writes output to disk" },
  { pattern: String.raw`\b(npm|pnpm|yarn)\s+(install|add|remove|update)\b`, reason: "package mutation" },
  { pattern: String.raw`\bgit\s+(checkout|switch|merge|rebase|commit|push|pull)\b`, reason: "git mutation" },
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: String.raw`\|`, reason: "command pipeline" },
  { pattern: String.raw`;\s*\S|&&|\|\||\$\(`, reason: "command chaining or substitution" },
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

// A blocked command must TEACH, not just refuse. Live 2026-09-27: after
// `npm install` failed with ENOTEMPTY the model tried to nuke the folder
// (`Stop-Process -Name node` + `Remove-Item .\node_modules -Recurse -Force`).
// The policy correctly blocked the recursive delete, but the observation was a
// bare regex — nothing the model could act on, so it kept going and burned
// rounds "thinking". Every hint names the safe alternative.
export function shellBlockHint(command = "", blockedPattern = "") {
  const text = String(command || "");
  const hints = [];
  if (/\b(Stop-Process|taskkill)\b/i.test(text) && /-Name\s+node\b|\/IM\s+node\.exe/i.test(text)) {
    hints.push('Killing ALL node processes also kills OmniClaw itself (it runs on node), which kills the very run you are in. Kill only a specific process id via the `process_kill` tool, or stop trying and continue with the task.');
  }
  if (/\bRemove-Item\b/i.test(text) && /-Recurse/i.test(text)) {
    hints.push('A recursive delete is destructive, so it is blocked on purpose. Ask the user to confirm, or use the dedicated `delete_computer_path` tool instead of the shell.');
  }
  if (/\brm\s+-rf\b/i.test(text)) {
    hints.push('`rm -rf` is not PowerShell and is blocked. Use the dedicated `delete_computer_path` tool, or `Remove-Item <path> -Recurse -Force` after the user confirms.');
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(text)) {
    hints.push('`git reset --hard` discards uncommitted work. Show the user `git diff` first, or ask before discarding anything.');
  }
  if (/\bgit\s+clean\b/i.test(text)) {
    hints.push('`git clean` deletes untracked files. Confirm with the user first; prefer `git status` to see what is untracked.');
  }
  if (/\bdiskpart\b|\bshutdown\b|\bRestart-Computer\b/i.test(text)) {
    hints.push('This is a machine-level destructive action — the user must run it themselves (or approve it in the UI).');
  }
  if (/\bformat\s+[A-Za-z]:/i.test(text)) {
    hints.push('Formatting a drive destroys all data on it. Never do this from a task; the user must do it deliberately.');
  }
  if (!hints.length && blockedPattern) {
    hints.push('Rewrite the command so it does not match the blocked pattern, or use a dedicated tool for this job instead of the shell.');
  }
  return hints.join(" ");
}

export function analyzeShellCommand(command, policy = {}) {
  const normalized = normalizeShellPolicy(policy);
  // Normalize Unicode (NFKC) so fullwidth / compatibility homoglyphs can't slip
  // past the word-boundary patterns (e.g. fullwidth "ｒｍ" -> "rm").
  const text = String(command || "").normalize("NFKC").trim();
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
