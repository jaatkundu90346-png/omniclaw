// Normalises the JavaScript a model hands to browser_evaluate into something a
// page can actually run.
//
// Playwright's `page.evaluate(string)` and CDP's `Runtime.evaluate` both treat
// the string as a single EXPRESSION. Models overwhelmingly write a statement
// BODY instead, and every one of these showed up in the real event log:
//
//   return document.title                -> SyntaxError: Illegal return statement
//   {score: 1, over: false}              -> SyntaxError: Unexpected token ':'
//   const editor = window.editor; ...    -> SyntaxError: Identifier 'editor' has
//                                           already been declared (the previous
//                                           call's binding is still in scope)
//   const x = 1;                         -> SyntaxError: Unexpected end of input
//
// Rather than guess with regexes, we PARSE each candidate locally with the
// Function constructor and only emit a rewrite that provably compiles. If
// nothing parses we hand the source through untouched so the page-side error
// still points at the model's real mistake.

/* eslint-disable no-new-func */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function parsesAsExpression(source) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (\n${source}\n);`);
    return true;
  } catch {
    return false;
  }
}

function parsesAsAsyncBody(source) {
  try {
    // eslint-disable-next-line no-new
    new AsyncFunction(source);
    return true;
  } catch {
    return false;
  }
}

function looksLikeFunctionLiteral(source) {
  return (
    /^(async\s+)?function\b/.test(source) ||
    /^(async\s*)?\([^)]*\)\s*=>/.test(source) ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(source)
  );
}

// REPL-style convenience: a body with no `return` yields undefined, and the
// model just sees "nothing to read". Try returning the last statement — but
// only adopt the rewrite if it still parses, so this can never turn working
// code into a syntax error.
function withImplicitReturn(source) {
  if (/(^|[\s;{}()])return(\s|;|$)/.test(source)) return source;
  const lines = source.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const candidate = lines.slice();
    candidate[i] = lines[i].replace(/^(\s*)/, "$1return ");
    const joined = candidate.join("\n");
    return parsesAsAsyncBody(joined) ? joined : source;
  }
  return source;
}

/**
 * @param {string} raw   the script the caller/model supplied
 * @param {unknown[]} args arguments, only meaningful for a function literal
 * @returns {{ expression: string, mode: string }}
 */
export function normalizeBrowserScript(raw, args = []) {
  const source = String(raw ?? "").trim();
  if (!source) return { expression: "", mode: "empty" };

  const argList = Array.isArray(args) ? args : args === undefined ? [] : [args];
  const argsJson = argList.map((value) => JSON.stringify(value)).join(", ");
  const withoutTrailingSemi = source.replace(/;\s*$/, "");

  // 1. The caller passed a function — call it, with any args.
  if (looksLikeFunctionLiteral(source)) {
    return { expression: `(${withoutTrailingSemi})(${argsJson})`, mode: "function-call" };
  }

  // 2. A genuine expression. Parenthesising is what rescues an object literal
  //    (`{a: 1}` otherwise parses as a labelled block) and is inert for
  //    everything else. Top-level `await` deliberately fails this check and
  //    falls through to the async wrapper below.
  if (parsesAsExpression(withoutTrailingSemi)) {
    return { expression: `(${withoutTrailingSemi})`, mode: "expression" };
  }

  // 3. A statement body. An async IIFE legalises `return`, scopes `const`/`let`
  //    so a re-run can't collide with the previous call's bindings, and lets
  //    the body use `await`.
  if (parsesAsAsyncBody(source)) {
    return { expression: `(async () => {\n${withImplicitReturn(source)}\n})()`, mode: "statement-body" };
  }

  // 4. Genuinely broken JS — let the page report it against the original text.
  return { expression: source, mode: "unparsed" };
}

export default normalizeBrowserScript;
