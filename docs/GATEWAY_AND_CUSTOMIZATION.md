# OmniClaw Gateway And Customization

## What this adds

OmniClaw now has gateway-style control surfaces instead of only a chat endpoint.

### Gateway routes

- `GET /api/state`
- `GET /api/config`
- `POST /api/config`
- `GET /api/skills`
- `POST /api/skills`
- `POST /api/chat`

## Why this matters

OpenClaw-class products are not just chatbots. They need:

- a control plane
- runtime configuration
- a skill store
- self-customization hooks

OmniClaw now has the start of that architecture.

## Current self-customization

- create local skill files
- switch runtime profile
- switch provider mode
- update provider model

## Next upgrades

1. Skill editing and deletion
2. Config diff/audit history
3. Gateway auth and permissions
4. Background worker and job queue
5. Multi-surface connectors
