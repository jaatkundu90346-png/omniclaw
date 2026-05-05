# OpenClaw Research Notes

## Verified source

- Official GitHub org: [openclaw](https://github.com/openclaw)
- Main repo: [openclaw/openclaw](https://github.com/openclaw/openclaw)

## What OpenClaw is

Based on the current public README, OpenClaw is a self-hosted personal AI assistant platform that includes:

- Local-first gateway
- Multi-channel messaging integrations
- Workspace-driven agent runtime
- Skills system
- Tool execution
- Memory and session handling
- Planning and higher-reasoning controls
- Optional voice, canvas, mobile, and companion apps
- Sandbox and security controls

## Important implementation clues from the README

- Main stack is TypeScript
- Preferred runtime is Node 24 or Node 22.16+
- Source build uses `pnpm`
- Windows support is documented, but the README strongly recommends WSL2 for the full system
- Security posture matters because the platform executes tools and can access real messaging surfaces

## What we should clone first

To build a practical OpenClaw-like clone called OmniClaw, the first milestone should copy the conceptual layers, not every integration:

1. Chat surface
2. Agent loop
3. Memory
4. Skills
5. Tools
6. Planner
7. Model/provider abstraction
8. Local persistence
9. Config and permissions
10. Windows-local run flow

## What can wait

- WhatsApp/Telegram/Discord integrations
- Browser automation
- Voice agents
- Multi-device sync
- Distributed gateway architecture
- Full plugin marketplace
- Native mobile apps

## RAM reality check

A true OpenClaw-style system running on Windows with:

- Node runtime
- local web UI
- memory layer
- tools
- planner
- model integration

will not realistically run in only 10 MB RAM.

More realistic targets:

- Tiny control-plane only: tens of MB
- Node service plus UI: often 50 MB to 150 MB+
- Real local model inference: hundreds of MB to many GB

So OmniClaw should target:

- low idle overhead
- few dependencies
- pluggable providers
- ability to use remote APIs or a very small local model

instead of a strict 10 MB ceiling.
