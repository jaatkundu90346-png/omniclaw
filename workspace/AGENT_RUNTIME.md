# AGENT_RUNTIME.md - OmniClaw Shared Runtime

summary: Agent runtime, workspace contract, session bootstrap, steering, model refs, and runtime boundaries.

OmniClaw runs an embedded local agent runtime behind the gateway. The runtime owns sessions, workspace bootstrap, tool wiring, event streams, channel delivery, permissions, and persistence.

## Runtime Flow

```text
gateway intake -> session resolution -> workspace/context bootstrap -> provider/model call -> tool loop -> streamed events -> transcript persistence -> final reply
```

The provider/model supplies reasoning. OmniClaw executes tools and persists state.

## Bootstrap Context

Workspace files injected into Project Context may include:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `AGENT_LOOP.md`
- `AGENT_WORKSPACE.md`
- `AGENT_RUNTIME.md`
- `BOOTSTRAP.md`
- `IDENTITY.md`
- `USER.md`
- `PROFILE.md`
- `HEARTBEAT.md`

Blank files may be skipped. Large files are truncated with a marker. Missing files should not crash the run.

`BOOTSTRAP.md` is one-time first-run ritual state. Delete it after completion and do not recreate it on restart.

## Tools And Skills

Runtime tools are policy-gated and registry-owned. `TOOLS.md` guides usage but does not create tool availability.

Skills should load by precedence: workspace, project/agent, personal, managed/local, bundled, then extra configured folders.

## Sessions

Sessions have stable runtime-owned ids. Keep one active run per session lane, preserve ordered transcript/tool observations, and persist final metadata and stop reason.

## Steering While Streaming

- steer: deliver new input after current assistant tool calls finish, before the next model call.
- followup: queue for later.
- collect: collect multiple messages for a later turn.
- interrupt: abort active run.

Steering must not skip remaining tool calls from the current assistant message.

## Model References

Use `provider/model` refs and parse on the first slash only. Model ids may contain more slashes.

If provider is omitted, resolve alias or unique configured model before default provider fallback. If a default model is stale, fall back to a valid configured provider/model and report it.

## Timeouts

- wait timeout: caller wait only; not necessarily cancellation.
- runtime timeout: whole run.
- model idle timeout: silent model stream.
- provider HTTP timeout: provider request.
- cron/background timeout: scheduled task.

Persist stop reasons such as `final`, `max_steps`, `provider_failed`, `tool_budget_exhausted`, `blocked_for_approval`, `timeout`, and `cancelled`.
