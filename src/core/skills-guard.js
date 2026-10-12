// Skills Guard — Hermes tools/skills_guard.py parity, right-sized for OmniClaw.
//
// Every skill that ENTERS the library through a write path (agent create_skill,
// post-run skill review, curator umbrella merges, git installs, vendor imports)
// is statically scanned for known-bad patterns before it lands on disk:
// exfiltration, prompt injection, destructive commands, persistence backdoors,
// reverse shells. Bundled/hand-written skills already on disk are never
// scanned — the guard sits on the door, not inside the house.
//
// Trust levels (Hermes INSTALL_POLICY):
//   builtin       — ships with OmniClaw; never blocked.
//   trusted       — vendored Hermes/OpenClaw imports; only "dangerous" blocked.
//   community     — git installs from arbitrary URLs; "caution" AND "dangerous" blocked.
//   agent-created — the agent's own create_skill/updateSkill writes; "dangerous"
//                   blocked as an error so the model retries without the flagged content.

// (regex, id, severity, description) — severity: critical | high | medium.
// Ported from Hermes THREAT_PATTERNS, keeping the high-signal subset; a JS
// agent's skills legitimately mention shell/Node concepts, so noisy patterns
// (bare `crontab`, `process.env[`) stay at medium/high → caution, which only
// blocks untrusted community installs.
const THREAT_PATTERNS = [
  // ── Exfiltration: secrets pushed to the network ──
  [/\b(curl|wget)\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "env_exfil_http", "critical", "curl/wget interpolating a secret environment variable"],
  [/fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/i, "env_exfil_fetch", "critical", "fetch() call interpolating a secret variable"],
  [/\b(requests|httpx)\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, "env_exfil_requests", "critical", "HTTP library call with a secret variable"],
  [/cat\s+[^\n]*(\.env\b|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets_file", "critical", "reads a known secrets file"],
  [/(\$HOME|~)\/\.(ssh|aws|gnupg|kube|docker)\b/i, "cred_dir_access", "high", "references a user credential directory (~/.ssh, ~/.aws, ...)"],
  [/\bprintenv\b|\benv\s*\|/i, "dump_all_env", "high", "dumps all environment variables"],
  [/os\.getenv\s*\(\s*[^)]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i, "getenv_secret", "critical", "reads a secret via os.getenv()"],
  [/base64[^\n]{0,80}\benv\b|\benv\b[^\n]{0,80}base64/i, "encoded_exfil", "high", "base64 encoding combined with environment access"],
  [/!\[[^\]]*\]\(https?:\/\/[^)]*\$\{?/i, "md_image_exfil", "high", "markdown image URL with variable interpolation (image-based exfiltration)"],
  [/>\s*\/tmp\/\S*\s*&&\s*(curl|wget|nc|python)/i, "tmp_staging", "critical", "writes to /tmp then exfiltrates"],

  // ── Prompt injection / agent hijacking ──
  [/ignore\s+(\w+\s+)*(previous|all|above|prior)\s+instructions/i, "prompt_injection_ignore", "critical", "prompt injection: ignore previous instructions"],
  [/do\s+not\s+(\w+\s+)*tell\s+(\w+\s+)*the\s+user/i, "deception_hide", "critical", "instructs the agent to hide information from the user"],
  [/system\s+prompt\s+override/i, "sys_prompt_override", "critical", "attempts to override the system prompt"],
  [/disregard\s+(\w+\s+)*(your|all|any)\s+(\w+\s+)*(instructions|rules|guidelines)/i, "disregard_rules", "critical", "instructs the agent to disregard its rules"],
  [/(when|if)\s+no\s*one\s+is\s+(watching|looking)/i, "conditional_deception", "high", "conditional instruction to behave differently when unobserved"],
  [/act\s+as\s+(if|though)\s+(\w+\s+)*you\s+(\w+\s+)*(have\s+no|don't\s+have)\s+(\w+\s+)*(restrictions|limits|rules)/i, "bypass_restrictions", "critical", "instructs the agent to act without restrictions"],
  [/output\s+(\w+\s+)*(system|initial)\s+prompt/i, "leak_system_prompt", "high", "attempts to extract the system prompt"],
  [/<!--[^>]*(ignore|override|system prompt|hidden instruction)[^>]*-->/i, "html_comment_injection", "high", "hidden instructions in an HTML comment"],
  [/<\s*div\s+style\s*=\s*["'][\s\S]{0,120}display\s*:\s*none/i, "hidden_div", "high", "hidden HTML div (invisible instructions)"],

  // ── Destructive operations ──
  [/\brm\s+-[a-z]*rf?[a-z]*\s+([/\\]\s|[/\\]$|\/(bin|etc|usr|var|home)\b|\$HOME\b|~\/?\s*$)/i, "destructive_rm", "critical", "recursive delete targeting root or home"],
  [/Remove-Item\s+[^\n]*-Recurse[^\n]*(C:\\(\s|Windows|Users\\?$)|\$env:USERPROFILE\s*$)/i, "destructive_rm_ps", "critical", "PowerShell recursive delete targeting a system root"],
  [/>\s*\/etc\//, "system_overwrite", "critical", "overwrites a system configuration file"],
  [/\bmkfs\b|\bdd\s+[^\n]*if=[^\n]*of=\/dev\//i, "disk_destroy", "critical", "filesystem format / raw disk write"],
  [/:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, "fork_bomb", "critical", "shell fork bomb"],

  // ── Persistence / privilege escalation ──
  [/\bauthorized_keys\b/i, "ssh_backdoor", "critical", "modifies SSH authorized keys"],
  [/\/etc\/sudoers|\bvisudo\b/i, "sudoers_mod", "critical", "modifies sudoers (privilege escalation)"],
  [/\.(bashrc|zshrc|profile|bash_profile)\b[^\n]*(>>|echo|curl|wget)/i, "shell_rc_mod", "high", "writes into a shell startup file"],
  [/schtasks\s+\/create|reg\s+add\s+[^\n]*\\Run\b/i, "windows_persistence", "high", "Windows scheduled-task / registry Run-key persistence"],

  // ── Network: reverse shells and tunnels ──
  [/\bnc(at)?\s+-[a-z]*[lp]/i, "reverse_shell", "critical", "potential reverse shell listener"],
  [/\bbash\s+-i\s+>&\s*\/dev\/tcp\//i, "bash_reverse_shell", "critical", "bash /dev/tcp reverse shell"],
  [/\b(ngrok|localtunnel|serveo)\b/i, "tunnel_tool", "medium", "references a tunneling tool"],

  // ── Obfuscation ──
  [/\b(eval|exec)\s*\(\s*(atob|base64|Buffer\.from)\s*\(/i, "decode_exec", "critical", "decodes then executes hidden payload"],
  [/echo\s+[A-Za-z0-9+/=]{60,}\s*\|\s*base64\s+(-d|--decode)\s*\|\s*(sh|bash)/i, "base64_pipe_sh", "critical", "base64 payload piped into a shell"],
];

const INSTALL_POLICY = {
  builtin: { safe: "allow", caution: "allow", dangerous: "allow" },
  trusted: { safe: "allow", caution: "allow", dangerous: "block" },
  community: { safe: "allow", caution: "block", dangerous: "block" },
  "agent-created": { safe: "allow", caution: "allow", dangerous: "block" },
};

/**
 * Scan one text blob (usually a SKILL.md) for threat patterns.
 * @returns {Array<{id, severity, description, file, match}>}
 */
export function scanSkillText(text, { file = "SKILL.md" } = {}) {
  const findings = [];
  const body = String(text || "");
  if (!body) return findings;
  for (const [regex, id, severity, description] of THREAT_PATTERNS) {
    const match = body.match(regex);
    if (match) {
      findings.push({ id, severity, description, file, match: String(match[0]).slice(0, 120) });
    }
  }
  return findings;
}

// Hermes _determine_verdict: any critical → dangerous; any other finding → caution.
export function determineVerdict(findings = []) {
  if (!findings.length) return "safe";
  if (findings.some((finding) => finding.severity === "critical")) return "dangerous";
  return "caution";
}

/**
 * Hermes should_allow_install: combine verdict + source trust level.
 * @returns {{allowed: boolean, reason: string}}
 */
export function shouldAllowInstall(verdict, trust = "community") {
  const policy = INSTALL_POLICY[trust] || INSTALL_POLICY.community;
  const action = policy[verdict] || "block";
  if (action === "allow") {
    return { allowed: true, reason: `Allowed (${trust} source, ${verdict} verdict)` };
  }
  return { allowed: false, reason: `Blocked (${trust} source + ${verdict} verdict)` };
}

export function formatFindings(findings = []) {
  return findings
    .slice(0, 8)
    .map((finding) => `[${finding.severity}] ${finding.id} in ${finding.file}: ${finding.description} (matched: "${finding.match}")`)
    .join("; ");
}

/**
 * One-call guard for skill write paths. Throws with a findings report when the
 * content must not land on disk; otherwise returns the scan result so callers
 * can log caution verdicts.
 */
export function assertSkillContentAllowed(content, { name = "skill", trust = "agent-created", file = "SKILL.md" } = {}) {
  const findings = scanSkillText(content, { file });
  const verdict = determineVerdict(findings);
  const { allowed, reason } = shouldAllowInstall(verdict, trust);
  if (!allowed) {
    throw new Error(
      `Skills guard blocked "${name}": ${reason}. Findings: ${formatFindings(findings)}. ` +
      "Remove the flagged content and retry — skills must not contain secret exfiltration, prompt injection, destructive commands, or persistence backdoors.",
    );
  }
  return { verdict, findings, reason };
}

export default { scanSkillText, determineVerdict, shouldAllowInstall, formatFindings, assertSkillContentAllowed };
