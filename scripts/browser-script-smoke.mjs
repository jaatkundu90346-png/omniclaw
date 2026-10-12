// browser-script-smoke — every case here is a REAL browser_evaluate failure
// pulled from data/gateway.json before the fix. They must all evaluate cleanly.
//
//   node scripts/browser-script-smoke.mjs

import vm from "node:vm";
import { normalizeBrowserScript } from "../src/core/browser-script.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Stand-in for the page: run the emitted expression the way page.evaluate does.
function evaluateLikeAPage(expression, sandbox = {}) {
  const context = vm.createContext({
    document: { title: "OmniClaw", querySelector: () => ({ textContent: "42", value: "" }) },
    window: {},
    getComputedStyle: () => ({ display: "none" }),
    JSON,
    ...sandbox,
  });
  return vm.runInContext(expression, context, { timeout: 2000 });
}

async function expectValue(label, raw, assert, args) {
  const { expression, mode } = normalizeBrowserScript(raw, args);
  try {
    const value = await evaluateLikeAPage(expression);
    check(`${label} [${mode}]`, assert(value), `-> ${JSON.stringify(value)}`);
  } catch (error) {
    check(`${label} [${mode}]`, false, `${error.message} | emitted: ${expression.slice(0, 90)}`);
  }
}

// ── The four production SyntaxErrors ────────────────────────────────────────
await expectValue(
  "top-level return (was: Illegal return statement)",
  "return document.title;",
  (v) => v === "OmniClaw",
);

await expectValue(
  "bare object literal (was: Unexpected token ':')",
  "{score: 42, over: false}",
  (v) => v?.score === 42 && v?.over === false,
);

await expectValue(
  "declaration + return (was: Unexpected end of input)",
  "const el = document.querySelector('#score');\nreturn { score: el.textContent };",
  (v) => v?.score === "42",
);

// The same declaration twice in a row must not collide — an IIFE scopes it.
{
  const first = normalizeBrowserScript("const editor = 1; return editor;");
  const second = normalizeBrowserScript("const editor = 2; return editor;");
  let ok = true;
  let detail = "";
  try {
    const context = vm.createContext({});
    vm.runInContext(first.expression, context);
    vm.runInContext(second.expression, context);
  } catch (error) {
    ok = false;
    detail = error.message;
  }
  check("re-declaration across calls (was: 'editor' has already been declared)", ok, detail);
}

// ── Idioms that already worked must keep working ────────────────────────────
await expectValue("bare expression", "document.title", (v) => v === "OmniClaw");
await expectValue("arrow function literal", "() => document.title", (v) => v === "OmniClaw");
await expectValue("function literal with args", "function (a, b) { return a + b; }", (v) => v === 7, [3, 4]);
await expectValue("trailing semicolon expression", "document.title;", (v) => v === "OmniClaw");

// ── Convenience + safety ────────────────────────────────────────────────────
await expectValue(
  "implicit return of last statement",
  "const a = 2;\nconst b = 3;\na * b",
  (v) => v === 6,
);

{
  // Top-level await must not be emitted as a bare expression.
  const { mode } = normalizeBrowserScript("const r = await Promise.resolve(5); return r;");
  check("top-level await uses async wrapper", mode === "statement-body", `mode=${mode}`);
}

{
  // Broken JS stays broken — we must not paper over the model's real mistake.
  const { mode } = normalizeBrowserScript("const x = ;");
  check("unparseable source passes through", mode === "unparsed", `mode=${mode}`);
}

{
  const { expression, mode } = normalizeBrowserScript("   ");
  check("empty source", mode === "empty" && expression === "");
}

console.log(failures === 0 ? "\nbrowser-script-smoke: all checks passed" : `\nbrowser-script-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
