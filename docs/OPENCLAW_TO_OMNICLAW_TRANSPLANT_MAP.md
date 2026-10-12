# OpenClaw To OmniClaw Transplant Map

Date: 2026-05-06

## Goal

Use OpenClaw as a working reference to harden OmniClaw V2 without turning OmniClaw into a broken duplicate checkout. OmniClaw remains the Windows-first, Codex-account-bridge, local app project. OpenClaw becomes the donor for runtime patterns, prompts, skills, channels, tools, and UI contracts.

## Upstream Snapshot

- Version observed: `2026.5.5`
- License: MIT
- Runtime: Node 24 recommended, `pnpm` workspace
- Key source areas:
  - `vendor/openclaw/src/gateway`
  - `vendor/openclaw/src/sessions`
  - `vendor/openclaw/src/agents`
  - `vendor/openclaw/src/tools`
  - `vendor/openclaw/src/memory`
  - `vendor/openclaw/src/context-engine`
  - `vendor/openclaw/extensions`
  - `vendor/openclaw/ui`
  - `vendor/openclaw/docs/reference/templates`

## Layer Mapping

### Layer 1: Channels

OpenClaw has many channel/provider extensions under `extensions/*`, including Discord, Slack, WhatsApp-style integrations, iMessage/BlueBubbles, Matrix, Teams, Telegram-related runtime pieces, web, browser, TTS, media, and search providers.

OmniClaw target:

- Keep `ConnectorStore` as the local state owner.
- Add OpenClaw-style adapter manifests for each channel.
- Start with low-risk adapters: Discord, Telegram, Slack, webhook/file-drop.
- Keep channel auth isolated in `data/secrets.json` and connector config, never in prompts.

### Layer 2: Gateway

OpenClaw gateway code has mature auth, pairing, sessions, routes, WebSocket/HTTP APIs, control UI contracts, cron, nodes, and tool invocation APIs.

OmniClaw target:

- Compare `src/gateway/*` against OmniClaw `server.js`, `GatewayStore`, `DeviceTrustStore`, and `ConnectorStore`.
- Transplant concepts first: control-plane events, tool invoke contract, pairing flow, route naming, and health endpoints.
- Avoid wholesale server replacement.

### Layer 3: Agent Runtime

OpenClaw has strong agent prompt/session/context architecture in `src/agents`, `src/sessions`, `src/context-engine`, and docs under `docs/concepts`.

OmniClaw target:

- Make OmniClaw prompt assembly match the OpenClaw mental model:
  - agent identity
  - `AGENTS.md`
  - `SOUL.md`
  - `TOOLS.md`
  - user profile
  - session transcript
  - memory
  - tool policy
- Add deterministic prompt trace output for debugging.
- Add session reset/compact/search/export parity where OpenClaw is stronger.

### Layer 4: Tools And Skills

OpenClaw has first-class docs and source for browser, exec, sessions, subagents, skills, web fetch/search, image/music/video/TTS, diffs, and plugin tools.

OmniClaw target:

- Keep current tool registry but add an OpenClaw-compatible descriptor layer.
- Convert OpenClaw tool docs into OmniClaw tool help and capability demos.
- Add skill installer/importer that can read `vendor/openclaw/skills/*/SKILL.md` into OmniClaw workspace skills.
- Prioritize tools OmniClaw users already asked for: browser, exec, read/write/edit, image, TTS, sessions, subagents.

### Layer 5: Workspace And State

OpenClaw documents the workspace files and templates under `docs/reference/templates`.

OmniClaw target:

- Align `workspace/AGENTS.md`, `workspace/SOUL.md`, `workspace/TOOLS.md`, `workspace/USER.md`, and per-agent `PROFILE.md`.
- Add a migration command that can regenerate missing workspace prompt files.
- Keep OmniClaw runtime data in `data/` and avoid importing OpenClaw local state.

## Immediate Build Queue

1. **Prompt Parity Pass**
   Build a prompt trace panel/tool showing exactly which workspace files and memory items become the agent prompt.

2. **Skill Importer**
   Add `openclaw_skill_scan` and `openclaw_skill_import` tools that read `vendor/openclaw/skills/*/SKILL.md` and copy selected skills into OmniClaw workspace format.

3. **Tool Descriptor Compatibility**
   Add OpenClaw-style metadata fields to OmniClaw tool definitions: group, risk, examples, required permission, and output shape.

4. **Gateway Contract Diff**
   Create a machine-readable comparison between OpenClaw gateway routes and OmniClaw API endpoints.

5. **Channel Adapter Packs**
   Use OpenClaw extension structure as the contract for Telegram, Discord, Slack, and WhatsApp-family adapters.

## Non-Goals

- Do not replace OmniClaw with OpenClaw.
- Do not merge OpenClaw package management into OmniClaw.
- Do not run two gateways on top of the same state directory.
- Do not claim OpenClaw feature parity until OmniClaw V2 health has real evidence.

