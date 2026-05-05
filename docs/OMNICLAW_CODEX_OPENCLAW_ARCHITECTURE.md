# OmniClaw: Codex + OpenClaw Architecture

OmniClaw combines two ideas:

- Codex-style agent work loop: understand, plan, act with tools, observe output, then respond.
- OpenClaw-style control plane: a local gateway UI for chat, sessions, approvals, agents, nodes, memory, plugins, and settings.

## Core Model

The LLM provider is the brain. It interprets the user request and writes the final response.

OmniClaw is the hands and eyes. It exposes local capabilities safely:

- Eyes: files, workspace state, system status, process lists, connector inboxes, logs, memory, browser and media inspection.
- Hands: shell commands, builds, tests, file writes, task execution, connector actions, plugin tools, scheduled jobs.
- Nerves: session state, event stream, approval gates, shell audit, device trust, and runtime policy.

## Runtime Loop

```text
user message
-> intent detection
-> planner chooses safe tool steps
-> tool execution records observations
-> provider/brain summarizes observations
-> session, memory, gateway events update
-> human reply
```

## Product Rule

The user should not see raw runtime logs for normal chat. Raw plan, intents, and tool outputs can remain available in the control UI, but the chat reply should sound like a useful operator:

- for greetings, reply naturally
- for setup questions, explain API key and offline mode clearly
- for build/test/release requests, actually run the safe commands
- for risky commands, create approval requests
- for missing API keys, fall back to the offline task engine and tell the user how to connect the real brain

## Next Milestones

1. Broaden hands: real file edit actions, richer project build recipes, and browser inspection.
2. Broaden eyes: screenshot/page inspection, log summaries, dependency status, and app health diagnosis.
3. Improve brain: provider tool-call JSON schema, multi-step loops, self-correction after failed tool runs.
4. Improve UI: separate human reply from raw execution trace, with expandable observations.
