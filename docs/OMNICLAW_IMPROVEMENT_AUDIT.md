# OmniClaw Improvement Audit

Date: 2026-05-05

## What OpenClaw Expects

OpenClaw's runtime model separates the model brain from the platform shell:

- Tools are typed functions the agent can invoke, such as `exec`, `browser`, `web_search`, `message`, sessions, memory, and media tools.
- Skills are injected instructions that teach when and how to use tools.
- Plugins package channels, providers, tools, skills, media, speech, and browser capabilities.
- Agent workspaces keep bootstrap files like `AGENTS.md`, `SOUL.md`, `TOOLS.md`, and `IDENTITY.md`.
- Sessions and memory are durable platform features, not just chat text in one model prompt.

References:

- https://docs.openclaw.ai/tools
- https://docs.openclaw.ai/agent
- https://docs.openclaw.ai/concepts/session-tool
- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/tools/web
- https://docs.openclaw.ai/tools/bash

## Biggest Gaps Found

1. Provider auth failure leaked into normal chat.
   Simple greetings could fall through to the Codex CLI provider. If Codex auth was stale, the user saw provider failure instead of an agent reply.

2. Provider status was shallow.
   `codex --version` passing only proves the CLI is installed. It does not prove ChatGPT/Codex account auth can complete a live reply.

3. Capability answers were too generic.
   The agent could say it had tools, but did not reliably answer from the active tool and skill registry.

4. OpenClaw compatibility exists but is not complete.
   Core aliases are registered, but full browser click/screenshot automation, provider-native repeated function calling, channel plugins, media providers, and hard sandboxing are still incomplete.

5. Runtime self-audit was not easy enough for the agent to use.
   The layer report existed, but provider diagnostics and capability demos needed first-class tools.

## Upgrade Implemented In This Pass

- Added `provider_status` tool with optional live auth verification.
- Added `capability_demo` tool for real tool/skill demos.
- Changed provider/auth/reply-failure messages to call provider diagnostics.
- Changed greetings to use local agent identity without hitting the provider.
- Added provider failure fallback so OmniClaw can still answer from local runtime state.
- Added runtime replies for provider status, capability demo, and layer audit.

## Still Needed

1. Provider-native repeated tool-calling loop.
   The model should be able to request tools repeatedly until the task is done, not only rely on heuristic planning.

2. Full browser automation.
   Add Chromium navigation, click, type, screenshot, and page observation tools.

3. Channel plugins.
   WhatsApp, Slack, Signal, iMessage, Telegram, Discord, and file-drop should be packaged like OpenClaw-style plugins.

4. Real media providers.
   Wire `image_generate`, `video_generate`, `music_generate`, and `tts` to configured providers.

5. Strong sandbox.
   Add isolated workspaces and optional hard sandbox execution for high-risk commands.

6. Better semantic memory.
   Index session transcripts and memory files with semantic search or a local sidecar.
