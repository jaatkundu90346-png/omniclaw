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

## Current V2 Milestones

1. V2.1 Provider-native repeated tool calling
   Model should call tools in JSON, runtime executes them, observations return to model, and loop repeats until the task is complete.

2. V2.2 Browser automation
   Add Chromium click/type/screenshot/page-observation tools instead of only URL open/fetch.

3. V2.3 Channel plugin packs
   Telegram, Discord, WhatsApp, Slack, Signal, iMessage, webhook, and file-drop should become first-class plugins with inbox/outbox/auth/attachments.

4. V2.4 Media providers
   Wire image/video/music/TTS tools to real provider plugins and return artifact paths/URLs.

5. V2.5 Hard sandbox
   Add isolated runner for high-risk shell/file actions and stronger approval UX.

6. V2.6 Semantic memory
   Index transcripts and memory for queryable long-term recall.

## V2 Rule

OmniClaw should never say “I can do X” unless the V2 report marks X as ready or partial with clear limitations. If a user asks for a missing feature, the agent must answer with the missing backend/plugin and the next repair step.
