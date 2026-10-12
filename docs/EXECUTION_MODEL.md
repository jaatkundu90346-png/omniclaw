# OmniClaw Execution Model

## Why this layer exists

OmniClaw should become powerful without becoming reckless. The runtime now distinguishes between safe direct actions and higher-risk actions that need stronger approval.

## Current classes

### Safe direct tools

- get current time
- save note
- list notes
- create task
- list tasks
- runtime summary

### Gated workspace tools

- list files
- read file

These are restricted to the OmniClaw workspace root and controlled by config permissions.

### Approval-oriented actions

- shell command planning

Right now OmniClaw creates a structured shell request instead of executing it automatically. This is the bridge toward a future approval UI and audit trail.

## Why this matters for product quality

This model helps us build a better product than heavyweight agent systems by making behavior:

- understandable
- configurable
- safer by default
- easier to trust

## Next extensions

1. File write tools with protected target directories
2. Shell approvals with allowlists
3. Web search adapters
4. Browser automation sessions
5. Background jobs and schedules
