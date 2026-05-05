# OmniClaw Gateway Session Backbone

This milestone adds the first real OpenClaw-style control-plane backbone to OmniClaw.

## What now exists

- persistent session store
- append-only session transcript files
- persistent run store
- gateway event log
- approval queue
- workspace bootstrap files
- server endpoints for gateway, sessions, approvals, and workspace state
- dashboard panels for events, sessions, approvals, bootstrap status, and session detail
- manual session reset/archive flow
- per-session active run guard
- per-session queued run serialization
- recent run inspection with queue state

## Core data files

- `data/sessions.json`
- `data/sessions/transcripts/*.jsonl`
- `data/gateway.json`
- `workspace/AGENTS.md`
- `workspace/SOUL.md`
- `workspace/TOOLS.md`
- `workspace/IDENTITY.md`
- `workspace/USER.md`

## Why this matters

This shifts OmniClaw from a single-turn assistant into a control plane with:

- session identity
- session transcript persistence
- run lifecycle
- queue-aware run control
- event visibility
- approval handling
- editable workspace bootstrap context

## Current limitations

- events use HTTP SSE, not the full OpenClaw-style WebSocket RPC protocol yet
- approvals are tracked and resolvable, but they do not execute the blocked command afterward
- there is only one default agent runtime, not full multi-agent routing yet
- richer queue modes and deeper compaction/context-engine behavior are still ahead

## Best next upgrade

Build plugin-owned config and manifest-first plugin lifecycle on top of this queue-safe session model, then continue into multi-agent routing.
