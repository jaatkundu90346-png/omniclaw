# CHANNEL_DOCKING.md - OmniClaw Channel Docking

summary: Move one active session's reply route between linked chat channels without losing conversation context.

Read this when implementing or debugging cross-channel reply routing, linked identities, dock commands, or channel delivery behavior.

## Core Idea

Channel docking is call forwarding for one agent session. It keeps the same conversation context and transcript, but changes where future replies for that session are delivered.

Docking does not create a new session. It updates the delivery route for the active session.

## Example

If the same user is linked on Telegram and Discord:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123", "discord:456"]
    }
  }
}
```

When Alice sends /dock_discord from Telegram, the active session keeps its history but future replies go to Discord peer 456.

## Required Identity Links

Docking requires source sender and target peer to be in the same identity group.

Values are channel-prefixed peer ids:

- telegram:123
- discord:456
- slack:U123
- mattermost:abc

The group key such as alice is only a canonical identity label. Dock commands must prove that current sender and target peer are linked.

## Commands

Common command forms:

- /dock-discord or /dock_discord
- /dock-slack or /dock_slack
- /dock-telegram or /dock_telegram
- /dock-mattermost or /dock_mattermost

Underscore aliases are useful on command surfaces that dislike hyphens.

## What Changes

Docking updates delivery metadata for the active session:

- lastChannel: target channel id, e.g. discord
- lastTo: target peer id, e.g. 456
- lastAccountId: target channel account id or default

These fields must be persisted with the session and used by later outbound delivery.

## What Does Not Change

Docking does not:

- connect a new channel account
- create a bot token
- grant access to a user
- bypass allowlists or DM policies
- move transcript history
- merge unrelated users
- change provider/model/tool permissions

It only changes reply delivery for the current session.

## Safety And Policy

- Verify source and target are linked before docking.
- Respect channel allowlists and DM policies.
- Do not dock public/group destinations unless explicitly allowed.
- Do not leak private session context to an unlinked peer.
- Persist an audit event for successful or failed docking attempts.

## Troubleshooting

Sender is not linked:

- Add both source and target ids to the same identityLinks group.

No active session exists:

- Dock from an existing direct-chat session so there is a session route to update.

Replies still go to old channel:

- Confirm success event and inspect session lastChannel/lastTo/lastAccountId.
- Check that another session is not handling the later replies.

Need to switch back:

- Send the matching dock command for the original channel from a linked sender.

## Runtime Shape

```text
command received -> resolve session -> resolve source peer -> find identity group -> find target peer -> validate channel policy -> update session delivery route -> persist event -> confirm
```

## OmniClaw Implementation Notes

For OmniClaw, channel docking should be implemented as a runtime/channel feature, not as an LLM-only response. The assistant can explain docking, but actual docking needs a real tool or gateway command that updates session delivery fields.
