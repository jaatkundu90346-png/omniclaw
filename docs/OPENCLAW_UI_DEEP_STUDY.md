# OpenClaw UI Deep Study

This note captures what we learned from the live OpenClaw Control UI access, official docs, and source inspection. The goal is to avoid copying the surface only; OmniClaw should copy the bones: gateway-first connection, streaming chat, tools, sessions, skills, nodes, config, approvals, and operational safety.

## Direct Browser Observations

- Public `curl` to `https://clowdbot-bf2564ac.fly.dev/__openclaw__/chat?session=agent%3Amain%3Amain` returns `401 Unauthorized`, so the UI depends on browser session/auth, not just static HTML.
- The live UI is a light control shell, not a dark dashboard. It uses a left navigation rail, pale gray canvas, white cards/panels, red accent for active state/actions, and compact top controls.
- The sidebar has grouped navigation: Chat, Control, Agent, Settings, Docs, version badge.
- The Control group expands into Overview, Channels, Instances, Sessions, Usage, and Cron Jobs.
- The Agent group includes Agents, Skills, Nodes, and Dreaming.
- Settings expands into deeper configuration surfaces. Source shows Config, Communications, Appearance, Mobile, Voice, AI Agents, Debug, and Logs.
- The Chat screen has breadcrumb `OpenClaw > Chat`, a search field, top selectors for channel/session/model/profile, and action icons for refresh, agent/brain, tools, focus, and time/history.
- Chat renders live tool-call and tool-output cards inline. Tool cards are collapsible, typed by tool name, and appear as first-class chat events, not raw JSON dumps.
- The composer is bottom anchored and supports attachment/mic/plus/send-style actions.
- The Skills panel has status tabs, filter/search, ClawHub registry search/install, built-in skills, readiness state, toggles, and API-key/config setup.
- The Nodes panel manages paired devices and commands. It exposes exec approvals, gateway/node target selection, allowlist loading, and node binding.
- The Dreaming panel is not decorative only. It is a memory consolidation/reflection surface with Scene, Diary, Advanced tabs, on/off state, promoted count, and light/deep/REM modes.
- The Docs entry opens the OpenClaw docs site. The observed UI version was `v2026.4.21`.

## Live Gateway Access Panel

- The Overview page contains the Gateway Access card. This is the real entry point before Chat can work.
- The card has a WebSocket URL field. In the live remote UI it points at a secure `wss://.../__openclaw__` endpoint on the Fly deployment.
- The card has a Gateway Token field. The token is treated as a secret and should stay masked; it is used during the WebSocket handshake.
- The card also has a Password field marked as not stored. This matches the docs: passwords are not persisted, while dashboard token state is scoped to the current browser/session/gateway URL.
- The card has a Default Session Key field. The observed value was `agent:main:main`, which explains the chat URL session parameter.
- The card has a Language selector and Connect/Refresh buttons. Changing URL/token/session requires clicking Connect to apply connection changes.
- The Snapshot card below the gateway access card showed live gateway health: status OK, uptime, tick interval, and channel refresh status.
- Product implication: OmniClaw needs a first-class Gateway Access panel. It should not hide connection details inside settings; it should show WS URL, token/password, session key, connect/reconnect, and live handshake snapshot before Chat.

## Mobile Gateway Dashboard Login

- The Instagram DM reference image showed the mobile OpenClaw Gateway Dashboard before connection.
- It is a narrow dark login card titled `OpenClaw` with subtitle `Gateway Dashboard`.
- Fields shown: WebSocket URL, Gateway Token, Password (not stored), and a red Connect button.
- The observed WebSocket URL format is a secure hosted endpoint, e.g. `wss://<gateway-host>`.
- Gateway Token is masked and has an eye/hide control. It must be treated as a secret and never echoed in logs or UI summaries.
- Below Connect, the UI explains setup steps:
- Start the gateway on the host machine with `openclaw gateway run`.
- Get a tokenized dashboard URL with `openclaw dashboard`.
- Paste the WebSocket URL and token above, or open the tokenized URL directly.
- Product implication: OmniClaw should have a dedicated first-run Gateway Dashboard screen before the full app shell. This screen should be mobile-friendly, dark/compact, and focused only on connection bootstrap.

## Official Docs Findings

