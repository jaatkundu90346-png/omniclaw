# OmniClaw Plugin Manifest Lifecycle

This milestone moves OmniClaw closer to an OpenClaw-style platform shape.

## Built

- manifest-first plugin loading
- `setup` and `runtime` sections in plugin manifests
- plugin-owned config schema with typed fields
- config validation before runtime tools are exposed
- enable/disable persistence in `data/config.json`
- lifecycle refresh events:
  - `plugin.discovered`
  - `plugin.reloaded`
  - `plugin.status_changed`
  - `plugin.validation_failed`
  - `plugin.config_invalid`
  - `plugin.ready`
- plugin detail endpoint and reload endpoint
- control UI plugin detail pane with dynamic config form

## Practical effect

OmniClaw plugins are no longer just loose tool declarations.

They now have:

- declared setup shape
- declared runtime tool surface
- owned configuration
- validation-backed status
- lifecycle events that flow through the gateway

## Next

The next highest-value build remains multi-agent routing:

- route sessions by agent id
- separate agent workspaces
- per-agent memory and skills
- agent switcher in control UI
