# TELEGRAM.md - OmniClaw Telegram Maintainer Decisions

summary: Telegram streaming, authorization, context, callbacks, topics, and review proof rules.

## Streaming

Use one persistent preview message for streaming. Edit it forward with cumulative text. Do not send an extra final bubble unless the final edit failed.

Respect Telegram limits in the Telegram layer:

- 4096 character message chunks
- poll option caps
- debounced/coalesced token deltas

Do not reintroduce draft-only streaming as the final delivery path.

## API Ownership

Prefer grammY/native Telegram primitives when they own behavior. Throttling is bot-token scoped; clients sharing a token should share throttling.

DM topics and forum topics are different. direct_messages_topic_id and message_thread_id are not interchangeable.

## Authorization

- Pairing is DM-only.
- Group/topic authorization needs explicit allowlists.
- Telegram allowlists should use numeric sender IDs.
- Usernames are mutable and not a reliable arbitrary-user lookup key.
- Group/channel visible replies are policy-controlled; normal room replies stay private unless explicit visible reply policy/tool use allows it.

## Reply Context

Reply context comes from observed updates. There is no reliable arbitrary historical getMessage hydration path. Current local chat context outranks stale reply ancestry.

## Callbacks

Native callbacks for approvals, commands, plugins, selects, and multiselects must stay structured. Preserve callback values exactly, including delimiters.

Slash commands should be fast-pathable before full workspace/agent-turn setup when possible.

## Review Standard

Telegram behavior changes need live Telegram proof or equivalent bot-to-bot QA when touching transport, streaming, topics, callbacks, authorization, or reply context.
