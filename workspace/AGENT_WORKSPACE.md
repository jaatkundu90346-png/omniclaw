# AGENT_WORKSPACE.md - OmniClaw Shared Workspace

summary: Agent workspace location, layout, privacy, backup, sandbox, and migration strategy.

The workspace is the agent's home and durable memory. It stores instructions, identity, preferences, local notes, skills, and task checkpoints.

It is separate from OmniClaw runtime data such as config, credentials, provider keys, channel auth, app cache, and session internals.

## Safety

The workspace is the default working directory for workspace file tools, not a hard sandbox. Relative paths resolve against the workspace, but absolute paths and computer-access tools may reach elsewhere on the host when permissions allow it.

If isolation is required, use sandbox configuration and keep workspace access restricted.

## Layout

- shared workspace: `workspace/`
- per-agent workspaces: `workspace/agents/<agentId>/`

Use the active agent workspace first, then shared workspace context. Avoid drifting between multiple active folders.

## Standard Files

- `AGENTS.md`: operating instructions and behavior contract.
- `SOUL.md`: persona, tone, trust, and boundaries.
- `USER.md`: user facts and preferences.
- `PROFILE.md`: stable profile facts for the active agent.
- `IDENTITY.md`: agent name, role, vibe, and self-description.
- `TOOLS.md`: local tool conventions and workflows; guidance only, not tool availability.
- `AGENT_LOOP.md`: lifecycle, events, queueing, wait semantics, timeouts, and self-correction.
- `AGENT_WORKSPACE.md`: workspace map, privacy, backup, migration, and sandbox notes.
- `HEARTBEAT.md`: short heartbeat checklist.
- `BOOTSTRAP.md`: one-time first-run ritual; delete after complete.
- `memory/YYYY-MM-DD.md`: daily/raw memory logs when used.
- `MEMORY.md`: curated long-term memory for private main sessions only.
- `skills/`: workspace-specific skills.
- `canvas/`: optional local UI/canvas files.

## What Not To Store

Do not store API keys, OAuth tokens, passwords, private credential JSON, raw sensitive chat dumps, provider/channel auth state, or app runtime secrets in the workspace.

Use the secret store, environment variables, password manager, or app runtime config for secrets.

## Backup

Back up the workspace privately. A private git repo or encrypted backup is recommended.

Commit workspace memory/instructions/skills only. Keep credentials and runtime state out of git.

Suggested `.gitignore`:

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

## Long Task Artifacts

For long tasks, write a task folder with:

- `PLAN.md`
- `STATUS.md`
- `CHECKPOINT.md`
- `NEXT.md`
- `SOURCES.md`
- `NOTES.md`

This lets 1-hour and 24-hour tasks resume instead of restarting.

## Migration

1. Copy or clone the workspace folder.
2. Configure OmniClaw to point the agent to that workspace.
3. Seed missing standard files without overwriting existing files.
4. Copy sessions/config/secrets separately only if needed, and keep them out of workspace git.
5. Run health checks and verify the agent loads `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `AGENT_LOOP.md`, and `AGENT_WORKSPACE.md`.
