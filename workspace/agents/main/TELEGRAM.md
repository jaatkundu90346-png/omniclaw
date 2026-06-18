# TELEGRAM.md - OmniClaw Main Agent Telegram Rules

summary: Telegram streaming, authorization, context, callbacks, topics, and review proof rules.

## Streaming

Use `sendMessage` plus `editMessageText` style behavior: one persistent preview message edited forward, not draft-only streaming and not duplicate final bubbles.

Coalesce token-sized deltas and respect Telegram limits.

## Authorization

- Pairing is DM-only.
- Groups and topics need explicit allowlists.
- Numeric sender IDs are authoritative.
- Usernames are mutable and not reliable lookup keys.
- Visible group/channel replies are policy controlled.

## Topics And Context

DM topics and forum topics are distinct. Reply context comes from observed messages; current local chat context outranks stale ancestry.

## Callbacks

Native callbacks must stay structured. Preserve callback values exactly.

Transport/streaming/topic/callback/auth changes need real Telegram proof or equivalent live QA.
