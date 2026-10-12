// Value-pattern secret redaction for tool output, replies, and logs.
//
// JS port of the high-value parts of Hermes's agent/redact.py (MIT). OmniClaw
// already redacts secrets by KEY NAME in structured tool results, but a secret
// VALUE that appears in free text — command stdout (`env`, `cat .env`), file
// content read by read_file, an error message, or the model's own answer — has
// no key name and slips through. This redacts by VALUE PATTERN so known
// credential shapes are masked wherever they appear.
//
// Masking: tokens >= 40 chars keep the first 4 + last 4 for debuggability;
// shorter secrets are fully masked.

function maskSecret(value) {
  const v = String(value == null ? "" : value);
  if (!v) return v;
  if (v.length < 40) return "***";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

// Known vendor API-key / token prefixes (prefix + contiguous token chars).
const PREFIX_SOURCES = [
  "sk-ant-[A-Za-z0-9_-]{10,}",        // Anthropic
  "sk-or-v1-[A-Za-z0-9_-]{10,}",      // OpenRouter
  "sk-proj-[A-Za-z0-9_-]{10,}",       // OpenAI project keys
  "sk-[A-Za-z0-9]{20,}",              // OpenAI / generic sk- (length-gated to cut false hits)
  "nvapi-[A-Za-z0-9_-]{10,}",         // NVIDIA
  "ghp_[A-Za-z0-9]{10,}",             // GitHub PAT classic
  "github_pat_[A-Za-z0-9_]{10,}",     // GitHub PAT fine-grained
  "gh[ousr]_[A-Za-z0-9]{10,}",        // GitHub oauth/user/server/refresh
  "xox[baprs]-[A-Za-z0-9-]{10,}",     // Slack
  "AIza[A-Za-z0-9_-]{30,}",           // Google API key
  "AKIA[A-Z0-9]{16}",                 // AWS Access Key ID
  "sk_live_[A-Za-z0-9]{10,}",         // Stripe live
  "sk_test_[A-Za-z0-9]{10,}",         // Stripe test
  "rk_live_[A-Za-z0-9]{10,}",         // Stripe restricted
  "sk-(?:live|test|prod|dev|free)-[A-Za-z0-9_-]{16,}", // hyphenated sk- variants (found live 2026-09-26 in agent memory)
  "SG\\.[A-Za-z0-9_-]{10,}",          // SendGrid
  "hf_[A-Za-z0-9]{10,}",              // HuggingFace
  "r8_[A-Za-z0-9]{10,}",              // Replicate
  "npm_[A-Za-z0-9]{10,}",             // npm
  "pplx-[A-Za-z0-9]{10,}",            // Perplexity
  "tvly-[A-Za-z0-9]{10,}",            // Tavily
  "gsk_[A-Za-z0-9]{10,}",             // Groq
  "fal_[A-Za-z0-9_-]{10,}",           // Fal.ai
  "gAAAA[A-Za-z0-9_=-]{20,}",         // Codex/Fernet encrypted token
];
const PREFIX_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${PREFIX_SOURCES.join("|")})(?![A-Za-z0-9_-])`, "g");

// KEY=value where KEY looks secret (env assignment in shell output).
const ENV_ASSIGN_RE = /([A-Z0-9_]{0,40}(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]{0,40})(\s*=\s*)(['"]?)([^\s'"]{4,})\3/g;

// "apiKey": "value" style JSON fields.
const JSON_FIELD_RE = /("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer|client_secret|private_key)"\s*:\s*")([^"]{4,})(")/gi;

// Authorization: Bearer <token>
const AUTH_HEADER_RE = /(Authorization:\s*Bearer\s+)(\S{8,})/gi;

// PEM private key blocks.
const PRIVATE_KEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

// DB connection-string password: scheme://user:PASSWORD@host
const DB_CONNSTR_RE = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:)([^@\s]{2,})(@)/gi;

// JWTs (header.payload[.sig]); always start with eyJ.
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){1,2}/g;

/**
 * Redact secret-shaped values from a string. Idempotent and safe on plain text
 * (returns it unchanged when nothing matches).
 */
export function redactSecrets(input) {
  if (input == null) return input;
  let text = typeof input === "string" ? input : String(input);
  if (!text) return text;
  text = text.replace(PRIVATE_KEY_RE, "[redacted-private-key]");
  text = text.replace(JWT_RE, (m) => maskSecret(m));
  text = text.replace(PREFIX_RE, (m) => maskSecret(m));
  text = text.replace(ENV_ASSIGN_RE, (_m, key, eq, q, val) => `${key}${eq}${q}${maskSecret(val)}${q}`);
  text = text.replace(JSON_FIELD_RE, (_m, pre, val, post) => `${pre}${maskSecret(val)}${post}`);
  text = text.replace(AUTH_HEADER_RE, (_m, pre, val) => `${pre}${maskSecret(val)}`);
  text = text.replace(DB_CONNSTR_RE, (_m, pre, val, at) => `${pre}${maskSecret(val)}${at}`);
  return text;
}

export { maskSecret };
