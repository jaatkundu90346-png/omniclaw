# OmniClaw V2 Plan

Date: 2026-05-05

## V2 Goal

OmniClaw V2 must stop being a collection of weak feature surfaces and become a measurable agent runtime. Every feature needs:

- status: `ready`, `partial`, or `missing`
- evidence: what proves it works
- gaps: what is still weak
- next action: the exact repair step
- no fake claims when a backend/plugin/provider is absent

## V2 Foundation Added

This pass adds the V2 control layer:

- `V2FeatureHealth` runtime report
- `/api/v2` endpoint
- `v2_status` tool
- `v2_repair_plan` tool
- `v2-audit` intent detection for weak/improve/upgrade messages
- runtime replies that summarize V2 score, weak features, and repair actions

## V2.1 Added

- Provider-guided repeated tool loop with JSON tool requests.
- Runtime executes allowed extra tool calls and appends observations before the final answer.
- Safety limits: max rounds, max calls per round, no unknown tools, no direct message/session-send recursion.
- Conservative default: skips simple replies and skips when heuristic tools already handled the request.

## V2.2 Added

- Dependency-free Chrome/Edge DevTools automation runtime.
- Browser tools now support status, navigate, screenshot, page text, links, click, and type/fill.
- Screenshots are saved as artifacts under `data/generated/browser-screenshots`.
- V2 health now scores browser automation from real tool/capability evidence.

## V2.3 Added

- Governed sandbox runner that copies selected workspace paths into a temporary workspace.
- `sandbox_run` executes commands inside the copy and reports added/modified/deleted files without touching the real workspace.
- `sandbox_apply` copies selected added/modified files back into the real workspace only after an explicit apply call.
- Known destructive system commands stay blocked even inside the sandbox.

## Current V2 Milestones

1. V2.1 Provider-native repeated tool calling
   Initial provider-guided JSON loop is implemented. Future work: provider-native function schemas for OpenAI-compatible APIs.

2. V2.2 Browser automation
   Initial Chromium/Edge click/type/screenshot/page-observation tools are implemented. Future work: form-aware workflows, persistent visible sessions, and richer DOM observations.

3. V2.3 Channel plugin packs
   Telegram, Discord, WhatsApp, Slack, Signal, iMessage, webhook, and file-drop should become first-class plugins with inbox/outbox/auth/attachments.

4. V2.4 Media providers
   Wire image/video/music/TTS tools to real provider plugins and return artifact paths/URLs.

5. V2.5 Hard sandbox
   Initial temp-workspace sandbox runner is implemented. Future work: optional VM/container backend and stronger per-risk approval UX.

6. V2.6 Semantic memory
   Index transcripts and memory for queryable long-term recall.

## V2 Rule

OmniClaw should never say "I can do X" unless the V2 report marks X as ready or partial with clear limitations. If a user asks for a missing feature, the agent must answer with the missing backend/plugin and the next repair step.
