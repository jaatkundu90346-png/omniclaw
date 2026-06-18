# Tool Execution Loop

OmniClaw must not rely on prompt-only tools.

Correct runtime flow:

1. User message enters a session.
2. Intent engine detects likely needs.
3. Planner builds a plan.
4. Deterministic heuristic tool steps are preserved.
5. Optional model planning can add steps, but cannot erase required heuristic tool calls.
6. Runtime executes each tool through `ToolRegistry.run`.
7. Tool outputs are saved into the run record and context bundle.
8. Provider receives observations and writes the final user reply.

Agent contract:

- LLM = reasoning brain. It can decide and explain, but it cannot touch the laptop by itself.
- Tools = hands and eyes. They read files, run commands, fetch web pages, inspect browser state, and return raw observations.
- Agent = manager/orchestrator. It runs the bounded while-loop, executes tools, injects results back into the next model call, emits UI events, and stops only when the task is done or the budget is exhausted.
- `AgentLoopController` owns the V2 loop budget and event contract for real runs.

While-loop shape:

```text
user task -> build prompt/context -> model thinks -> tool calls -> execute tools
          -> append observations -> model thinks again -> repeat until done
```

Event-driven requirements:

- Emit `agent.thinking` when the manager is planning, reviewing, or asking the model for the next action.
- Emit `tool.started` / `tool.output` / `tool.completed` / `tool.failed` for deterministic plan tools.
- Emit `model_tool_loop.round_started`, `model_tool_loop.tool_started`, and `model_tool_loop.tool_completed` for provider-driven tool calls.
- Emit `agent.reviewing` when failed observations are being inspected.
- Emit `agent.done` with final metadata when a run reaches a terminal state.
- UI must render these events live so the user can see: thinking -> command/file/web action -> result -> final answer.
- When the provider supports native function calling, preserve the native transcript shape: assistant `tool_calls` message -> tool result messages -> next assistant turn. Fall back to JSON planner mode only when the provider rejects native tools or times out.

Self-correction / review cycle:

- A failed or blocked tool output must be fed back into the model tool loop instead of being hidden behind a fake final answer.
- Coding/build tasks should follow: inspect/read -> edit/write -> verify/build/test -> summarize evidence.
- After a file write, the runtime must verify the artifact. HTML artifacts use `verify_html_artifact`; other files use `read_file`.
- If auto-verification fails, the runtime starts a bounded repair pass, feeds the failed verification back to the model, executes corrective tools, then verifies again.
- The model tool-loop prompt must tell the provider not to finalize after an error unless it has either tried a safer corrective action or clearly explains why no corrective action is possible.

Step limits:

- Canonical run-level loop budget is `runtime.agentLoop.maxSteps` (default 50).
- Per-step tool budget is `runtime.agentLoop.maxToolCallsPerStep` (default 5).
- Tool loops are bounded by `runtime.modelToolLoop.maxRounds`.
- Each round is bounded by `runtime.modelToolLoop.maxToolCallsPerRound`.
- Repeated identical tool calls are capped by `runtime.modelToolLoop.maxRepeatedToolCalls`.
- When the budget is exhausted, the final answer must say what completed, what failed, and what next action remains.

Important rule:

- The assistant must not say it is researching, searching, reading, or executing unless the run contains actual tool outputs for that work.

Hang hardening:

- Web research requests use per-request timeouts.
- Provider calls use a timeout.
- Chat smoke tests assert that research requests execute `web_research`.

This prevents the classic failure mode where an LLM says "I am researching" but no backend tool actually runs.
