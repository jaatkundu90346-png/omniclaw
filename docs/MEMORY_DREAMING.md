# Memory and Dreaming

OmniClaw now has a lightweight long-term memory and dream sweep baseline.

## What exists

- Short-term memory still tracks conversations, notes, research, and artifacts in `data/memory.json`.
- Promoted long-term memories are stored in `data/memory.json` under `longTerm`.
- A readable Markdown memory file is generated at `data/MEMORY.md`.
- Promotion candidates are generated from:
  - explicit notes
  - recent conversations
  - saved research
- Dream sweeps promote high-scoring candidates into long-term memory.
- Dream sweep runs are recorded in a dream diary under `dreams`.
- The context engine includes promoted long-term memory in provider context.
- Dashboard Memory panel supports:
  - manual memory promotion
  - candidate promotion
  - dream sweep runs
  - long-term memory review
  - dream diary review

## API

- `GET /api/memory`
- `GET /api/memory?agentId=main`
- `POST /api/memory/promote`
- `POST /api/memory/dream`

## Tools

- `list_long_term_memory`
- `promote_memory`
- `dream_memory_sweep`

Because `dream_memory_sweep` is a normal tool, it can also be scheduled through the Scheduler panel.

## Current limits

- Candidate scoring is heuristic, not model-ranked.
- Memory edits are promote-only for now; no archive/delete UI yet.
- `data/MEMORY.md` is generated from JSON and should not be treated as the source of truth.
- Dream sweeps are lightweight; they do not yet generate deep reflective summaries.

## Next hardening

- Add memory archive/delete/edit controls.
- Add model-assisted memory scoring when a real provider is configured.
- Add scheduled default dream sweep.
- Add per-agent memory boundaries and transfer controls.
- Add memory conflict detection.
