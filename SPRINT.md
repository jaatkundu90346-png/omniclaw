# Sprint Contract
**Block:** Configure Claude Code with You.bot loopback adapter
**Agreed:** 2026-08-03T04:02:52.437Z
## Scope (will do)
- Inspect the existing adapter's Claude configuration guidance
- Configure local Claude Code to route Anthropic Messages requests through 127.0.0.1:8787
- Start the existing adapter and perform a non-interactive Claude Code connection smoke test
- Document verified setup and known native tool-calling limitation
## Files to change
- Claude Code user settings or launcher environment only if present
- you-bot-adapter documentation only if setup guidance requires correction
- PROGRESS.md
## Do NOT touch
- src/core/**
- server.js
- computer-control/**
- gta6-clone/**
- neon-open-world/**
- API keys or secret-store contents
## Pass criteria (verifiable)
- Claude CLI installation/version is observed
- Claude Code base URL points to http://127.0.0.1:8787 without persisting the real You.bot key
- Adapter /health returns success
- A Claude Code non-interactive request reaches the adapter and returns a valid response, or an exact runtime blocker is recorded
## Exclusions (out of scope)
- Claiming native tool calling support
- Saving the exposed You.bot API key in source or settings
- Changing OmniClaw provider/core configuration
- Installing Claude Code without user approval if it is absent
