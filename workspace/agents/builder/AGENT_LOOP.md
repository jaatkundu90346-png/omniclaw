# AGENT_LOOP.md - OmniClaw Agent Loop Lifecycle

summary: Agent loop lifecycle, event streams, wait semantics, long-run behavior, and session safety.

Read this when changing or executing real tasks, session queueing, transcript writes, streaming, tool execution, or long-running autonomous work.

## Definition

An agentic loop is the full real run of an agent:

```text
intake -> session routing -> context assembly -> model inference -> tool execution -> observations -> retry/self-correct -> streaming events -> persistence -> final reply
```

The LLM supplies reasoning. OmniClaw is the manager that serializes the run, executes tools, records observations, retries safely, streams progress, and persists the transcript.

## Lifecycle

1. Intake: accept the user message, resolve agent/session/profile, create run id.
2. Queue: serialize work per session so two runs do not corrupt transcript or tool state.
3. Context: load AGENTS.md, SOUL.md, USER.md, PROFILE.md, TOOLS.md, AGENT_LOOP.md, skills, memory, recent transcript, and runtime tool list.
4. Model decision: ask the provider for strict decisions: final answer or tool calls.
5. Execute tools: run real tools, capture stdout/stderr/output/error/status.
6. Observe: append tool observations back into the loop.
7. Self-correct: if a tool fails, choose a fix or explain the exact blocker.
8. Verify: run tests, readback, browser checks, provider health checks, or other proof.
9. Persist: save messages, tool traces, metadata, checkpoints, and final state.
10. Final: send a concise grounded answer with verification and remaining issues.

## Event Streams

Emit visible progress while work is happening:

- agent.thinking: model/manager is planning the next step.
- tool.started: a real tool is about to run.
- tool.output: partial or final output is available.
- tool.completed: tool finished successfully or with structured status.
- tool.failed: tool failed, blocked, timed out, or returned invalid output.
- agent.reviewing: verification or self-correction pass is running.
- agent.done: final answer and metadata are ready.

Do not fake events. If no tool ran, do not say one ran.

## Queueing And Session Safety

- One active run per session lane.
- Transcript/session writes must be serialized.
- Long tasks should keep checkpoints so restarts can resume.
- agent.wait waits for lifecycle end/error/timeout. A wait timeout does not mean the run stopped unless the run was explicitly aborted.

## Timeouts And Long Work

- Foreground chat can run long but must remain bounded.
- Default complex foreground target: up to about 1 hour.
- 24-hour work must become background/autonomous/scheduled work with checkpoints.
- Long commands, servers, downloads, and watchers should run in background and be monitored.
- If the model or tool stalls, emit stalled/blocked status and either retry or checkpoint.

## Self-Correction Contract

If an observation contains error, blocked, failed, timeout, non-zero exit, missing file, invalid JSON, failed test, or failed verification:

1. Do not immediately final as success.
2. Read the exact error.
3. Try one targeted correction.
4. Verify again.
5. If still blocked, final answer must say the blocker and the next repair path.

## Final Metadata

Final state should include:

- reply
- mode/profile
- provider/model
- durationMs
- stepCount
- toolCallCount
- stopReason
- fixedErrors
- remainingIssues
- verification proof

## Stop Reasons

- final: completed normally.
- max_steps: step budget exhausted.
- provider_failed: model/provider could not continue.
- tool_budget_exhausted: tool budget exhausted.
- blocked_for_approval: user approval needed.
- timeout: runtime deadline reached.
- cancelled: user cancelled.

## Rule Of Thumb

Real task means real evidence. The agent should feel like a careful operator: plan briefly, act, observe, correct, verify, then answer.
