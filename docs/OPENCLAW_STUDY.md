# OpenClaw Study

Studied from official sources on April 22, 2026.

Primary sources:

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/
- https://docs.openclaw.ai/concepts/architecture
- https://docs.openclaw.ai/concepts/agent
- https://docs.openclaw.ai/concepts/agent-loop
- https://docs.openclaw.ai/gateway/protocol
- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/tools/skills
- https://docs.openclaw.ai/plugins/architecture
- https://docs.openclaw.ai/web/control-ui
- https://docs.openclaw.ai/concepts/multi-agent
- https://docs.openclaw.ai/channels/index

## 1. What OpenClaw actually is

OpenClaw is not just a chatbot UI.

It is a self-hosted gateway-centric personal AI assistant platform. A single long-running Gateway process acts as the control plane for:

- chat channels
- sessions
- tools
- agents
- nodes
- memory
- approvals
- web UI
- cron and automation

The official docs describe it as a self-hosted gateway that connects chat apps and channel surfaces to an always-available AI assistant.

## 2. Core architecture idea

The most important OpenClaw design decision is this:

`Gateway = single source of truth`

The Gateway owns:

- channel connections
- session routing
- WebSocket protocol
- control UI serving
- event stream
- approvals
- automation
- node pairing

The docs explicitly say:

- one long-lived Gateway owns messaging surfaces
- clients connect over WebSocket
- nodes also connect over WebSocket but with a different role
- one Gateway per host

This means OpenClaw is designed like a control plane, not a thin frontend over an LLM.

## 3. Runtime model

OpenClaw runs one embedded agent runtime on top of another lower-level agent core.

Official docs say:

- OpenClaw runs a single embedded agent runtime
- the embedded runtime is built on Pi agent core
- OpenClaw owns session management, discovery, tool wiring, and channel delivery on top

So the stack is roughly:

1. Gateway layer
2. OpenClaw session/routing/tool/channel layer
3. Pi agent core
4. model providers and tools

For OmniClaw, this means we should think in layers too, not write one giant monolith.

## 4. Agent workspace model

OpenClaw is strongly workspace-driven.

The workspace is the agent’s main `cwd` and prompt context root. The docs call out these bootstrap files:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `BOOTSTRAP.md`
- `IDENTITY.md`
- `USER.md`

On the first turn of a session, OpenClaw injects these files into context. This is a big product insight:

- OpenClaw externalizes important behavior into editable files
- personality, instructions, and memory are not hidden only in code
- user customizes the assistant by editing workspace files

This is a major reason OpenClaw feels “alive” and customizable.

## 5. How an OpenClaw run works

The official Agent Loop doc describes the full turn as:

- intake
- context assembly
- model inference
- tool execution
- streaming replies
- persistence

The high-level flow is:

1. Gateway RPC receives `agent`
2. session is resolved and metadata saved
3. model and skill snapshot are resolved
4. OpenClaw calls the embedded Pi agent
5. tool and assistant deltas are streamed back
6. lifecycle events are emitted
7. results and usage are persisted

Important implementation details:

- runs are serialized per session
- there is also global queueing
- timeouts are enforced
- lifecycle events are explicit

This tells us OmniClaw needs a real run lifecycle, not just request/response handlers.

## 6. Session architecture

OpenClaw is very session-heavy.

Sessions are:

- isolated
- persistent
- routable
- visible in tools and UI

Official session storage path:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

