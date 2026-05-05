# OmniClaw

OmniClaw is a local-first, lightweight, OpenClaw-inspired assistant platform aimed at becoming a serious personal AI control plane for Windows and self-hosted environments.

## Current foundation

- Tiny dependency-free Node.js server
- Local dashboard UI
- Persistent conversation memory and notes
- Task storage
- Workspace file inspection tools
- Protected workspace file writing
- Approval-oriented shell planning
- Lightweight web research
- Automation-ready task runner
- Research memory and artifact tracking
- Gateway APIs and self-customization controls
- Persistent sessions, run lifecycle, gateway events, and approvals
- WebSocket gateway protocol (req/res/events)
- Plugin manifests and background job worker
- BYOK provider profiles and local secret storage
- Skill registry
- Permissions-aware tool registry
- Intent detection and planning
- Config-driven runtime profiles
- Provider abstraction with mock mode and OpenAI-compatible mode

## Product direction

The goal is not a toy chatbot. OmniClaw should grow into a user-needs-first assistant platform with:

- fast local startup
- low idle overhead
- modular tools
- configurable providers
- inspectable memory and plans
- safe defaults for local execution

## Execution model

OmniClaw now separates local capability into three classes:

- direct safe tools: notes, tasks, time, runtime summary
- gated workspace tools: list files, read files, and protected writes inside allowed workspace roots only
- approval-oriented actions: shell requests are converted into explicit plans instead of silently executed
- research and task workflows: lightweight public web lookup and local task execution summaries

This keeps the assistant useful while making future higher-trust automation easier to add safely.

## Product memory

OmniClaw now keeps track of:

- notes
- conversations
- saved research results
- generated file artifacts

This makes the local dashboard more useful over time and sets up future features like citations, artifact history, and reusable workflows.

## Gateway and self-customization

OmniClaw now exposes gateway-style routes for runtime control and skill management. It can also create local skills and update runtime settings through controlled tools and UI forms.

## Gateway backbone

OmniClaw now has the first serious control-plane backbone:

- persistent sessions
- persistent runs
- gateway event log
- approval queue
- workspace bootstrap files

This is the bridge from a local assistant demo toward an OpenClaw-style operator platform.

## WebSocket gateway

OmniClaw also exposes an OpenClaw-inspired WebSocket gateway protocol:

- `ws://localhost:3147/ws`

Protocol details and supported methods:

- `docs/WS_GATEWAY_PROTOCOL.md`

## Plugins and jobs

OmniClaw can now discover plugin manifests and run tool jobs in a persisted background queue.

- `docs/PLUGIN_AND_WORKER.md`

## BYOK providers

OmniClaw can store provider profiles in config and API keys in local secrets.

- `docs/BYOK_PROVIDER_SETUP.md`
- Built-in presets: OpenAI, Anthropic, Gemini, Groq, OpenRouter, Local-compatible

## Lightweight target

OmniClaw is being designed for a realistic lightweight target in the roughly `500 MB to 1 GB` class once real models, tools, and UI are enabled. The architecture avoids unnecessary dependencies so we can stay much leaner than heavy agent stacks.

## Run

```powershell
npm install
npm run dev
```

Open `http://localhost:3147`

## Easy Windows launch

Double-click:

```text
start-omniclaw.bat
```

Or run:

```powershell
npm run launch
```

Create a desktop shortcut:

```powershell
npm run install:shortcut
```

Installer roadmap:

- `docs/WINDOWS_INSTALLER_PLAN.md`
- `docs/TAURI_DESKTOP_APP.md`
- `docs/SIDECAR_PACKAGING.md`

Check native desktop packaging readiness:

```powershell
npm run desktop:check
```

Build the Tauri desktop app after Rust and Tauri CLI are installed:

```powershell
npm install
npm run desktop:build
```

Build just the gateway sidecar:

```powershell
npm run sidecar:build
```

## Build check

```powershell
npm run build
```

## Quick smoke test

Run non-interactive health smoke test:

```powershell
npm test
```

Run auth + provider contract smoke test:

```powershell
npm run test:auth-provider
```

Run WebSocket smoke flow (requires active dev server and pairing):

```powershell
npm run test:ws
```

## Configure a real model

Copy the defaults from [config/default.json](C:/Users/PATEL%20COMPUTERS/Documents/Codex/2026-04-22-hlo/config/default.json) into `data/config.json` and change:

- `provider.mode` to `openai-compatible`
- `provider.baseUrl` to your API base
- `provider.model` to your model name
- `provider.apiKeyEnv` to the environment variable holding your API key

Example environment variable:

```powershell
Copy-Item .env.example .env
$env:OPENAI_API_KEY="your-key"
npm run dev
```

## Project layout

- `server.js` HTTP server and API routes
- `config` default runtime configuration
- `src/core` agent, providers, memory, tasks, tools, skills, and planning
- `public` frontend
- `skills` starter skills
- `data` persisted runtime data and user overrides
- `docs` research, vision, and roadmap
