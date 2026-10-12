// One-shot arch-boundary scan — no dynamic node: imports in src/, no --pretty=format.
import fs from "node:fs";
import path from "node:path";

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "vendor", ".git", "dist", "data", "tmp"].includes(e.name)) walk(p, acc);
    } else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

let violations = 0;
const dynRe = /await\s+import\s*\(\s*[`'"]node:/g;
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  let m;
  while ((m = dynRe.exec(s))) {
    console.log(`VIOLATION dyn-import: ${f}:${s.slice(0, m.index).split("\n").length}`);
    violations++;
  }
}
const serverSrc = fs.readFileSync("server.js", "utf8");
if (/pretty=format:/.test(serverSrc)) { console.log("VIOLATION pretty-format in server.js"); violations++; }
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  if (/pretty=format:/.test(s)) { console.log(`VIOLATION pretty-format: ${f}`); violations++; }
}
console.log(violations === 0 ? "ARCH BOUNDARIES CLEAN" : `${violations} VIOLATION(S)`);
process.exit(violations === 0 ? 0 : 1);
