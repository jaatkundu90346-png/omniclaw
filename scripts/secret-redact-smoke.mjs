// Smoke test for value-pattern secret redaction (Hermes redact.py port).
import { redactSecrets, maskSecret } from "../src/core/secret-redact.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}
const clean = (t) => !/[A-Za-z0-9]{12,}/.test(t.replace(/…/g, "")); // no long token survives

// Vendor prefixes are masked wherever they appear (e.g. command stdout).
ok(!redactSecrets("OPENAI=sk-abcdEFGH1234567890ZZ done").includes("abcdEFGH1234567890"),
  "OpenAI sk- key masked in free text");
ok(!redactSecrets("key is sk-or-v1-abcdef0123456789abcdef").includes("abcdef0123456789"),
  "OpenRouter sk-or-v1- masked");
ok(!redactSecrets("nvapi-ABCdef0123456789ABCdef0123").includes("ABCdef0123456789"),
  "NVIDIA nvapi- masked");
ok(!redactSecrets("token=ghp_ABCDEFGHIJ1234567890").includes("ghp_ABCDEFGHIJ1234567890"),
  "GitHub PAT masked");
ok(!redactSecrets("aws AKIAIOSFODNN7EXAMPLE here").includes("AKIAIOSFODNN7EXAMPLE"),
  "AWS access key id masked");

// env assignment (cat .env / env output).
const env = redactSecrets("DATABASE_PASSWORD=supersecretvalue123\nFOO=bar");
ok(!env.includes("supersecretvalue123"), "ENV secret value masked");
ok(env.includes("FOO=bar"), "non-secret env var preserved");

// JSON field.
ok(!redactSecrets('{"apiKey":"mylongsecretkey1234567"}').includes("mylongsecretkey1234567"),
  "JSON apiKey value masked");

// Authorization header.
ok(!redactSecrets("Authorization: Bearer abcdefgh12345678ZZZZ").includes("abcdefgh12345678ZZZZ"),
  "Bearer token masked");

// DB conn string password.
const db = redactSecrets("postgres://user:dbpass1234secret@host:5432/db");
ok(!db.includes("dbpass1234secret"), "DB conn-string password masked");
ok(db.includes("user:") && db.includes("@host"), "DB conn-string structure preserved");

// Private key block.
ok(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc...\n-----END RSA PRIVATE KEY-----")
  === "[redacted-private-key]", "PEM private key block redacted");

// JWT.
ok(!redactSecrets("eyJhbGciOiJIUzI1Ni007.eyJzdWIiOiIxMjM0NTY3.abcDEF1234").includes("eyJzdWIiOiIxMjM0NTY3"),
  "JWT masked");

// Plain text untouched (no false positives).
ok(redactSecrets("Build complete. Wrote index.html (240 bytes).") === "Build complete. Wrote index.html (240 bytes).",
  "plain prose unchanged");
ok(redactSecrets("the function returns a value") === "the function returns a value",
  "ordinary English unchanged");
ok(redactSecrets("npm run build && node server.js") === "npm run build && node server.js",
  "shell command without secrets unchanged");

// maskSecret behavior. The threshold is 40: below it a value is fully masked,
// at or above it the head+tail is kept. Fixtures are built at runtime with
// repeat() so no realistic-looking key is typed out by hand.
ok(maskSecret("short") === "***", "short value fully masked");
const underThreshold = "a".repeat(30); // 30 < 40
ok(maskSecret(underThreshold) === "***", "30-char value fully masked (below the 40 threshold)");
const overThreshold = "abcd" + "m".repeat(42) + "wxyz"; // 4 + 42 + 4 = 50 >= 40
const overMasked = maskSecret(overThreshold);
ok(overMasked.startsWith("abcd") && overMasked.endsWith("wxyz") && overMasked !== "***",
  "50-char value keeps head+tail (at or above the 40 threshold)");

// Idempotent.
const once = redactSecrets("sk-abcdEFGH1234567890ZZ");
ok(redactSecrets(once) === once, "redaction is idempotent");

// null/non-string safe.
ok(redactSecrets(null) === null && redactSecrets(42) === "42", "null/number inputs handled");

void clean;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
