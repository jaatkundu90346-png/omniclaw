# OpenClaw System Prompt Research

Studied on 2026-05-04.

## Useful findings

- OpenClaw builds its own system prompt for each run instead of relying on the model provider's default assistant prompt.
- The prompt is split into fixed sections: Tooling, Safety, Skills, Workspace, current date/time or timezone, Runtime, and injected project/workspace context.
- Workspace bootstrap files are injected under Project Context so the model knows its identity without manually reading files every turn.
- Important bootstrap files are:
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - `IDENTITY.md`
  - `USER.md`
  - `HEARTBEAT.md`
  - `BOOTSTRAP.md`
  - `MEMORY.md`
- OpenClaw has prompt modes:
  - `full`: normal main-agent prompt.
  - `minimal`: smaller subagent prompt; keeps tooling/safety/workspace/runtime but drops heavier sections like skills, user identity, reply tags, messaging, and heartbeats.
  - `none`: only base identity.
- Skills are injected as a compact list with name, description, and file path. The model is expected to load full skill instructions only when needed.
- Bootstrap content is truncated by configured limits so memory and personality files do not consume the whole context window.
- Heartbeats are not just "OK" pings. They can batch proactive checks, memory maintenance, task review, and quiet-mode decisions.

## Why this matters for OmniClaw

The previous OmniClaw provider prompt made the LLM behave like a normal API chatbot because it did not consistently inject workspace identity, skills, tools, and runtime state as first-class system-prompt sections.

OmniClaw needs a prompt compiler, not just a longer prompt string.

## Implemented mapping

- Added `src/core/system-prompt.js`.
- The OpenAI-compatible provider now uses `buildOmniClawSystemPrompt(context)`.
- Skills now expose file paths so the prompt can show real skill locations.
- Workspace files are injected as Project Context.
- Runtime tools are injected as an explicit Tooling section.
- Safety and Runtime sections are fixed and stable.

## Sources

- https://docs.openclaw.ai/reference/templates/AGENTS
- https://docs.openclaw.ai/reference/templates/SOUL
- https://docs.openclaw.ai/pl/concepts/system-prompt
- https://open-claw.bot/docs/es/concepts/system-prompt/
