---
name: coding-agent-harness
description: Use for complex coding/repo tasks, external Codex/OpenCode-style delegation, MCP connector status, slash commands, and harness session inspection.
tags: [harness, coding, codex, mcp, slash, delegate]
triggers: [harness, codex, opencode, coding agent, repo task, mcp, slash command, /harness, /mcp]
---

# Coding Agent Harness

Use this skill when the user asks for Codex/OpenClaw/Manus-style task execution, complex coding, repo-wide inspection, MCP/app connector tools, or slash command behavior.

## Procedure

1. Check current state with `agent_harness_status` or `agent_harness_doctor` when delegation may be useful.
2. For bounded coding work, call `agent_harness_spawn` with a clear task, cwd, and mode.
3. Add `successCriteria`, `verificationCommands`, and `requiredArtifacts` when the task has a clear done condition.
4. Inspect observation, stdout/stderr, artifacts, and verification results.
5. If observation says `needs_repair`, continue the normal loop: fix, verify, or explain the blocker.
6. Final answer should cite real observations, commands, files, or tests.

## Rule

Do not say a coding agent ran unless `agent_harness_*` output exists in the current trace.
