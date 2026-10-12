# Shell Execution Governance

OmniClaw now has a governance layer around approved shell execution.

## What exists

- Shell plans include a risk label before approval:
  - `low`
  - `medium`
  - `high`
  - `blocked`
- Shell plans record whether the command matched the configured allowlist.
- The executor re-checks policy after approval, so changing approval records cannot bypass policy.
- A dedicated audit log persists planning and execution records in `data/shell-audit.json`.
- The dashboard Execution panel shows policy summary, policy editor, audit filters, record list, and selected record detail.
- HTTP and WebSocket expose shell audit reads and guarded policy updates.
- Execution detail separates stdout and stderr for faster inspection.

## Policy config

Defaults live under `tools.shellExecution` in `config/default.json`.

- `allowlistMode`: `advisory` by default. Non-allowlisted commands are marked riskier but can still execute after approval.
- `allowlistPatterns`: regex list for known safe/read-only commands.
- `blockedPatterns`: regex list for destructive commands that cannot execute.
- `timeoutMs`: execution timeout.
- `maxOutputBytes`: stdout/stderr capture limit.

If `allowlistMode` is changed to `enforce`, commands outside the allowlist are blocked at execution time even if approved.

## API

- `GET /api/shell/audit`
- `GET /api/shell/audit?risk=high`
- `GET /api/shell/audit?status=completed`
- `GET /api/shell/audit?query=node`
- `POST /api/shell/policy`
- WebSocket RPC: `shell.audit`
- WebSocket RPC: `shell.updatePolicy`

## Current limits

- Risk classification is regex-based, not a full shell parser.
- The allowlist is advisory by default to avoid blocking common local tasks during development.
- Audit search is simple JSON text matching.
- Policy editing is intentionally simple: one regex pattern per line.
- Policy updates are local config writes and should be treated like security-sensitive operations.

## Next hardening

- Add command preview/diff for file mutations.
- Add separate policies per device role and agent.
- Add streaming execution output.
- Add exportable audit reports.
