# Context Engine and Compaction

OmniClaw now has a first-pass context engine between runtime state and provider calls.

## What exists

- `ContextEngine` builds a compact provider bundle for every agent run.
- The engine estimates JSON character usage and applies a profile-based budget.
- Default budgets are:
  - `lite`: 12000 chars
  - `balanced`: 22000 chars
  - `power`: 36000 chars
- Context sections include message, plan, tool outputs, matched skills, notes, recent conversations, research, artifacts, tasks, and tools.
- Secret-looking keys such as token, secret, password, bearer, authorization, and api key are redacted during compaction.
- Each run stores a `context` report in the gateway run record.
- Each run emits `context.compacted` with used chars, max chars, and omitted item count.
- The mock provider now reports context budget usage in its reply.
- The OpenAI-compatible provider receives compacted context sections instead of raw unbounded arrays.

## Why this matters

This is a lightweight version of the control-plane layer OmniClaw needs before it grows heavier features. Instead of passing everything to the provider, the runtime creates a bounded context bundle and records what was included or omitted.

## Current limits

- Character count is an approximation, not tokenizer-accurate.
- There is no persisted long-form summary memory yet.
- There is no user-facing context detail panel yet beyond run metadata/raw state.
- Section budgets are fixed heuristics for now.

## Next hardening

- Add persistent conversation summaries.
- Add context detail view in the dashboard.
- Add profile-configurable section budgets.
- Add tool-result pruning by permission and risk.
- Add context tests with intentionally oversized memory.