- Control UI is a Vite + Lit SPA served by the Gateway, defaulting to `http://<host>:18789/`.
- It speaks directly to the Gateway WebSocket on the same port. This means the gateway exists before chat can work.
- Auth is enforced during WebSocket handshake with token, password, Tailscale identity headers, or trusted-proxy identity headers.
- New browsers/devices may need one-time pairing approval; local loopback is auto-approved, but Tailnet/LAN can require explicit approval.
- Chat is WebSocket/RPC driven: `chat.history`, `chat.send`, `chat.abort`, and `chat.inject`.
- `chat.send` is non-blocking. It immediately acknowledges with a run id/status, then response text/tool events stream through chat events.
- The chat header model/thinking controls patch the active session with `sessions.patch`; they are session overrides, not one-message-only parameters.
- Control UI can manage channels, instances, sessions, dreaming, cron jobs, skills, nodes, exec approvals, config, debug snapshots, live logs, and updates.
- Config editing has safety: schema/form rendering, raw JSON only when safe, base-hash guard against concurrent clobbering, and SecretRef preflight checks.

## UI Implementation Stack

- There is no evidence that OpenClaw UI is exported from Canva or a visual design tool.
- The official docs describe the Control UI as a small Vite + Lit single-page app served by the Gateway.
- `ui/package.json` names the package `openclaw-control-ui` and defines scripts like `vite build`, `vite`, `vite preview`, and `vitest`.
- The UI dependencies include `lit`, `markdown-it`, `marked`, `dompurify`, and `@create-markdown/preview`. This points to hand-built web components and markdown rendering, not a Canva export.
- Dev/test dependencies include `vite`, `vitest`, `playwright`, and `jsdom`.
- `ui/src/main.ts` imports `styles.css` and `ui/app.ts`.
- `ui/src/ui/app.ts` defines a custom Lit element with `@customElement("openclaw-app")` and extends `LitElement`.
- `ui/src/styles.css` imports hand-written CSS modules: `base.css`, `layout.css`, `layout.mobile.css`, `components.css`, `chat.css`, `config.css`, `config-quick.css`, `cron-quick-create.css`, `usage.css`, and `dreams.css`.
- Source references to `canvasHost` are not Canva. They refer to OpenClaw hosted/embedded canvas/web-content features.
- Product implication: OmniClaw should not try to use Canva-style generated UI. The right lightweight clone path is plain HTML/CSS/JS or Lit-style web components with modular CSS and a WebSocket gateway protocol.

## Source Findings

- Navigation source groups tabs as:
- Chat: `chat`.
- Control: `overview`, `channels`, `instances`, `sessions`, `usage`, `cron`.
- Agent: `agents`, `skills`, `nodes`, `dreams`.
- Settings: `config`, `communications`, `appearance`, `mobile`, `voice`, `aiAgents`, `debug`, `logs`.
- Chat view source includes session key management, attachments, speech/STT, pinned/deleted messages, slash commands, run controls, context notices, fallback/compaction indicators, side result rendering, markdown sidebar, and tool-card expansion state.
- Skills view source includes installed skill status, filters, grouped skills, ClawHub search/detail/install, enable/disable, install actions, API key edits, missing requirements, and source/homepage metadata.
- Channels view source handles WhatsApp, Telegram, Discord, Google Chat, Slack, Signal, iMessage, Nostr, account states, per-channel config, and recent activity state.
- Nodes view source and docs connect nodes with capabilities and exec approval policy.

## Product Implications For OmniClaw

- Build gateway-first, not chat-first. The UI should show connection/auth/session health before enabling chat.
- Chat must become a streaming run surface: ack run id, stream assistant deltas, stream tool cards, show abort/stop.
- Tool output should be rendered as structured cards with expand/collapse, not raw JSON.
- Sessions need their own panel and per-session overrides: model, thinking, verbosity, reasoning/trace flags.
- Add a Control group: Overview, Channels, Instances, Sessions, Usage, Jobs/Cron.
- Add an Agent group: Agents/workspaces, Skills/store, Nodes/devices, Dreaming/memory.
- Add Settings group: Config form/raw JSON, Logs, Debug, Appearance, Provider/BYOK, Updates.
- Add exec approvals as a first-class safety system: gateway/node targets, allowlists, ask policy, and pending approvals.
- Keep UI lightweight, but do not oversimplify the architecture. OpenClaw feels powerful because each panel maps to a real gateway capability.

## Next OmniClaw Build Order

1. Gateway shell and connection state: WebSocket status, auth/token placeholder, session key, and gateway overview.
2. Chat streaming protocol: non-blocking run ack, event stream, abort, inject, tool cards.
3. Control panels: Overview, Sessions, Jobs/Cron, Logs, Debug.
4. Agent panels: Skills store, Plugins, Nodes/devices, Memory/Dreaming.
5. Settings/config: schema-ish form, raw JSON with base-hash guard, BYOK/provider profiles.
6. UI redesign after the above model is understood: light OpenClaw-style shell with functional panels, not a decorative clone.
