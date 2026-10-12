import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const strict = process.argv.includes("--strict");
const packageJson = readJson("package.json");
const hasProjectTauriCli = Boolean(packageJson.value?.devDependencies?.["@tauri-apps/cli"]);
const hasProjectPkg = Boolean(packageJson.value?.devDependencies?.["@yao-pkg/pkg"]);

function commandVersion(name, args = ["--version"]) {
  const command = process.platform === "win32" && name.endsWith(".cmd") ? "cmd.exe" : name;
  const commandArgs = process.platform === "win32" && name.endsWith(".cmd") ? ["/d", "/c", name, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) {
    return { ok: false, value: result.error.code || result.error.message };
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return { ok: result.status === 0, value: output || `exit ${result.status}` };
}

function localBin(name) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return path.join(rootDir, "node_modules", ".bin", `${name}${extension}`);
}

function commandVersionWithLocal(name, args = ["--version"]) {
  const local = localBin(name);
  if (fs.existsSync(local)) {
    return commandVersion(local, args);
  }
  return commandVersion(name, args);
}

function readJson(relativePath) {
  try {
    const fullPath = path.join(rootDir, relativePath);
    return { ok: true, value: JSON.parse(fs.readFileSync(fullPath, "utf8")) };
  } catch (error) {
    return { ok: false, value: error.message };
  }
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

const checks = [
  {
    label: "Node.js",
    required: true,
    ...commandVersion("node"),
  },
  {
    label: "Rust cargo",
    required: true,
    ...commandVersion("cargo"),
  },
  {
    label: "Rust compiler",
    required: true,
    ...commandVersion("rustc"),
  },
  {
    label: "Tauri CLI",
    required: true,
    ...commandVersionWithLocal("tauri"),
  },
  {
    label: "src-tauri/tauri.conf.json",
    required: true,
    ...readJson("src-tauri/tauri.conf.json"),
  },
  {
    label: "src-tauri/Cargo.toml",
    required: true,
    ok: fileExists("src-tauri/Cargo.toml"),
    value: fileExists("src-tauri/Cargo.toml") ? "found" : "missing",
  },
  {
    label: "src-tauri/src/main.rs",
    required: true,
    ok: fileExists("src-tauri/src/main.rs"),
    value: fileExists("src-tauri/src/main.rs") ? "found" : "missing",
  },
  {
    label: "src-tauri/capabilities/default.json",
    required: true,
    ...readJson("src-tauri/capabilities/default.json"),
  },
  {
    label: "sidecar/omniclaw-gateway.mjs",
    required: true,
    ok: fileExists("sidecar/omniclaw-gateway.mjs"),
    value: fileExists("sidecar/omniclaw-gateway.mjs") ? "found" : "missing",
  },
  {
    label: "scripts/build-gateway-sidecar.mjs",
    required: true,
    ok: fileExists("scripts/build-gateway-sidecar.mjs"),
    value: fileExists("scripts/build-gateway-sidecar.mjs") ? "found" : "missing",
  },
  {
    label: "Project-local sidecar compiler",
    required: true,
    ok: hasProjectPkg,
    value: hasProjectPkg ? "@yao-pkg/pkg declared" : "@yao-pkg/pkg missing",
  },
  {
    label: "Project-local bundler",
    required: true,
    ok: Boolean(packageJson.value?.devDependencies?.esbuild),
    value: packageJson.value?.devDependencies?.esbuild ? "esbuild declared" : "esbuild missing",
  },
];

console.log("OmniClaw desktop readiness check");
console.log(`Root: ${rootDir}`);

for (const check of checks) {
  const marker = check.ok ? "OK" : check.required ? "MISSING" : "SKIP";
  const value = typeof check.value === "string" ? check.value : "valid";
  console.log(`[${marker}] ${check.label}: ${value}`);
}

const missingRequired = checks.filter((check) => check.required && !check.ok);
if (missingRequired.length > 0) {
  console.log("");
  console.log("Desktop shell is scaffolded, but native .exe builds need the missing prerequisites above.");
  if (!hasProjectTauriCli) {
    console.log("Run npm install to install the project-local Tauri CLI.");
  }
  console.log("Install Rust, then run: npm run desktop:build");
}

if (strict && missingRequired.length > 0) {
  process.exit(1);
}
