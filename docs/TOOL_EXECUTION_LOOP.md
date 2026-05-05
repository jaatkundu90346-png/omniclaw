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

Important rule:

- The assistant must not say it is researching, searching, reading, or executing unless the run contains actual tool outputs for that work.

Hang hardening:

- Web research requests use per-request timeouts.
- Provider calls use a timeout.
- Chat smoke tests assert that research requests execute `web_research`.

This prevents the classic failure mode where an LLM says "I am researching" but no backend tool actually runs.
