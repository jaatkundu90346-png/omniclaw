# OmniClaw BYOK Provider Setup

OmniClaw supports BYOK provider setup through the dashboard, HTTP API, and WebSocket gateway.
It also supports an OpenAI account bridge through the official Codex CLI for users who want to use ChatGPT/Codex subscription access instead of a direct API key.

## Storage

Runtime provider config is stored in:

- `data/config.json`

API keys are stored separately in:

- `data/secrets.json`

Dashboard and API responses expose only masked key status.

## HTTP APIs

- `POST /api/provider/profile`
- `POST /api/provider/key`
- `GET /api/provider/key/status`
- `POST /api/provider/test`
- `POST /api/provider/codex/login`

## WebSocket methods

- `provider.applyProfile`
- `provider.setKey`
- `provider.keyStatus`
- `provider.test`

## Profiles

Default profiles live in:

- `config/default.json`

Current profiles:

- `openai`
- `anthropic`
- `gemini`
- `groq`
- `openrouter`
- `codex-cli`
- `local-compatible`

All remote profiles use `openai-compatible` transport mode with provider-specific base URLs and API key ids.

`codex-cli` is different: it uses the local `codex exec` command in read-only sandbox mode. Setup flow:

1. Select `openai-account / codex-cli` in the BYOK panel.
2. Click `Open Codex setup`.
3. The terminal installs `@openai/codex` if the current Windows app alias cannot run, then starts `codex login`.
4. Choose `Sign in with ChatGPT`.
5. Return to OmniClaw and click `Test readiness`.

This does not copy ChatGPT tokens into OmniClaw. Authentication stays with the official Codex CLI cache.
