# AGENT_WORKSPACE.md - OmniClaw Agent Workspace

summary: Agent workspace location, file layout, privacy, backup, sandbox, and migration strategy.

Read this when explaining the agent workspace, using file tools, backing up/migrating an agent, or deciding what belongs in workspace memory.

## Core Idea

The workspace is the agent's home and durable memory. It stores agent-facing instructions, identity, preferences, local notes, skills, and task checkpoints.

It is separate from OmniClaw runtime data such as config, credentials, provider keys, channel auth, app cache, and session internals.

## Important Safety Rule

The workspace is the default working directory for workspace file tools, not a hard sandbox. Relative paths resolve against the workspace, but absolute paths or computer-access tools may reach elsewhere on the host when permissions allow it.

If isolation is required, use sandbox configuration and keep workspace access restricted. In sandbox mode, tools should operate inside the sandbox workspace, not the host workspace.

## Default Location

In this project, the active workspace lives under:

- shared workspace: workspace/
- per-agent workspaces: workspace/agents/<agentId>/

Future packaged OmniClaw installs may map this to a user data directory such as ~/.omniclaw/workspace or an app data path. The rule stays the same: one active workspace is authoritative for a run.

## Standard Files

- AGENTS.md: operating instructions, memory rules, and agent behavior contract.
- SOUL.md: personality, tone, boundaries, and trust rules.
- USER.md: who the user is and how they prefer to work.
- PROFILE.md: stable user/assistant profile facts for the active agent.
- IDENTITY.md: agent name, role, vibe, and self-description.
- TOOLS.md: local tool conventions and workflows. This guides tool use but does not create tool availability.
- AGENT_LOOP.md: lifecycle, events, queueing, wait semantics, timeouts, and self-correction rules.
- AGENT_WORKSPACE.md: this file; workspace map, privacy, backup, migration, and sandbox notes.
- HEARTBEAT.md: short checklist for heartbeat/background runs.
- BOOTSTRAP.md: one-time first-run ritual; delete after complete.
- memory/YYYY-MM-DD.md: daily/raw memory logs when used.
- MEMORY.md: curated long-term memory for private main sessions only.
- skills/: workspace-specific skills.
- canvas/: optional local UI/canvas files.

## What Does Not Belong Here

Do not store secrets in the workspace:

- API keys
- OAuth tokens
- passwords
- private credential JSON
- raw sensitive chat dumps
- provider/channel auth state

Use the secret store, environment variables, password manager, or app runtime config for secrets. If a workspace note needs a secret, store only a placeholder and a pointer.

## Missing Files

If a standard workspace file is missing, continue safely and recreate a default only when appropriate. Never overwrite an existing user-authored file during bootstrap.

## Backup Strategy

The workspace should be backed up privately because it is memory.

Recommended:

1. Use a private git repo or encrypted backup.
2. Commit only workspace memory/instructions/skills.
3. Keep credentials and runtime state out of git.
4. Use .gitignore for .env, keys, pem files, secret dumps, generated caches, and large transient outputs.

Suggested gitignore:

```gitignore
.env
**/*.key
**/*.pem
**/secrets*
node_modules/
dist/
output/
data/browser-screenshots/
data/generated/*/tmp/
```

## Migration

To move an agent workspace:

1. Copy or clone the workspace folder.
2. Configure OmniClaw to point the agent to that workspace.
3. Seed any missing standard files without overwriting existing files.
4. Copy sessions/config/secrets separately only if needed, and keep them out of workspace git.
5. Run health checks and verify the agent loads AGENTS.md, SOUL.md, TOOLS.md, AGENT_LOOP.md, and AGENT_WORKSPACE.md.

## Multi-Agent Workspaces

Each agent may have its own workspace. The active agent should use its own workspace first, then shared workspace context. Avoid drifting between multiple active folders. If multiple workspaces exist, make the active one explicit.

## Task Artifacts

For long tasks, write artifacts under a clear task folder such as:

- PLAN.md
- STATUS.md
- CHECKPOINT.md
- NEXT.md
- SOURCES.md
- NOTES.md

This lets 1-hour and 24-hour tasks resume instead of restarting.

## Rule Of Thumb

Workspace files are memory and operating instructions. Runtime secrets and sessions are not workspace memory. Treat the workspace as private, portable, and recoverable.
