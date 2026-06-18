# CHANNEL_DOCKING.md - OmniClaw Shared Channel Docking

summary: Move one active session's reply route between linked chat channels without losing conversation context.

Channel docking is call forwarding for one agent session. It keeps the same conversation context and transcript, but changes where future replies for that session are delivered.

## Core Rule

Docking must be a real gateway/channel action, not just an assistant explanation. The assistant may explain docking, but actual docking requires updating session delivery route fields.

## Identity Links

Docking requires source sender and target peer to belong to the same identity group.

Example:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123", "discord:456", "slack:U123"]
    }
  }
}
```

Values are channel-prefixed peer ids. The group key is only a canonical label.

## Commands

- `/dock-discord` or `/dock_discord`
- `/dock-slack` or `/dock_slack`
- `/dock-telegram` or `/dock_telegram`
- `/dock-mattermost` or `/dock_mattermost`

## What Changes

The active session delivery route:

- `lastChannel`
- `lastTo`
- `lastAccountId`

The session transcript and context stay attached to the same session.

## What Does Not Change

Docking does not connect a new channel, create bot tokens, grant access, bypass allowlists, move history to a new session, merge unrelated users, or change provider/tool permissions.

## Safety

- Verify source and target are linked.
- Respect channel allowlists and DM policies.
- Do not dock to public/group destinations unless explicitly allowed.
- Persist an audit event for success/failure.
- Never leak private session context to an unlinked peer.

## Troubleshooting

Sender not linked: add both channel-prefixed ids to the same identity group.

No active session: dock from an existing session.

Replies still old channel: inspect success event and session `lastChannel`/`lastTo`/`lastAccountId`.

Switch back: use the matching dock command for the original channel from a linked sender.
