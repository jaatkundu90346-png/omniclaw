// Smoke test for the fuzzy edit matcher used by the edit / multi_edit tools.
import { fuzzyFindAndReplace, findClosestSnippet } from "../src/core/fuzzy-edit.js";

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name); } };

const file = `function greet(name) {\n    console.log("hello " + name);\n    return name;\n}\n`;

// 1. exact match
let r = fuzzyFindAndReplace(file, `    return name;`, `    return name.trim();`);
t("exact match edits", r.matchCount === 1 && r.content.includes("name.trim()"));

// 2. indentation drift still applies cleanly (model used fewer spaces)
r = fuzzyFindAndReplace(file, `console.log("hello " + name);`, `console.log("HI " + name);`);
t("indent-agnostic edit lands", r.matchCount === 1 && r.content.includes("HI ") && !r.error);

// 3. multi-line indentation drift -> fuzzy strategy (not exact)
const block = `class A {\n        run() {\n            return 1;\n        }\n}\n`;
r = fuzzyFindAndReplace(block, `  run() {\n    return 1;\n  }`, `  run() {\n    return 2;\n  }`);
t("multi-line indent-flexible match", r.matchCount === 1 && r.content.includes("return 2;") && r.strategy !== "exact");

// 4. smart-quote drift from transport
r = fuzzyFindAndReplace(file, `    console.log(“hello ” + name);`, `    console.log("yo " + name);`);
t("unicode/smart-quote match", r.matchCount === 1 && r.strategy === "unicode_normalized");

// 5. no match -> error + didYouMean snippet (typo'd find)
r = fuzzyFindAndReplace(file, `    retrun nme;`, `x`);
t("no-match returns error", r.matchCount === 0 && !!r.error);
const hint = findClosestSnippet(`    retrun nme;`, file);
t("didYouMean finds closest line via bigram similarity", /return name/.test(hint));

// 6. ambiguity guard
const dup = `a\nx\nx\nb\n`;
r = fuzzyFindAndReplace(dup, `x`, `y`, false);
t("ambiguous blocked without replaceAll", r.matchCount === 0 && /matches 2 places/.test(r.error || ""));
r = fuzzyFindAndReplace(dup, `x`, `y`, true);
t("replaceAll replaces every occurrence", r.matchCount === 2);

// 7. identical strings rejected
r = fuzzyFindAndReplace(file, `return name;`, `return name;`);
t("identical find/replace rejected", r.matchCount === 0 && /identical/.test(r.error || ""));

console.log(`\nFUZZY-EDIT SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
