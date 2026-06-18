# CHANNEL_DOCKING.md - OmniClaw Main Agent Channel Docking

summary: Move one active session's reply route between linked chat channels without losing conversation context.

Channel docking is like call forwarding for one OmniClaw session. It keeps the same session and transcript, but changes where future replies are delivered.

## Example

If one user is linked across Telegram and Discord:

```json5
{
  session: {
    identityLinks: {
      alice: ["telegram:123", "discord:456"]
    }
  }
}
```

When Alice sends `/dock_discord` from Telegram, the current session remains the same, but future replies route to Discord peer `456`.

## Required Config

Source sender and target peer must be in the same `session.identityLinks` group.

Use channel-prefixed ids:

- `telegram:123`
- `discord:456`
- `slack:U123`
- `mattermost:abc`

The canonical key, such as `alice`, is just the identity group name.

## Commands

Common command forms:

- `/dock-discord` / `/dock_discord`
- `/dock-slack` / `/dock_slack`
- `/dock-telegram` / `/dock_telegram`
- `/dock-mattermost` / `/dock_mattermost`

## Runtime Flow

```text
command received -> resolve active session -> resolve source peer -> find identity group -> find target peer -> validate channel policy -> update session delivery route -> persist event -> confirm
```

## What Changes

Persist these delivery fields on the active session:

- `lastChannel`: target channel, e.g. `discord`
- `lastTo`: target peer id, e.g. `456`
- `lastAccountId`: target channel account id or `default`

Later outbound delivery should use those fields.

## What Does Not Change

Docking does not:

- create channel accounts
- connect Telegram/Discord/Slack/Mattermost
- grant access
- bypass allowlists or DM policy
- move transcript history
- merge unrelated users
- change model/provider/tool permissions

It only changes reply delivery for the current linked session.

## Safety

Do not dock unless the source and target are linked. Do not route private session replies to an unlinked peer. Respect allowlists, channel policies, and group/public-surface rules.

Persist an audit event for both successful and failed docking attempts.

## Troubleshooting

Sender not linked:

- Add current sender and target peer to the same identityLinks group.

No active session:

- Dock from an existing direct chat session.

Replies still go to old channel:

- Confirm command success, inspect `lastChannel`, `lastTo`, and `lastAccountId`, and check another session is not handling replies.

Need to switch back:

- Send the matching original channel dock command, such as `/dock_telegram`.

## Implementation Note

Until the real gateway command/tool exists, the agent should not claim docking is complete. It should explain the needed config/action and say the runtime docking command still needs to update the active session delivery route.
