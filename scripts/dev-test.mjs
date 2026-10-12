// Isolated verification instance (R11): separate data dir + port, so tests
// never mutate live config, profiles, workspace selection or sessions.
// Usage: npm run dev:test   (OMNICLAW_DATA_DIR=./.tmp-test-data PORT=3199)
// Windows-safe (cmd.exe cannot do inline VAR=val assignments).
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    OMNICLAW_DATA_DIR: "./.tmp-test-data",
    PORT: "3199",
  },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
