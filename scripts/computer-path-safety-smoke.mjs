// Smoke test: computer-access path safety. Verifies resolveComputerPath blocks
// sensitive credential / shell-init / system paths (Hermes file_safety.py
// equivalent) while still allowing ordinary user files.
import os from "node:os";
import fs from "node:fs";
import { FileStore } from "../src/core/file-store.js";

const config = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8"));
const policy = config.tools.computerAccess;

const store = new FileStore(process.cwd());
let passed = 0;
let failed = 0;

function blocked(p) {
  try { store.resolveComputerPath(p, policy); return false; }
  catch { return true; }
}
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

const home = os.homedir().replace(/\\/g, "/");

// Sensitive paths MUST be blocked.
ok(blocked(`${home}/.ssh/authorized_keys`), "block ~/.ssh/authorized_keys");
ok(blocked(`${home}/.ssh/id_rsa`), "block ~/.ssh/id_rsa");
ok(blocked("~/.ssh/config"), "block ~/.ssh/config (tilde form)");
ok(blocked(`${home}/.aws/credentials`), "block ~/.aws/credentials");
ok(blocked(`${home}/.gnupg/secring.gpg`), "block ~/.gnupg");
ok(blocked(`${home}/.bashrc`), "block ~/.bashrc");
ok(blocked(`${home}/.zshrc`), "block ~/.zshrc");
ok(blocked(`${home}/.npmrc`), "block ~/.npmrc");
ok(blocked(`${home}/.gitconfig`), "block ~/.gitconfig");
ok(blocked(`${home}/.config/gh/hosts.yml`), "block ~/.config/gh");
ok(blocked(`${home}/Downloads/app.env`), "block *.env files");
ok(blocked(`${home}/Documents/server.pem`), "block *.pem files");
ok(blocked(`${home}/Documents/private.key`), "block *.key files");
ok(blocked(`${home}/project/data/secrets.json`), "block secrets.json anywhere");
ok(blocked("C:/Windows/System32/drivers/etc/hosts"), "block Windows system dir");

// Ordinary user files MUST still be allowed.
ok(!blocked(`${home}/Downloads/omniclaw-output.txt`), "allow ~/Downloads/*.txt");
ok(!blocked(`${home}/Documents/notes.md`), "allow ~/Documents/*.md");
ok(!blocked(`${home}/Desktop/report.html`), "allow ~/Desktop/*.html");
ok(!blocked(`${home}/projects/app/index.js`), "allow ordinary project file");
ok(!blocked(`${home}/Downloads/config.json`), "allow non-secret config.json");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
