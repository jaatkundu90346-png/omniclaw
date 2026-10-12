# OpenClaw Build Guide

Studied on April 23, 2026 from official OpenClaw docs, the public repository, local source snapshots, and the live Control UI.

This guide answers two different questions:

1. How OpenClaw is built from source.
2. How OpenClaw appears to have been built as a product, step by step.

## Short Answer

OpenClaw is not "just a chat UI."

It is a gateway-first monorepo with four major layers:

1. a Node-based core runtime
2. a long-running Gateway service and WebSocket control plane
3. a separate Control UI package built with Vite + Lit
4. a plugin/channel/node ecosystem layered on top

The key idea is:

`Gateway first, chat second`

Chat is only one surface sitting on top of sessions, routing, tools, approvals, nodes, config, logs, jobs, and channels.

## A. How OpenClaw Is Built From Source

## 1. Repository layout

Primary repo structure comes from the root workspace config and build files.

- root package: core runtime, CLI, gateway, build scripts
- `ui/`: Control UI package
- `packages/*`: shared/internal packages
- `extensions/*`: bundled extensions/plugins

The workspace file shows a `pnpm` monorepo that includes:

- `.`
- `ui`
- `packages/*`
- `extensions/*`

Why this matters:

- the backend and frontend are built separately
- plugins/extensions are part of the same release pipeline
- OpenClaw ships as a platform, not a single app bundle

## 2. Runtime prerequisites

OpenClaw currently expects modern Node.

- `openclaw.mjs` hard-checks for Node `22.12+`
- the GitHub quick start currently says Node `24` is recommended, or Node `22.16+`
- the root package declares `pnpm@10.33.0`

So the practical build baseline is:

1. install Node 24 if possible
2. enable Corepack
3. use `pnpm`

## 3. Bootstrap the monorepo

The launcher file tells us what a source checkout needs before it can run:

- if `dist/entry.js` or `dist/entry.mjs` is missing, the launcher says to run `pnpm install && pnpm build`

