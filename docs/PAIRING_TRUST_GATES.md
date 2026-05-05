# Pairing and Trust Gates

OmniClaw now has a first-pass trust layer for gateway tokens, paired devices, and WebSocket connection gating.

## What exists

- `DeviceTrustStore` persists trust state in `data/trust.json`.
- Gateway tokens are stored only as SHA-256 hashes with a masked preview.
- Device tokens are shown once on approval or rotation, then stored only as hashes.
- Pairing requests track label, role, fingerprint, remote address, scopes, and approval status.
- WebSocket clients must connect with either a valid gateway token or a trusted device token.
- Unknown WebSocket clients receive a `pairing_required` or `device_token_required` response.
- WebSocket RPC methods are checked against the connected role scopes before dispatch.
- The dashboard Trust panel can request pairing, approve/reject requests, rotate gateway tokens, rotate device tokens, and revoke devices.

## HTTP API

- `GET /api/trust`
- `POST /api/trust/gateway/rotate`
- `POST /api/trust/pairing/request`
- `POST /api/trust/pairing/approve`
- `POST /api/trust/pairing/reject`
- `POST /api/trust/devices/rotate-token`
- `POST /api/trust/devices/revoke`

## WebSocket handshake

First message must still be a `connect` frame.

Gateway-token connection:

```json
{
  "type": "connect",
  "role": "operator",
  "gatewayToken": "omni_gateway_..."
}
```

Paired-device connection:

```json
{
  "type": "connect",
  "deviceId": "device_...",
  "deviceToken": "omni_device_..."
}
```

Unknown device request:

```json
{
  "type": "connect",
  "role": "operator",
  "label": "Operator laptop",
  "fingerprint": "stable-device-fingerprint"
}
```

The server answers with `pairing_required` until the dashboard approves the request. If the fingerprint is already trusted but no token is supplied, the server answers with `device_token_required`.

## Current limits

- No token export after creation. This is intentional; rotate if a token is lost.
- Fingerprints are caller-provided for now. A stronger native connector should generate stable device identities later.
- HTTP dashboard routes are local and not separately auth-gated yet.

## Next hardening

- Add trust audit detail pages.
- Add one-click copy affordance for one-time tokens.
- Add signed node identities for connector processes.
- Add dashboard protection before exposing OmniClaw outside localhost.
