import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const portableDir = path.join(rootDir, "dist", "windows-portable");
const releasesDir = path.join(rootDir, "dist", "releases");
const releaseStageDir = path.join(rootDir, "dist", "release-stage");
const bundleDir = path.join(rootDir, "dist", "launcher");
const launcherBundle = path.join(bundleDir, "omniclaw-launcher.cjs");
const launcherExe = path.join(portableDir, "OmniClaw.exe");
const gatewaySource = path.join(rootDir, "src-tauri", "binaries", "omniclaw-gateway-x86_64-pc-windows-msvc.exe");
const gatewayTarget = path.join(portableDir, "omniclaw-gateway.exe");
const portableDataDir = path.join(portableDir, "data");
const portableLogsDir = path.join(portableDir, "logs");

function run(command, args, options = {}) {
  if (process.platform === "win32" && command.endsWith(".cmd")) {
    return spawnSync("cmd.exe", ["/d", "/c", command, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
      ...options,
    });
  }

  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function localBin(name) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return path.join("node_modules", ".bin", `${name}${extension}`);
}

function fail(message, result) {
  console.error(message);
  if (result) {
    console.error(`${result.error?.message || ""}\n${result.stdout || ""}${result.stderr || ""}`.trim());
  }
  process.exit(1);
}

function copyIfExists(relativePath) {
  const source = path.join(rootDir, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const target = path.join(portableDir, relativePath);
  fs.cpSync(source, target, { recursive: true, force: true });
}

function writeJson(relativePath, value) {
  const target = path.join(portableDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(relativePath, value) {
  const target = path.join(portableDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
}

function findPortableLocks() {
  const query = run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$root = (Resolve-Path 'dist/windows-portable' -ErrorAction SilentlyContinue).Path; if ($root) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like \"$root*\" } | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress }",
  ]);
  const text = `${query.stdout || ""}`.trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function removeDirSafe(targetPath, label) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch (error) {
    const locks = process.platform === "win32" ? findPortableLocks() : [];
    const details = locks.length
      ? `\nRunning portable process lock(s):\n${locks.map((item) => `- ${item.ProcessId} ${item.Name}: ${item.ExecutablePath}`).join("\n")}`
      : "";
    fail(`Failed to clean ${label}: ${targetPath}`, `${error.message}${details}`);
  }
}

function releaseStamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return `${year}.${month}.${day}-${hour}${minute}${second}`;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

if (process.platform !== "win32") {
  fail("Portable Windows build must run on Windows.");
}

removeDirSafe(portableDir, "portable output");
removeDirSafe(releaseStageDir, "release staging output");
fs.mkdirSync(portableDir, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(releasesDir, { recursive: true });

const sidecarResult = run("node", ["scripts/build-gateway-sidecar.mjs", "--build"]);
if (sidecarResult.error || sidecarResult.status !== 0) {
  fail("Failed to build gateway sidecar.", sidecarResult);
}

const bundleResult = run(localBin("esbuild"), [
  "scripts/windows-launcher.mjs",
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  "--outfile=" + launcherBundle,
]);
if (bundleResult.error || bundleResult.status !== 0) {
  fail("Failed to bundle Windows launcher.", bundleResult);
}

const bundledSource = fs.readFileSync(launcherBundle, "utf8").replace(
  "var import_meta = {};",
  "var import_meta = { url: require(\"node:url\").pathToFileURL(process.pkg ? process.execPath : process.argv[1]).href };",
);
fs.writeFileSync(launcherBundle, bundledSource);

const pkgResult = run(localBin("pkg"), [
  launcherBundle,
  "--target",
  "node22-win-x64",
  "--output",
  launcherExe,
  "--compress",
  "GZip",
  "--fallback-to-source",
]);
if (pkgResult.error || pkgResult.status !== 0) {
  fail("Failed to compile Windows launcher exe.", pkgResult);
}

fs.copyFileSync(gatewaySource, gatewayTarget);
copyIfExists("public");
copyIfExists("config");
copyIfExists("connectors");
copyIfExists("plugins");
copyIfExists("skills");
copyIfExists("workspace");
copyIfExists("DESIGN.md");
writeText(
  "workspace/agents/main/PROFILE.md",
  [
    "# PROFILE",
    "",
    "- Assistant name: Main Agent",
    "- User name:",
    "- User location:",
    "- User preferences:",
    "",
    "Updated: fresh portable/profile template",
    "",
  ].join("\n"),
);
fs.mkdirSync(portableDataDir, { recursive: true });
fs.mkdirSync(portableLogsDir, { recursive: true });
writeJson("data/memory.json", {
  notes: [],
  recentConversations: [],
  research: [],
  artifacts: [],
  longTerm: [],
  dreams: [],
  promotionCandidates: [],
});
writeText("data/MEMORY.md", "# OmniClaw Memory\n\nFresh portable build. User data will be written here after launch.\n");
writeJson("data/tasks.json", { tasks: [] });
writeJson("data/sessions.json", { sessions: [] });
writeJson("data/jobs.json", { jobs: [] });
writeJson("data/schedules.json", { schedules: [] });
writeJson("data/gateway.json", { events: [], runs: [], approvals: [], delegations: [] });
writeJson("data/shell-audit.json", { records: [] });
writeJson("data/secrets.json", { providerKeys: {} });
writeText("logs/.gitkeep", "");

const manifest = {
  name: "OmniClaw Windows Portable",
  version: packageJson.version,
  builtAt: new Date().toISOString(),
  entry: "OmniClaw.exe",
  gateway: "omniclaw-gateway.exe",
  notes: [
    "Portable build excludes developer runtime data and starts with empty local data files.",
    "API keys are stored locally after first launch and are not included in the release ZIP.",
  ],
};
writeJson("RELEASE.json", manifest);

const releaseName = `OmniClaw-Windows-v${packageJson.version}-${releaseStamp()}`;
const releaseRoot = path.join(releaseStageDir, releaseName);
const zipPath = path.join(releasesDir, `${releaseName}.zip`);
fs.rmSync(zipPath, { force: true });
fs.cpSync(portableDir, releaseRoot, { recursive: true, force: true });

const zipResult = run("powershell.exe", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  `Compress-Archive -LiteralPath ${quotePowerShell(releaseRoot)} -DestinationPath ${quotePowerShell(zipPath)} -Force`,
]);
if (zipResult.error || zipResult.status !== 0) {
  fail("Failed to create Windows release ZIP.", zipResult);
}

console.log(`Portable Windows app staged: ${portableDir}`);
console.log(`Run: ${launcherExe}`);
console.log(`Release ZIP: ${zipPath}`);
