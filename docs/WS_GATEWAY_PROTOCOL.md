# OmniClaw WebSocket Gateway Protocol

OmniClaw now exposes an OpenClaw-inspired gateway protocol over WebSocket at:

- `ws://localhost:3147/ws`

This protocol is intentionally small but follows the same pattern:

- a `connect` handshake message
- token-backed trust gates for gateway or paired-device access
- connect-rate limiting for failed handshake bursts
- per-method scope checks after connection
- typed `req` / `res` frames
- server-pushed `event` frames (gateway lifecycle + tool events + approvals)

## Message types

### Client -> Server

#### Connect (required first message)

```json
{ "type": "connect", "role": "operator", "gatewayToken": "omni_gateway_..." }
```

Paired devices can reconnect with:

```json
{ "type": "connect", "deviceId": "device_...", "deviceToken": "omni_device_..." }
```

Unknown devices can request pairing:

```json
{ "type": "connect", "role": "operator", "label": "Operator laptop", "fingerprint": "stable-device-id" }
```

#### Request

```json
{ "type": "req", "id": "1", "method": "gateway.overview", "params": {} }
```

### Server -> Client

#### Connected

```json
{ "type": "connected", "ok": true, "connectionId": "conn_...", "role": "operator", "scopes": ["operator.read"] }
```

#### Pairing Required

```json
{ "type": "pairing_required", "ok": false, "connectionId": "conn_...", "request": { "id": "pair_..." } }
```

#### Response

```json
{ "type": "res", "id": "1", "ok": true, "payload": { "overview": { "eventCount": 1 } } }
```

#### Event

```json
{ "type": "event", "seq": 12, "id": "event_...", "event": "agent.started", "payload": { "runId": "run_..." }, "at": "..." }
```

## RPC methods

### Gateway

- `gateway.overview`

### Sessions

- `sessions.list` (`{limit?}`)
- `sessions.get` (`{sessionId}`)

### Memory

- `memory.overview` (`{agentId?, limit?, dreamLimit?, candidateLimit?}`)
- `memory.promote` (`{agentId?, sourceType, sourceId?, title, text, importance?, tags?}`)
- `memory.dream` (`{agentId?, limit?, minScore?}`)

### Connectors

- `connectors.overview` (`{agentId?, limit?, pendingLimit?}`)
- `connectors.adapters` (`{}`)
- `connectors.updateAdapter` (`{adapterId, enabled?, defaultAgentId?, mode?, secret?}`)
- `connectors.testAdapter` (`{adapterId}`)
- `connectors.telegramStatus` (`{}`)
- `connectors.telegramStart` (`{intervalMs?, limit?}`)
- `connectors.telegramStop` (`{reason?}`)
- `connectors.telegramPoll` (`{limit?, timeoutSeconds?, offset?, mockUpdates?, reply?}`)
- `connectors.discordStatus` (`{}`)
- `connectors.discordStart` (`{connectNow?}`)
- `connectors.discordStop` (`{reason?}`)
- `connectors.discordDispatch` (`{mockEvents?, event?, payload?, reply?}`)
- `connectors.webhook` (`{message, label?, agentId?, token?}`)
- `connectors.updateConfig` (`{webhook?: {enabled?, defaultAgentId?, allowPayloadAgent?, requireToken?}, fileDrop?: {enabled?, defaultAgentId?, archiveProcessed?}}`)
- `connectors.rotateWebhookToken` (`{}`)
- `connectors.scanFileDrop` (`{agentId?, limit?}`)

### Agent

- `agent.send` (`{message, sessionId?, label?, agentId?, channel?}`)

### Approvals

- `approvals.list` (`{status?}`)
- `approvals.resolve` (`{approvalId, decision, note?}`)

### Trust

- `trust.overview` (`{status?}`)
- `trust.requestPairing` (`{label, role, fingerprint}`)
- `trust.approvePairing` (`{requestId, note?}`)
- `trust.rejectPairing` (`{requestId, note?}`)
- `trust.revokeDevice` (`{deviceId, note?}`)
- `trust.rotateDeviceToken` (`{deviceId, note?}`)
- `trust.rotateGatewayToken`
- `trust.revokeGatewayToken`

### Shell

- `shell.audit` (`{limit?, status?, risk?, query?}`)
- `shell.updatePolicy` (`{allowlistMode?, timeoutMs?, maxOutputBytes?, allowlistPatterns?, blockedPatterns?}`)

### Skills

- `skills.list`
- `skills.create` (`{name, triggers, description, instructions}`)

### Config

- `config.get`
- `config.update` (`{profile?, providerMode?, model?}`)
- `provider.applyProfile` (`{profileId}`)
- `provider.setKey` (`{providerId, apiKey}`)
- `provider.keyStatus` (`{providerId?}`)
- `provider.test` (`{profileId?, mode?, baseUrl?, model?, apiKeyProviderId?}`)

### Workspace

- `workspace.status`

### Plugins

- `plugins.list`
- `plugins.toggle` (`{pluginId, enabled}`)
- `plugins.updateConfig` (`{pluginId, config}`)

### Jobs

- `jobs.list` (`{limit?}`)
- `jobs.enqueueTool` (`{tool, input?}`)
- `jobs.cancel` (`{jobId, reason?}`)

## Scope model

Operator connections receive:

- `operator.read`
- `operator.write`
- `operator.approvals`

Node connections receive:

- `node.read`
- `node.write`

RPC methods are denied with `code: "forbidden"` when the connected device does not hold one of the method's required scopes. Trust mutation, approval resolution, and shell policy updates require `operator.approvals`; config, plugins, schedules, skills, and chat writes require `operator.write`; node connections are limited to node-safe reads plus job enqueue/cancel.

## Notes

- This is still a small JSON text-frame protocol.
- Role scopes are attached at connection time and enforced before RPC dispatch.
- Gateway and device tokens now include lifecycle metadata (`issuedAt`, `expiresAt`, `lastUsedAt`, `status`).
- For full OpenClaw-style parity, the next milestone is a typed schema layer + method idempotency keys + subscriptions.
