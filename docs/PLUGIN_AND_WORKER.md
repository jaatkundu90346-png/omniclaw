# OmniClaw Plugin And Worker Layer

This milestone adds the first extensibility and background execution layer.

## Plugins

Plugins live under `plugins/<plugin-id>/plugin.json`.

The first plugin is:

- `plugins/omni-core/plugin.json`

Plugin manifests can declare:

- `id`
- `name`
- `version`
- `description`
- `capabilities`
- `tools`

Declared plugin tools appear in the normal tool registry and can be run by chat, HTTP jobs, or WebSocket jobs.

## Plugin control

OmniClaw validates plugin manifests before exposing tools.

Invalid plugins stay visible in the dashboard but their tools are not registered.

Plugins can be enabled or disabled through:

- `POST /api/plugins/toggle`
- WebSocket `plugins.toggle`

Plugins can also expose default config through `configDefaults`. User overrides are stored under `pluginConfig` in `data/config.json`.

## Jobs

Jobs are persisted in:

- `data/jobs.json`

The first worker supports tool jobs:

```json
{
  "tool": "plugin_echo",
  "input": { "message": "hello" }
}
```

## APIs

- `GET /api/plugins`
- `POST /api/plugins/toggle`
- `POST /api/plugins/config`
- `GET /api/jobs`
- `POST /api/jobs`
- WebSocket `plugins.list`
- WebSocket `plugins.toggle`
- WebSocket `jobs.list`
- WebSocket `jobs.enqueueTool`

## Next upgrades

- plugin enable/disable controls
- plugin-owned HTTP routes
- channel connector plugins
- provider plugins
- recurring job schedules
