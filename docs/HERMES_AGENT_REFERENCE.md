# Hermes Agent Reference for OmniClaw

Hermes Agent reference source: https://github.com/nousresearch/hermes-agent

License: MIT.

This document tracks the parts of Hermes Agent that are useful for OmniClaw V2. Hermes Agent should be treated as a reference architecture, not a direct replacement for OmniClaw. OmniClaw's goal is still the same: provide agents with real hands and eyes through tools, skills, memory, sessions, gateway routing, and local computer access.

## Useful Patterns

- Slash commands: `/model`, `/skills`, `/usage`, `/doctor`, and platform status should be fast runtime commands, not normal chat guesses.
- Doctor first: provider, auth, gateway, tools, permissions, memory, and sessions should be diagnosable from one command.
- Skill growth: successful workflows should be promoted into reusable skill files instead of living only in chat history.
- Session search: prior conversation should be searchable and visible to the agent so it does not start fresh every run.
- Gateways: chat, cron, background jobs, and future messaging adapters should route through a common gateway event/run ledger.
- Subagents: research, builder, and ops agents should be routable from the main agent.
- Terminal backends: execution must be real, audited, and permissioned.

## OmniClaw Mapping

Already present:

- `provider_status` for brain/provider readiness.
- `list_provider_models` for model discovery when a BYOK-compatible endpoint is configured.
- `capability_demo` for real tool and skill inventory.
- `sessions_list`, `sessions_history`, and `session_status` for chat/session state.
- `memory_search` and `list_long_term_memory` for memory state.
- `gateway`, `cron`, and `nodes` for runtime backbone status.
- `computer_access_status`, browser helpers, and terminal execution for local hands and eyes.

Added in this pass:

- `/doctor` maps to provider, computer access, session, gateway, and V2 health checks.
- `/model` maps to provider status plus model discovery.
- `/skills` maps to tools, skills, and configured agents.
- `/usage` maps to runtime profile, session id, run id, and memory counts.
- `/platforms` maps to computer roots, terminal, browser, nodes, cron, and gateway.
- `/hermes` maps Hermes reference ideas to OmniClaw's live runtime.

## Remaining Gaps

- Self-improving skill creation is still manual and should become a reviewable promotion flow.
- Session history exists, but full-text indexing/search needs to be stronger.
- Real WhatsApp, Slack, Signal, and iMessage adapters are still future work.
- Hard sandbox isolation is partial and needs a stricter local execution boundary.
- Provider-native repeated tool calling should keep improving so model -> tool -> result -> model can run multi-round tasks reliably.
