# TELEGRAM.md - OmniClaw Shared Telegram Rules

summary: Telegram streaming, authorization, context, callbacks, topics, and review proof rules.

## Streaming

Use one persistent preview message. Edit it forward. Do not send an extra final bubble unless final edit failed.

Respect Telegram limits in the Telegram layer, including 4096 character chunks and poll option caps.

## Authorization

- Pairing is DM-only.
- Groups/topics require explicit allowlists.
- Numeric sender IDs are authoritative.
- Usernames are mutable and not reliable arbitrary-user lookup keys.
- Visible group/channel replies are policy-controlled.

## Context

Reply context comes from observed updates. Current local chat context outranks stale reply ancestry.

## Callbacks

Approvals, native commands, plugins, selects, and multiselects must remain structured. Preserve callback values exactly.

Telegram behavior changes need live Telegram proof or equivalent bot-to-bot QA.