OpenClaw also exposes session tools for the agent itself:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`
- `sessions_yield`
- `subagents`
- `session_status`

This is a major differentiator. OpenClaw is not only multi-user or multi-channel. It is also session-native and subagent-native.

## 7. Multi-agent model

OpenClaw supports multiple isolated agents inside one Gateway.

Each agent has its own:

- workspace
- state directory
- auth profiles
- session store
- persona
- bindings

Official docs emphasize that an agent is a fully scoped brain, not just a label.

That means multi-agent in OpenClaw is not “prompt variants”; it is real isolation.

For OmniClaw, this is a key future milestone:

- multiple agents
- per-agent workspace
- per-agent skills
- per-agent credentials

## 8. Channels and messaging

OpenClaw’s product strength is that it lives inside chat surfaces people already use.

Official docs list many supported channels, including:

- Telegram
- WhatsApp
- Slack
- Discord
- Google Chat
- Signal
- BlueBubbles / iMessage-related paths
- Matrix
- LINE
- Teams
- IRC
- WebChat
- many others through bundled or external plugins

Important design lesson:

- channels can run simultaneously
- Gateway routes per chat
- one control plane serves many surfaces

So OpenClaw is “assistant everywhere from one backend.”

## 9. Gateway protocol

OpenClaw has a real typed protocol, not ad hoc endpoints.

Official protocol summary:

- transport is WebSocket
- first frame must be `connect`
- request shape: `{type:"req", id, method, params}`
- response shape: `{type:"res", id, ok, payload|error}`
- events: `{type:"event", event, payload, seq?, stateVersion?}`

It also includes:

- roles such as `operator` and `node`
- scopes such as `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`
- idempotency keys for side-effecting methods
- device pairing
- auth modes
- exec approval families

This is one reason OpenClaw feels like infrastructure, not a toy project.

## 10. Nodes

OpenClaw distinguishes between operator clients and capability-hosting nodes.

Nodes can expose capabilities such as:

- canvas
- camera
- screen recording
- location
- system commands

Docs mention macOS, iOS, Android, and headless nodes connecting to the same Gateway.

This means OpenClaw can grow beyond a single machine without changing the core control plane model.

## 11. Control UI

OpenClaw has a real browser control surface.

Official docs describe the Control UI as:

- a small Vite + Lit SPA
- served by the Gateway itself
- connected directly to the Gateway WebSocket on the same port

It can do much more than chat:

- chat and history
- live tool output cards
- channel status and QR login
- session controls and overrides
- dreaming status
- cron jobs
- skills install/manage
- node listing
- exec approvals
- config viewing and editing
- logs tail
- updates

This is a very important product lesson for OmniClaw:

- the UI is not just a conversation box
- it is an operator console

## 12. Skills system

OpenClaw has a mature skills model.

Official docs say:

- skills use AgentSkills-compatible skill folders
- each skill is a directory with `SKILL.md`
- there are bundled skills plus local overrides
- skill loading is filtered by environment, config, and binary presence
- a session snapshots eligible skills for performance
- skills can auto-refresh with a watcher

Skill precedence is also clearly defined across:

- extra dirs
- bundled skills
- managed/local skills
- personal skills
- project skills
- workspace skills

OpenClaw can also install skills from ClawHub.

This is more advanced than “prompt snippets.” Skills are a real product subsystem.

## 13. Plugin system

The plugin architecture is one of the biggest reasons OpenClaw scales.

Official docs say plugins register capabilities such as:

- model providers
- speech providers
- realtime transcription
- realtime voice
- media understanding
- image generation
- music generation
- video generation
- web fetch
- web search
- channel / messaging

The docs describe a four-layer plugin system:

1. manifest and discovery
2. enablement and validation
3. runtime loading
4. surface consumption

That means OpenClaw is intentionally built to expose plugin-owned:

- tools
- commands
- services
- routes
- channels
- providers

This is exactly the kind of modularity OmniClaw will need.

## 14. Memory model

OpenClaw memory is not hidden black-box state.

Official memory docs say the model only remembers what gets saved to disk. Default memory files include:

- `MEMORY.md`
- `memory/YYYY-MM-DD.md`
- optional `DREAMS.md`

It also provides memory tools such as:

- `memory_search`
- `memory_get`

And supports richer memory backends/plugins:

- builtin SQLite-based memory backend
- QMD
- Honcho
- memory-wiki companion plugin

Important lesson:

- memory is file-native and inspectable
- memory retrieval is tool-based
- memory architecture is pluggable

This is a very strong design pattern we should carry into OmniClaw.

## 15. Security model

OpenClaw security is serious because it runs tools and connects to real accounts.

Official guidance says:

- inbound DMs are untrusted input
- DM pairing and allowlists exist for safety
- one trusted operator boundary per gateway is the expected model
- it is not meant as a hostile multi-tenant security boundary

The platform also has:

- device pairing
- operator scopes
- node scopes
- exec approvals
- sandboxing options
- pairing approvals for browsers and nodes

This means OpenClaw assumes power, but tries to wrap it in operational controls.

## 16. Build and source stack

From the official repo/docs:

- runtime: Node 24 recommended
- source workflow prefers `pnpm`
- dev loop uses `pnpm gateway:watch`
- UI build uses `pnpm ui:build`
- from-source setup uses `pnpm openclaw setup`
- plugin runtime loading uses `jiti`
- protocol typing uses TypeBox, JSON Schema, and Swift codegen
- Control UI uses Vite + Lit

So OpenClaw is not a tiny script project. It is a real TypeScript platform with typed protocol and multiple product surfaces.

## 17. Why OpenClaw feels “complete”

OpenClaw feels complete because it combines all of these at once:

- gateway
- channels
- sessions
- agent runtime
- tools
- skills
- plugins
- memory
- operator UI
- mobile and node surfaces
- approvals
- cron
- multi-agent routing

Most open-source assistants have only 2 or 3 of these. OpenClaw combines nearly the full stack.

## 18. What OmniClaw must copy to be credible

If OmniClaw wants to be genuinely “OpenClaw-like,” it must eventually have these pillars:

1. Gateway as the central control plane
2. Persistent session store
3. Workspace-driven identity and memory files
4. Real tool runtime with approvals and policy
5. Skills with precedence, install flow, and watcher
6. Plugin system for channels/providers/tools
7. Operator UI, not just chat UI
8. Multi-agent routing and isolated workspaces
9. Channel integration strategy
10. Secure pairing/auth/scopes model

## 19. What we already have in OmniClaw

Current OmniClaw already has early versions of:

- local server
- chat UI
- memory
- tasks
- tools
- file controls
- research
- skill creation
- runtime customization
- gateway-style API routes

That means the direction is correct.

## 20. What is still missing compared with OpenClaw

Major gaps still include:

- real WebSocket gateway protocol
- true session store and streaming lifecycle
- multi-agent routing with separate agent dirs
- channel connectors
- real approval queues
- node system
- cron/background worker
- plugin architecture
- rich operator UI
- install/update workflows
- full security and pairing model

## 21. Design conclusion

The correct way to build OmniClaw is not:

- clone UI only
- clone chat only
- clone one tool loop only

The correct way is:

- build the Gateway first as the stable control plane
- build sessions and agent loop second
- build skills/plugins third
- build channels/nodes/automation after the core is stable

That is the architecture pattern OpenClaw itself follows.

## 22. Practical build order for OmniClaw after this study

Recommended next implementation order:

1. WebSocket gateway protocol
2. persistent session store and run lifecycle
3. operator approvals queue
4. agent workspace bootstrap files
5. skill watcher and install flow
6. background worker and cron
7. multi-agent routing
8. first real channel connector
9. plugin interface for providers/channels/tools
10. richer control UI

## 23. Bottom line

Yes, OpenClaw is much bigger than a normal assistant app.

But after studying the official docs, its structure is understandable:

- Gateway-centric
- workspace-driven
- session-native
- plugin-capable
- multi-surface
- strongly operational

That means OmniClaw is buildable if we respect the same architectural boundaries instead of trying to fake parity with a single-page chat demo.
