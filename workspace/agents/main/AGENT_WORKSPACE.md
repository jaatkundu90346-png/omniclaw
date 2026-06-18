# AGENT_WORKSPACE.md - OmniClaw Main Agent Workspace

summary: Agent workspace location, layout, privacy, backup, sandbox, and migration strategy.

This workspace is the main agent's home. Treat it as durable memory and operating context, not a temporary scratchpad.

## Active Workspace

- shared workspace: `workspace/`
- main agent workspace: `workspace/agents/main/`

The main agent should use its own workspace first, then shared workspace context. If another agent is routed, use that agent's workspace instead.

## Important Safety Rule

The workspace is the default working directory for workspace file tools, not a hard sandbox. Relative paths resolve against the workspace, but absolute paths and computer-access tools may reach elsewhere on the laptop when permissions allow it.

Use sandboxing for isolation. Without sandboxing, be careful with host paths, deletes, moves, and external side effects.

## Standard Files

- `AGENTS.md`: main operating instructions, memory rules, and behavior contract.
- `SOUL.md`: personality, tone, boundaries, and trust rules.
- `USER.md`: who the user is and how they prefer to work.
- `PROFILE.md`: stable user and assistant facts.
- `IDENTITY.md`: agent name, role, vibe, and self-description.
- `TOOLS.md`: tool conventions and workflows. It guides tool use but does not create tool availability.
- `AGENT_LOOP.md`: real loop lifecycle, events, queueing, wait semantics, timeouts, and self-correction.
- `AGENT_WORKSPACE.md`: this file; workspace map, privacy, backup, migration, and sandbox notes.
- `HEARTBEAT.md`: short checklist for heartbeat/background runs.
- `BOOTSTRAP.md`: one-time first-run ritual; delete after complete.
- `memory/YYYY-MM-DD.md`: daily/raw memory logs when used.
- `MEMORY.md`: curated long-term memory for private main sessions only.
- `skills/`: workspace-specific skills.
- `canvas/`: optional local UI/canvas files.

## What Does Not Belong Here

Never store real secrets in workspace files:

- API keys
- OAuth tokens
- passwords
- private credential JSON
- provider/channel auth state
- raw sensitive chat dumps

Use OmniClaw's secret store, environment variables, a password manager, or app runtime config. Workspace notes may contain placeholders only.

## Backup Strategy

Treat this workspace as private memory. Back it up privately with git or encrypted backup.

Commit:

- identity/instruction files
- skills
- curated memory
- task notes/checkpoints

Do not commit:

- secrets
- runtime credentials
- generated cache
- large transient outputs
- session internals unless deliberately migrating them separately

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

## Long Task Folder Pattern

For complex work or 24-hour automation, create a task folder and keep it resumable:

- `PLAN.md`: phases and acceptance checks.
- `STATUS.md`: current state and last successful step.
- `CHECKPOINT.md`: durable checkpoint after every phase.
- `NEXT.md`: exact next action after pause/restart.
- `SOURCES.md`: links and fetched references.
- `NOTES.md`: working notes.

On resume, read `STATUS.md` and `CHECKPOINT.md` before taking action.

## Migration

To move this workspace:

1. Copy or clone the workspace.
2. Point OmniClaw config to the new path.
3. Seed missing standard files without overwriting existing user-authored files.
4. Copy sessions/config/secrets separately only if needed.
5. Run health checks and confirm `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `AGENT_LOOP.md`, and `AGENT_WORKSPACE.md` are injected.

## Rule Of Thumb

Workspace files are memory and operating instructions. Runtime secrets and sessions are not workspace memory. Keep the workspace private, portable, and recoverable.
