// L3 browser check: the workspace picker actually works in a real browser.
// Catches the class of bug unit tests miss — markup exists and CSS exists, but
// no JavaScript wired them up, so clicking does nothing and the console is clean.
import { chromium } from "playwright";

const base = process.env.OC_BASE || "http://127.0.0.1:3155";
let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2500);

console.log("\n=== Page loads clean ===");
check("no console/page errors on boot", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

console.log("\n=== Workspace chip is wired ===");
const chip = page.locator("#chip-workspace");
check("chip exists", await chip.count() === 1);
const chipText = (await page.locator("#composer-workspace").textContent().catch(() => "")) || "";
check("chip shows a folder name, not the placeholder", chipText.trim() !== "" && chipText.trim() !== "workspace", `"${chipText.trim()}"`);

console.log("\n=== Picker opens on click ===");
check("picker hidden before click", await page.locator("#ws-backdrop").isHidden());
await chip.click();
await page.waitForTimeout(1800);
check("picker visible after click", await page.locator("#ws-backdrop").isVisible());

console.log("\n=== Picker is populated (proves fetch + render) ===");
const activePath = ((await page.locator("#ws-current-path").textContent().catch(() => "")) || "").trim();
check("active path shown", activePath !== "" && activePath !== "—", activePath);
// Wait for the list to populate rather than guessing a timeout — the first
// browse call after a cold server start can be slow, and a fixed wait makes
// this test flaky for no reason.
let listed = 0;
try {
  await page.waitForSelector("#ws-list .ws-item", { timeout: 15000 });
  listed = await page.locator("#ws-list .ws-item").count();
} catch { /* leave at 0 so the check below reports it */ }
check("directory list rendered", listed > 0, `${listed} items`);

console.log("\n=== Escape closes ===");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
check("picker closed by Escape", await page.locator("#ws-backdrop").isHidden());

console.log("\n=== Branch info loaded ===");
const title = (await chip.getAttribute("title").catch(() => "")) || "";
check("chip title mentions branch or path", /branch|\\\\|:/i.test(title), title.slice(0, 120));

console.log("\n=== Real working-tree changes are visible ===");
const gitSummary = ((await page.locator("#inspector-git").textContent().catch(() => "")) || "").trim();
check("repository summary loaded", /Repo|Not a git repo|unavailable/i.test(gitSummary), gitSummary);
const gitItems = page.locator("#inspector-changes .git-change, #inspector-changes .git-clean");
check("working-tree state rendered", await gitItems.count() > 0);

// When there is a real changed file, use the exact dock flow a user uses and
// assert that the editor has an explicit line layout. This guards against the
// old inline rendering that produced broken-looking blank rows in the dock.
const firstChange = page.locator("#inspector-changes .git-change").first();
if (await firstChange.count()) {
  await firstChange.click();
  await page.waitForSelector("#pane-code.active .code-line", { timeout: 15000 });
  check("changed file opens in editor", await page.locator("#pane-code.active").count() === 1);
  const lineDisplay = await page.locator("#pane-code .code-line").first().evaluate((node) => getComputedStyle(node).display);
  check("editor uses stable line grid", lineDisplay === "grid", lineDisplay);
}

console.log("\n=== Still no errors after interaction ===");
check("no errors after interacting", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
console.log(`\nTOTAL: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
