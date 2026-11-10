// Bootstrap / first-message language + "no canned replacement" regression smoke.
//
// THE BUGS THIS GUARDS (all found on a fresh install):
//   1. The harness REPLACED the model's own answer with a canned bootstrap reply
//      ("Theek <name>, main <agent> hoon…") — the model's real question was cut.
//   2. A hardcoded user name ("Mankush") was used when the user had gave none.
//   3. The first message defaulted to Hinglish; the product rule is ENGLISH by
//      default (the user may speak English), then MIRROR the user's language.
//   4. The fresh-workspace BOOTSTRAP.md was overwritten by the vendored OpenClaw
//      template that scripts the opener ("Hey. I just came online…"), which weak
//      models paste verbatim.
//
// Unit + source-contract assertions; no server, no browser.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { detectUserLanguage } from "../src/core/language.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`ok: ${label}`); }
  else { console.error(`FAIL: ${label}`); process.exitCode = 1; }
}

console.log("step 1: language detection defaults to English");
{
  ok(detectUserLanguage("hi") === "english", "'hi' is English (not Hinglish)");
  ok(detectUserLanguage("hey there") === "english", "'hey there' is English");
  ok(detectUserLanguage("hello") === "english", "'hello' is English");
  ok(detectUserLanguage("what can you do?") === "english", "a plain English question is English");
  ok(detectUserLanguage("main theek hoon") === "hinglish", "'main theek hoon' is Hinglish");
  ok(detectUserLanguage("kya haal hai bhai") === "hinglish", "'kya haal hai bhai' is Hinglish");
  ok(detectUserLanguage("मैं ठीक हूँ") === "devanagari", "Devanagari script detected");
  ok(detectUserLanguage("") === "english", "empty input is English");
}

console.log("step 2: the hardcoded user name is gone");
{
  const src = read("src/core/agent.js");
  ok(!/["']Mankush["']/.test(src), 'agent.js no longer hardcodes a user name "Mankush"');
}

console.log("step 3: reply builders are English-first, mirror Hinglish, never paste a name");
{
  const { OmniClawAgent } = await import("../src/core/agent.js");
  const proto = OmniClawAgent.prototype;
  const fake = {
    readAgentProfileFacts: () => ({}),
    hasAgentProfile: () => false,
    buildProfileQuestionReply: () => "",
  };

  const gEn = proto.buildGreetingReply.call(fake, { agent: { id: "main" }, message: "hi", intents: ["greeting"] });
  ok(/I'?m|assistant|help/i.test(gEn) && !/Haan|hoon|kaam hai/i.test(gEn), `English greeting stays English: ${gEn.slice(0, 60)}…`);
  const gHi = proto.buildGreetingReply.call(fake, { agent: { id: "main" }, message: "kya haal hai bhai", intents: ["greeting"] });
  ok(/Haan|hoon|kaam/i.test(gHi), "Hinglish greeting mirrors Hinglish");

  const oEn = proto.buildOnboardingReply.call(fake, { agentId: "main", intents: ["greeting"], session: { messageCount: 0 }, message: "hello" });
  ok(/fresh agent|Who am I/i.test(oEn) && !/online aaya hoon|Tum kaun ho/i.test(oEn), "English onboarding is English");
  const oHi = proto.buildOnboardingReply.call(fake, { agentId: "main", intents: ["greeting"], session: { messageCount: 0 }, message: "kya haal hai" });
  ok(/online aaya hoon|Tum kaun ho/i.test(oHi), "Hinglish onboarding mirrors Hinglish");

  const dEn = proto.buildDirectRuntimeReply.call(fake, { intents: ["greeting"], message: "hi", agent: { id: "main" } });
  ok(/I'?m online/i.test(dEn) && !/Mankush|Haan /i.test(dEn), "English direct-runtime greeting is English and nameless");
  const dHi = proto.buildDirectRuntimeReply.call(fake, { intents: ["greeting"], message: "kya haal hai", agent: { id: "main" } });
  ok(/online hoon/i.test(dHi) && !/Mankush/.test(dHi), "Hinglish direct-runtime greeting mirrors Hinglish, no name");

  for (const s of [gEn, gHi, oEn, oHi, dEn, dHi]) ok(!/Mankush/.test(s), "no reply pastes a hardcoded name");
}

console.log("step 4: the harness can NOT overwrite the model's reply with a canned one");
{
  const raw = read("src/core/agent.js");
  // Compare CODE, not comments (the comment deliberately names the old bug).
  const code = raw.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const start = code.indexOf("processBootstrapStep(agentId");
  const end = code.indexOf("updateAgentProfile(agentId", start);
  const body = start > -1 && end > start ? code.slice(start, end) : "";
  ok(start > -1 && end > start, "found processBootstrapStep definition");
  ok(!/\breply\s*:/.test(body), "processBootstrapStep returns NO canned reply");
  ok(!/response\s*=\s*bootstrapResult\.reply/.test(code), "handleMessage no longer assigns response from the bootstrap");
}

console.log("step 5: the fresh BOOTSTRAP.md is English-first and not the vendored template");
{
  const src = read("src/core/workspace-bootstrap.js");
  ok(!/agentFiles\["BOOTSTRAP\.md"\]\s*=\s*readOpenClawTemplate/.test(src), "BOOTSTRAP.md is not overwritten by the vendored OpenClaw template");
  ok(/Start in \*\*English\*\*/i.test(src), "BOOTSTRAP.md tells the agent to start in English");
  ok(/in your own words/i.test(src), "BOOTSTRAP.md says to write in your own words");
  const sp = read("src/core/system-prompt.js");
  ok(/reply in English — never open in a language the user did not use/i.test(sp), "system prompt: English when the user's language is unknown");
  ok(!/do not force English unless the user uses English/i.test(sp), "system prompt no longer tells the model NOT to use English by default");
}

console.log(`\n${process.exitCode ? "bootstrap-language: FAILED" : `bootstrap-language: ALL PASS (${passed})`}`);
