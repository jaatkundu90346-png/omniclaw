# AGENT_RUNTIME.md - OmniClaw Agent Runtime

summary: Agent runtime, workspace contract, session bootstrap, steering, model refs, and runtime boundaries.

Read this when changing agent runtime, workspace bootstrap, session behavior, streaming, steering, or provider/model resolution.

## Runtime Contract

OmniClaw runs an embedded local agent runtime behind the gateway. Each active agent has:

- an agent id
- a workspace
- bootstrap/context files
- sessions
- provider/model configuration
- tools and skills
- event streams
- queueing and persistence

The runtime turns a message into a real run:

```text
gateway intake -> session resolution -> workspace/context bootstrap -> provider/model call -> tool loop -> streamed events -> transcript persistence -> final reply
```

## Workspace Requirement

The agent workspace is the default working directory for workspace tools and the source of bootstrap context. It is required for stable identity and memory.

In this project:

- shared workspace: workspace/
- per-agent workspace: workspace/agents/<agentId>/

Use AGENT_WORKSPACE.md for layout, backup, migration, and sandbox rules.

## Bootstrap Files Injected

OmniClaw injects user-editable workspace files into Project Context:

- AGENTS.md: operating instructions and memory behavior.
- SOUL.md: persona, boundaries, tone.
- TOOLS.md: tool conventions and preferred workflows. It does not create tool availability.
- AGENT_LOOP.md: lifecycle, events, queueing, wait semantics, and self-correction.
- AGENT_WORKSPACE.md: workspace layout, privacy, backup, migration, and sandbox notes.
- AGENT_RUNTIME.md: runtime/session/bootstrap contract.
- BOOTSTRAP.md: one-time first-run ritual; delete after completion.
- IDENTITY.md: agent name/role/vibe.
- USER.md: user profile and preferred address.
- PROFILE.md: stable user/assistant facts.
- HEARTBEAT.md: heartbeat checklist.

Blank files may be skipped. Large files are truncated with a marker. Missing files should not crash the run; seed safe defaults without overwriting user-authored files.

BOOTSTRAP.md should only exist for a brand-new agent/workspace or unfinished first-run ritual. Once the ritual completes, delete BOOTSTRAP.md and do not recreate it on restart.

## Built-In Tools

Core tools such as read/write/edit, exec/terminal, browser, web search/fetch, memory, provider status, tasks, and channel setup are runtime-owned and policy-gated.

TOOLS.md is guidance for how the agent should use tools. It does not decide which tools exist. Tool availability comes from runtime registry, config, permissions, skills, and plugins.

## Skills

Skills should load by precedence:

1. workspace skills
2. project/agent skills
3. personal skills
4. managed/local skills
5. bundled skills
6. extra configured skill folders

When names collide, the closest workspace/agent-specific skill should win. Skills teach procedures; tools perform actions.

## Runtime Boundaries

The provider/model supplies reasoning. OmniClaw owns:

- session management
- workspace discovery
- bootstrap/context injection
- tool registry and tool execution
- permissions and approvals
- event streaming
- channel delivery
- transcript and metadata persistence
- checkpoints/background/autonomous tasks

Do not confuse provider output with real action. A model can request a tool; only OmniClaw can execute it.

## Sessions

Sessions have stable ids chosen by OmniClaw. Transcript storage is runtime-owned and separate from workspace memory.

Session rules:

- Preserve ordered user/assistant/tool messages.
- Keep one active run per session lane.
- Persist final answer, tool observations, metadata, and stop reason.
- Avoid reading legacy session folders from unrelated tools unless explicitly migrated.

## Steering While Streaming

If a new prompt arrives while a run is active, default behavior should be steering, not corruption:

- steer: deliver the new input after current assistant tool calls complete, before next model call.
- followup: queue for a later turn.
- collect: collect multiple messages for later processing.
- interrupt: abort the active run and start/queue the new request.

Steering must not skip remaining tool calls from the current assistant message.

## Streaming And Chunking

Assistant deltas, tool events, and lifecycle events should stream as they happen.

Useful event groups:

- lifecycle: start/end/error.
- assistant: token/block deltas.
- tool: start/output/end/failure.
- agent: thinking/reviewing/done.

Block streaming should avoid spam. Coalesce tiny chunks and prefer paragraph/newline/sentence boundaries when shaping output for channels.

Verbose tool summaries should be real and trace-backed. Do not emit fake progress lines.

## Model References

Model refs should support provider/model format.

Examples:

- openrouter/moonshotai/kimi-k2
- nvidia/moonshotai/kimi-k2.6
- openai/gpt-4o-mini

Parse on the first slash only. Model ids may contain additional slashes. If the provider is omitted, resolve an alias or unique configured model match before falling back to default provider/model.

If a default provider no longer exposes the configured model, fall back to a valid configured provider/model and report the change.

## Minimal Configuration

At minimum, OmniClaw needs:

- active workspace
- provider/base URL/model/key or local model config
- permissions/tool policy
- channel allowlist when messaging channels are enabled

Provider keys and channel credentials do not belong in workspace files.

## Timeouts

- wait timeout is only how long the caller waits; it should not always stop the agent.
- runtime timeout bounds the whole run.
- model idle timeout bounds silent model streams.
- provider HTTP timeout bounds provider fetch/connect/body.
- cron/background timeout owns scheduled task execution.

Slow local/self-hosted providers may need longer model/provider timeouts, but runtime timeout must be at least as high as the longest expected model/tool operation.

## End Conditions

A run can end because:

- final answer produced
- max steps reached
- provider failed
- tool budget exhausted
- approval required
- timeout
- cancellation/interruption
- gateway shutdown/disconnect

Always persist the stop reason.
