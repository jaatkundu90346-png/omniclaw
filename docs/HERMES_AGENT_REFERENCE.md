# Hermes Agent Reference for OmniClaw

Hermes Agent reference source: https://github.com/nousresearch/hermes-agent

License: MIT.

This document tracks the parts of Hermes Agent that are useful for OmniClaw V2. Hermes Agent is now vendored locally at `vendor/hermes-agent` with the upstream MIT license preserved at `vendor/hermes-agent/LICENSE`. It should be treated as a reference architecture, not a direct replacement for OmniClaw. OmniClaw's goal is still the same: provide agents with real hands and eyes through tools, skills, memory, sessions, gateway routing, and local computer access.

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
- `hermes_vendor_status` reports the local vendor copy, license, major folders, and skill count.
- `hermes_skill_scan` scans vendored Hermes `SKILL.md` files for selective import planning.
- `hermes_tool_catalog` reports Hermes core tool names and their OmniClaw compatibility status.
- Hermes-compatible aliases now expose many Hermes names directly: `terminal`, `web_extract`, `patch`, `search_files`, `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `skills_list`, `skill_view`, `todo`, `memory`, `session_search`, `execute_code`, `cronjob`, `send_message`, `vision_analyze`, `video_analyze`, and more.

## Tool Import Decision

Do not delete OmniClaw's existing tool registry and replace it with Hermes Python tools. OmniClaw runs as a Node/Windows desktop app, while Hermes tools are Python modules with their own runtime, dependency, auth, and sandbox assumptions. The safe V2 path is:

1. Keep OmniClaw's working Node tools.
2. Expose Hermes tool names as aliases where OmniClaw already has an equivalent backend.
3. Mark Python-only or service-specific tools as partial/placeholders until an adapter is built.
4. Import skills selectively after compatibility review.
5. Port one backend at a time, with tests, instead of a full destructive replacement.

## Vendored Source Layout

- `vendor/hermes-agent/agent`: model adapters, context, memory, prompt, tool, and runtime helpers.
- `vendor/hermes-agent/gateway`: gateway process, platform registry, slash access, status, sessions, stream consumers.
- `vendor/hermes-agent/gateway/platforms`: Telegram, Discord, Slack, WhatsApp, Signal, Matrix, email, webhooks, and more.
- `vendor/hermes-agent/hermes_cli`: CLI, auth, doctor, model commands, config, dashboard, onboarding, and TUI helpers.
- `vendor/hermes-agent/skills`: bundled skills in `SKILL.md` format.
- `vendor/hermes-agent/cron`: scheduler and jobs.
- `vendor/hermes-agent/environments`: agent loop and benchmark environments.

## Copy Rules

- Keep `vendor/hermes-agent/LICENSE` and `THIRD_PARTY_NOTICES.md` with any distribution that includes Hermes-derived code.
- Import selected modules/patterns deliberately; do not wire Hermes Python runtime directly into OmniClaw's Node runtime without a wrapper.
- Prefer copying ideas and compatible skill files first, then build adapters for gateway/platform/model features.
- If a Hermes file is transplanted into OmniClaw source, preserve attribution in the receiving file or nearby docs.

## Remaining Gaps

- Self-improving skill creation is still manual and should become a reviewable promotion flow.
- Session history exists, but full-text indexing/search needs to be stronger.
- Real WhatsApp, Slack, Signal, and iMessage adapters are still future work.
- Hard sandbox isolation is partial and needs a stricter local execution boundary.
- Provider-native repeated tool calling should keep improving so model -> tool -> result -> model can run multi-round tasks reliably.
