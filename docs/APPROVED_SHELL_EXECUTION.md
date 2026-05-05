# Approved Shell Execution

OmniClaw now has a first-pass shell execution path that is gated by approvals.

## What exists

- `plan_shell_command` still creates a `shell-plan` approval instead of running immediately.
- Approving a `shell-plan` runs the command through `ShellExecutor`.
- Rejected approvals do not execute.
- Execution uses the workspace root as the default current working directory.
- Execution is capped by timeout and output size.
- Execution blocks known destructive command patterns before spawning a shell.
- Shell plans include risk analysis and allowlist status before approval.
- Shell executions are written to a dedicated audit log.
- Execution result is stored on:
  - the approval record as `execution`
  - the gateway run as `shellExecutions`
  - the session transcript as a `shell.execution` system event
- Gateway emits:
  - `shell.execution_started`
  - `shell.execution_completed`
  - `shell.execution_failed`
- The dashboard recent runs list now surfaces the latest shell execution status/output summary.

## Runtime policy

Defaults live in `config/default.json` under:

- `tools.permissions.allowShellExecution`
- `tools.shellExecution.cwd`
- `tools.shellExecution.allowlistMode`
- `tools.shellExecution.allowlistPatterns`
- `tools.shellExecution.timeoutMs`
- `tools.shellExecution.maxOutputBytes`
- `tools.shellExecution.blockedPatterns`

## Current limits

- This is still local shell execution. Only expose OmniClaw beyond localhost after dashboard auth is added.
- The safety blocklist is a baseline, not a sandbox.
- Long-running interactive commands are not supported.
- Commands are executed through PowerShell on Windows and `/bin/sh` elsewhere.
- There is no per-command allowlist UI yet.

## Next hardening

- Add per-command allowlists and trust-level policies.
- Add execution target selection.
- Add richer execution detail panel.
- Add streaming stdout/stderr.
- Add command history search and audit filters.