So the basic source bootstrap is:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
corepack enable
pnpm install
pnpm build
```

At this point the repo can produce the compiled `dist/` runtime that `openclaw.mjs` loads.

## 4. Build the core runtime

The root build is driven by `tsdown`.

`tsdown.config.ts` shows that OpenClaw compiles:

- `src/index.ts`
- `src/entry.ts`
- CLI/runtime support files
- plugin SDK subpaths
- bundled plugin entrypoints
- bundled hooks

This is an important architectural clue:

- OpenClaw did not grow from a static web app
- it has a real compiled runtime boundary
- plugins are part of the official build graph

In other words, the "brain" is compiled first, and the UI is only one consumer of that brain.

## 5. Build the Control UI

The UI is a separate package, not a pile of static HTML hand-dropped into the backend.

`ui/package.json` shows:

- `build`: `vite build`
- `dev`: `vite`
- `preview`: `vite preview`
- `test`: `vitest`

The UI package uses:

- `lit`
- `markdown-it`
- `marked`
- `dompurify`
- Playwright
- Vitest

That means the Control UI is a proper SPA built with web components, not Canva, not a visual export, and not just server templates.

The root package also has wrapper scripts:

- `ui:install`
- `ui:dev`
- `ui:build`

So OpenClaw's build flow is effectively:

1. install workspace dependencies
2. build core Node runtime
3. build the `ui/` package
4. serve the built UI through the Gateway

## 6. Run the Gateway

The Gateway is the real product entrypoint.

Official CLI docs show:

```bash
openclaw gateway
openclaw gateway run
```

Key facts from the docs:

- the Gateway is OpenClaw's WebSocket server
- it owns channels, nodes, sessions, and hooks
- default port is usually `18789`
- it can run in local/dev mode
- it enforces auth and bind safety rules

The quick-start shape is:

```bash
openclaw gateway --port 18789 --verbose
```

This is the first major product lesson for OmniClaw:

- OpenClaw was built as an always-on service first
- the browser UI connects to that service
- the service is the source of truth

## 7. Serve the Control UI from the Gateway

Official docs describe the Control UI as a web app served by the Gateway.

That means the final user-facing app works like this:

1. gateway starts
2. gateway exposes HTTP dashboard/control pages
3. gateway exposes a WebSocket endpoint
4. UI connects back to the same gateway for state and actions

So the UI is not the backend.
It is an operator console for the backend.

## 8. Authenticate the UI connection

The live Control UI and official docs both point to the same model:

- WebSocket URL
- gateway token or password
- browser/device identity
- sometimes one-time pairing approval

The mobile dashboard and Overview page show that connection bootstrap is a first-class product surface, not a hidden advanced setting.

That is why OpenClaw feels operationally serious:

- before chat, you connect to the control plane
- before model replies, you establish identity and session scope

## 9. Run chat over WebSocket RPC

OpenClaw chat is not a simple POST request/response form.

Official docs and UI behavior show this flow:

1. UI sends `chat.send`
2. Gateway immediately acknowledges the run
3. assistant deltas and tool events stream afterward
4. session settings can be changed with `sessions.patch`
5. chat history and abort/inject are separate RPC calls

This explains why the product can show:

- tool cards inline
- run status
- abort
- session model/thinking switches
- per-session overrides

The chat surface was built on top of a run/event protocol, not the other way around.

## 10. Add higher control-plane features

Source snapshots and the live UI show that the UI is organized around control surfaces:

- Chat
- Overview
- Channels
- Instances
- Sessions
- Usage
- Cron Jobs
- Agents
- Skills
- Nodes
- Dreaming
- Config
- Communications
- Appearance
- Mobile
- Voice
- AI Agents
- Debug
- Logs

This is the second big architectural lesson:

- OpenClaw is a control plane with chat inside it
- not a chatbot with a few settings around it

## 11. Bundle plugins and extensions

`tsdown.config.ts` and the workspace layout show plugin-aware builds:

- bundled plugin build entries are collected
- plugin SDK subpaths are emitted into `dist/`
- some plugin runtime dependencies are staged separately
- `extensions/*` participate in the official packaging flow

So OpenClaw was built expecting:

- built-in skills/extensions
- optional channel integrations
- separate runtime dependencies per extension

That is a strong clue that extensibility was a first-order concern early in the build, not an afterthought.

## 12. Package for production

The Dockerfile shows a multi-stage build:

- pinned Node 24 base images
- install/build in one stage
- minimal runtime image in final stage
- health endpoint at `/healthz`
- final startup command runs the gateway

The final command in Docker starts OpenClaw like a service, not like a one-shot script.

That matches everything else:

- long-running gateway
- UI served from gateway
- stateful sessions
- ongoing channels/nodes/jobs

## 13. Test and operate it

The root scripts show checks for:

- `check`
- `test`
- `test:ui`

The CLI docs also show operational commands like:

- `gateway health`
- `gateway status`
- `gateway probe`

That means production readiness is built into the product shape:

- health inspection
- service lifecycle
- remote probing
- UI tests
- runtime checks

## B. Reconstructed Product Build Order

Based on repo structure, docs, and live UI, OpenClaw was most likely built in roughly this order.

## 1. Define the control-plane architecture

Before fancy UI, the team likely locked down these ideas:

- one gateway per machine
- sessions as durable keys
- tools and channels attached to gateway state
- WebSocket RPC as the main interface
- auth and pairing as mandatory, not optional

Without this layer, the rest of the product would collapse into a toy chatbot.

## 2. Build the CLI and gateway runtime

Next came the service layer:

- CLI entry
- config loading
- gateway startup
- WebSocket server
- health/status commands
- session persistence

This gave them an always-on operational backbone.

## 3. Build the session and run protocol

The next important layer was likely:

- `chat.send`
- streaming events
- run ids
- abort/inject/history
- session patching
- tool event plumbing

This is the layer that makes the UI feel alive and structured.

## 4. Build the Control UI shell

Once the gateway protocol existed, the team could build:

- sidebar navigation
- overview page
- connect/auth bootstrap
- session selectors
- status cards

This matches what we see in the live product: the shell is operational before it is decorative.

## 5. Build chat as a structured run viewer

OpenClaw chat was likely added after the event model was stable.

That explains why chat supports:

- streaming output
- tool cards
- model/session switches
- context/status indicators
- attachments and richer interaction surfaces

The UI behaves like a client for a runtime, not like a prompt box with extra CSS.

## 6. Add skills, agents, nodes, and jobs

After the core control plane and chat were stable, the product could expand into:

- skills store / ClawHub
- agent/workspace management
- nodes and remote execution
- cron jobs
- dreaming/memory consolidation

These all depend on the gateway already existing as a durable orchestrator.

## 7. Add config, logs, debug, and approval safety

The mature-product layer is:

- config forms and raw editing
- base-hash concurrency guard
- secret handling
- logs and debug snapshots
- exec approvals and allowlists

This is the layer that turns a cool demo into an actual operator product.

## 8. Harden packaging and deployment

Finally:

- Docker
- release packaging
- plugin bundling
- health endpoints
- service management

At that point OpenClaw becomes something users can keep running all day, not just launch for a demo.

## C. What OmniClaw Should Copy First

If we want OmniClaw to be "OpenClaw bones, lighter body", we should copy the architecture in this order:

1. gateway-first runtime
2. WebSocket auth and session handshake
3. event-based chat runs with tool cards
4. overview, sessions, jobs, logs, config panels
5. plugin/skill registry
6. job scheduling
7. multi-agent and node routing
8. approval safety and remote execution

If we copy only the visible chat UI, we will get a clone of the skin, not the system.

## D. Lightweight OmniClaw Strategy

To stay lighter than OpenClaw, we should intentionally simplify these areas first:

- fewer built-in channel integrations
- fewer bundled plugins by default
- SQLite or JSON-backed local state first
- one lightweight gateway process
- simple plugin manifest before full marketplace complexity
- minimal node protocol before broad remote capability support

What we should not simplify too much:

- workspace bootstrap and injected file model
- gateway/session backbone
- session store + transcript persistence
- pairing and device identity
- command queue and one-run-per-session guarantees
- context assembly / compaction behavior
- streaming event model
- tool card rendering
- plugin loader contract
- config and auth model
- operator-first shell

Those are the parts that make OpenClaw feel like OpenClaw.

## E. OmniClaw Build Stages

This is the practical build order for our clone.

## Stage 0. Workspace and bootstrap ritual

Build:

- agent workspace on disk
- seeded bootstrap files
- one-time bootstrap Q&A
- injected project-context file model
- safe file-size truncation rules

Why this belongs first:

OpenClaw's identity and memory model starts in workspace files, not only in UI state.

## Stage 1. Gateway bootstrap and service lifecycle

Build:

- local gateway process
- WebSocket endpoint
- token/password auth
- health endpoint
- startup status/probe
- Windows startup/service management
- basic Overview page

## Stage 2. Pairing, device identity, and trust gates

Build:

- connect handshake
- operator device identity
- node pairing flow
- device token issuance and reconnect path
- local auto-approve vs remote explicit approval rules
- origin/auth safety checks

## Stage 3. Session persistence and queueing

Build:

- `sessionKey` routing rules
- `sessions.json`-style metadata store
- append-only transcript files
- per-session one-run-at-a-time guarantees
- reset/expiry/maintenance rules

## Stage 4. Context engine and streaming chat runtime

Build:

- context assembly pipeline
- injected workspace files
- skill metadata vs on-demand skill loading
- compaction + pruning
- `chat.send`
- run ids
- assistant token streaming
- tool event streaming
- abort
- history reload
- session patch / per-session overrides

## Stage 5. Control shell and web surfaces

Build:

- left navigation
- overview
- gateway access panel
- sessions
- usage/jobs
- settings/config
- logs/debug
- webchat surface
- dashboard-first mobile connect screen

## Stage 6. Skills, plugins, channels, and config ownership

Build:

- manifest-first plugin loader
- plugin-owned config
- setup/runtime split for plugins
- skill catalog
- enable/disable
- provider secret references
- install/remove lifecycle
- gateway/plugin HTTP routes
- channel plugin registration
- multi-channel account state

## Stage 7. Scheduler, multi-agent routing, and session orchestration

Build:

- cron jobs
- scheduled agent runs
- multi-agent routing
- worker/agent registry
- session tools
- sub-agent spawning and waiting
- per-agent tool/sandbox policy
- channel/account/group bindings

## Stage 8. Nodes, approvals, and remote capability surfaces

Build:

- paired devices
- execution targets
- allowlists
- approval queues
- node capabilities and commands
- canvas/A2UI-style hosted surfaces
- browser/media/device routing hooks

## Stage 9. Dreaming and memory systems

Build:

- `MEMORY.md`
- daily memory files
- diary/scene memory views
- summarize/promote flows
- light background consolidation
- dreaming phases: light, REM, deep
- cron-managed memory sweeps

## F. Missing Pieces We Must Not Skip

These are the OpenClaw bones that were easy to underweight at first, but matter a lot for a real clone:

1. Workspace-first identity model

- `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
- bootstrapping runs on the gateway host, not on whichever UI happens to connect

2. Two-layer session persistence

- mutable session store for metadata
- append-only transcript files for real history and tool events

3. Queue and run serialization

- one serialized run per session
- safe concurrency across different lanes like main, cron, and subagent

4. Pairing as a real approval system

- DM pairing
- node/device pairing
- device tokens after approval

5. Manifest-first plugin architecture

- discovery should not require executing plugin code
- setup/runtime/channel/provider capabilities are distinct concerns

6. Context engine as a replaceable subsystem

- memory retrieval and context assembly are related but not identical
- compaction belongs to the runtime architecture, not only the UI

7. Service lifecycle

- OpenClaw is meant to stay up
- status, health, probe, restart, and Windows startup are part of the product

8. Channel routing as a first-class system

- one gateway can route many channels
- channel, account, room, group, and peer all affect session routing

9. Dreams are not decorative

- dreaming is a background memory pipeline with storage, scoring, cron, and diary output

10. Control UI is one client, not the whole product

- mac app, CLI, web UI, WebChat, and nodes all talk to the same gateway protocol

## G. Bottom Line

OpenClaw was built as a service platform first, a control UI second, and a chat product third.

That is the real build lesson.

If OmniClaw follows the same order while simplifying channels and extension weight, we can build something lighter without losing the OpenClaw feel.

## Sources

- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/concepts/architecture
- https://docs.openclaw.ai/concepts/agent
- https://docs.openclaw.ai/concepts/context
- https://docs.openclaw.ai/concepts/context-engine
- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/concepts/dreaming
- https://docs.openclaw.ai/concepts/multi-agent
- https://docs.openclaw.ai/concepts/queue
- https://docs.openclaw.ai/concepts/session-tool
- https://docs.openclaw.ai/concepts/agent-workspace
- https://docs.openclaw.ai/start/bootstrapping
- https://docs.openclaw.ai/sessions
- https://docs.openclaw.ai/reference/session-management-compaction
- https://docs.openclaw.ai/channels/index
- https://docs.openclaw.ai/channels/pairing
- https://docs.openclaw.ai/cli/gateway
- https://docs.openclaw.ai/gateway
- https://docs.openclaw.ai/gateway/protocol
- https://docs.openclaw.ai/web/control-ui
- https://docs.openclaw.ai/web/dashboard
- https://docs.openclaw.ai/web/webchat
- https://raw.githubusercontent.com/openclaw/openclaw/main/package.json
- https://raw.githubusercontent.com/openclaw/openclaw/main/pnpm-workspace.yaml
- https://raw.githubusercontent.com/openclaw/openclaw/main/openclaw.mjs
- https://raw.githubusercontent.com/openclaw/openclaw/main/ui/package.json
- https://raw.githubusercontent.com/openclaw/openclaw/main/tsdown.config.ts
- https://raw.githubusercontent.com/openclaw/openclaw/main/Dockerfile
