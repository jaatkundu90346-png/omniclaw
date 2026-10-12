import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniClawAgent } from "../src/core/agent.js";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-debug-"));
for (const dir of ["config", "workspace", "plugins", "connectors"]) {
  fs.cpSync(path.join(process.cwd(), dir), path.join(rootDir, dir), { recursive: true, force: true });
}
const agent = new OmniClawAgent({ rootDir });
const result = await agent.tools.run(
  "run_terminal_command",
  { command: "node -e \"console.log('omniclaw-tool-exec')\"" },
  { agentId: "main", sessionId: "debug", runId: "debug" },
);
console.log(JSON.stringify({ rootDir, policy: agent.shellExecutor.getPolicy(), result }, null, 2));
fs.rmSync(rootDir, { recursive: true, force: true });
