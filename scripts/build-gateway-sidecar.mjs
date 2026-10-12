import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const binariesDir = path.join(rootDir, "src-tauri", "binaries");
const bundleDir = path.join(rootDir, "dist", "sidecar");
const entryPath = path.join(rootDir, "sidecar", "omniclaw-gateway.mjs");
const bundlePath = path.join(bundleDir, "omniclaw-gateway.cjs");
const rawOutputPath = path.join(binariesDir, process.platform === "win32" ? "omniclaw-gateway.exe" : "omniclaw-gateway");
const strict = process.argv.includes("--strict") || process.argv.includes("--build");
const skipCompile = process.argv.includes("--check-only");

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

function fail(message, details = "") {
  console.error(message);
  if (details) {
    console.error(details.trim());
  }
  process.exit(1);
}

function commandOutput(command, args) {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function getTargetTriple() {
  const direct = commandOutput("rustc", ["--print", "host-tuple"]);
  if (direct) {
    return direct.split(/\s+/)[0];
  }

  const verbose = commandOutput("rustc", ["-Vv"]);
  const match = verbose?.match(/^host:\s*(\S+)/m);
  if (match?.[1]) {
    return match[1];
  }

  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }

  return null;
}

function pkgCommand() {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(rootDir, "node_modules", ".bin", `pkg${extension}`);
  if (fs.existsSync(local)) {
    return process.platform === "win32" ? path.relative(rootDir, local) : local;
  }
  return null;
}

function esbuildCommand() {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(rootDir, "node_modules", ".bin", `esbuild${extension}`);
  if (fs.existsSync(local)) {
    return process.platform === "win32" ? path.relative(rootDir, local) : local;
  }
  return null;
}

function pkgTarget() {
  if (process.env.OMNICLAW_PKG_TARGET) {
    return process.env.OMNICLAW_PKG_TARGET;
  }

  const platform = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `node22-${platform}-${arch}`;
}

fs.mkdirSync(binariesDir, { recursive: true });
fs.mkdirSync(bundleDir, { recursive: true });

if (!fs.existsSync(entryPath)) {
  fail(`Missing sidecar entry: ${entryPath}`);
}

const targetTriple = getTargetTriple();
if (!targetTriple) {
  const message = "Rust is required to name the sidecar for Tauri's target triple.";
  if (strict) {
    fail(message, "Install Rust, then rerun: npm run sidecar:build");
  }
  console.log(`${message} Skipping sidecar build.`);
  process.exit(0);
}

if (!commandOutput("rustc", ["--version"]) && process.platform === "win32") {
  console.log(`Rust not found; using Windows sidecar target fallback: ${targetTriple}`);
  console.log("Install Rust before running the full Tauri desktop installer build.");
}

const finalOutputPath = path.join(
  binariesDir,
  `omniclaw-gateway-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`,
);

if (skipCompile) {
  console.log(`Sidecar target: ${finalOutputPath}`);
  console.log(fs.existsSync(finalOutputPath) ? "Sidecar binary already staged." : "Sidecar binary not staged yet.");
  process.exit(0);
}

const pkg = pkgCommand();
if (!pkg) {
  fail("Project-local pkg compiler is missing.", "Run npm install, then rerun: npm run sidecar:build");
}

const esbuild = esbuildCommand();
if (!esbuild) {
  fail("Project-local esbuild compiler is missing.", "Run npm install, then rerun: npm run sidecar:build");
}

console.log("Bundling OmniClaw gateway sidecar");
const bundleResult = run(esbuild, [
  entryPath,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  "--external:playwright",
  "--external:playwright-core",
  "--external:playwright-core/*",
  "--external:chromium-bidi/*",
  "--outfile=" + bundlePath,
]);

if (bundleResult.error || bundleResult.status !== 0) {
  fail("Failed to bundle OmniClaw gateway sidecar.", `${bundleResult.error?.message || ""}\n${bundleResult.stdout || ""}${bundleResult.stderr || ""}`);
}

const bundledSource = fs.readFileSync(bundlePath, "utf8").replace(
  "var import_meta = {};",
  "var import_meta = { url: require(\"node:url\").pathToFileURL(process.pkg ? process.execPath : process.argv[1]).href };",
);
fs.writeFileSync(bundlePath, bundledSource);

console.log(`Compiling OmniClaw gateway sidecar for ${pkgTarget()}`);
const result = run(pkg, [
  bundlePath,
  "--target",
  pkgTarget(),
  "--output",
  rawOutputPath,
  "--compress",
  "GZip",
  "--fallback-to-source",
]);

if (result.error || result.status !== 0) {
  fail("Failed to compile OmniClaw gateway sidecar.", `${result.error?.message || ""}\n${result.stdout || ""}${result.stderr || ""}`);
}

if (!fs.existsSync(rawOutputPath)) {
  fail(`Sidecar compiler did not produce expected output: ${rawOutputPath}`);
}

if (fs.existsSync(finalOutputPath)) {
  fs.rmSync(finalOutputPath, { force: true });
}
fs.renameSync(rawOutputPath, finalOutputPath);

console.log(`Sidecar staged: ${finalOutputPath}`);
