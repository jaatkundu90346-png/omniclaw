# Hermes-Grade OmniClaw Implementation Plan

> **For OmniClaw:** Build the harness ourselves — the deterministic system around any model that turns LLM text into real, verified work: context, tool calling, permissions, sandboxing, hooks, logs, retries, memory, and verification.

**Goal:** OmniClaw ka harness model-agnostic ho: model rented/cloud/local/weak kuch bhi ho, OmniClaw itself should normalize tool calls, enforce permissions, run tools, verify, persist logs, and never claim fake success.

**Harness spine:**
```text
User/Channel → Gateway/CLI/Web UI → Session Queue → Context Engine → LLM Provider
→ Tool Router → Permission + Sandbox + Hooks → Tool Execution → Verifier
→ Memory + JSONL Logs → Final Reply/Stream
```

**Architecture:** Keep the existing OmniLoop/native tool-calling architecture as the center, but treat the model as replaceable. Add harness-level guardrails around it (tool-use enforcement, model-output normalization, pre/post tool hooks, verification gates, anti-spin, context recovery), then expand durable systems (skills, memory/session search, subagents, scheduler, gateway) behind tested contracts.

**Tech Stack:** Node.js ESM, `src/core/omni-loop.js`, `src/core/tool-registry.js`, `src/core/skill-registry.js`, `src/core/memory-store.js`, `src/core/sub-agent-spawner.js`, `src/core/scheduler.js`, smoke scripts under `scripts/*.mjs`.

---

## Quick Parity Audit — 2026-06-24

| Area | Current evidence | Hermes-grade gap | Priority |
|---|---|---|---|
| Agent loop | `src/core/omni-loop.js` has native function transcript, tool result truncation, context overflow recovery, anti-spin, verification nudge, read-before-edit guard, segmented parallel safe tool calls, text/XML/ReAct tool-call recovery, schema/arg repair, and deterministic before/after tool hooks. | Need keep moving policy/sandbox/logging out of model prompts and into harness-owned modules. **Fixed in this plan:** action/tool-use nudge, model-agnostic parsing/arg repair, and pre/post tool hook gate. | P0 |
| Tools | `src/core/tool-registry.js` has cacheable observation tools, side-effect tools, dedup exemptions, schema validation and sandbox/trust hooks. | Need richer toolset enable/disable UX, requirements checks, and toolset-level schema pruning like Hermes. | P1 |
| Skills | `src/core/skill-registry.js` supports bundled/workspace/agent/managed skills and matching. | Need automatic skill maintenance/curation, stronger trigger scoring, and user-approved skill creation from successful workflows. | P1 |
| Memory/session recall | `src/core/memory-store.js` has layered memory files + JSON stores; session history exists. | Semantic/FTS session search and better memory promotion/removal rules are still thin. | P1 |
| Subagents | `src/core/sub-agent-spawner.js` exists with active/completed tracking, max concurrent, timeout, tool limits. | Need delegated task contracts, reviewer subagents, isolated worktrees, and parent verification of child side effects. | P1 |
| Cron/background | `src/core/scheduler.js` + `schedule-store` enqueue tool jobs. | Need Hermes-style self-contained recurring agent prompts, output delivery rules, run history, and no-agent script jobs. | P2 |
| Gateway/channels | Gateway, WS protocol, connectors, Telegram/Discord worker files exist. | Need platform parity, topic/session routing, gateway approval flows, and robust logs/status. | P2 |
| Checkpoints/safety | `autonomous-checkpoint-store`, sandbox runner, trust store, and boundary checks exist. | Need default checkpoint/rollback flow around risky edits and clearer destructive-command approval. | P1 |
| Browser/media | Browser operator/playwright files exist; feature health marks browser readiness based on screenshot/click/type capabilities. | Need mandatory visual/browser verification for UI tasks and artifact-returning media tools. | P2 |

---

## P0 — Stop Fake Work, Force Real Tool Action

### Task P0.1: Add action/tool-use nudge for no-tool fake finals

**Objective:** If the user asks for a concrete file/web/browser/terminal action and the model returns a final answer without any tool call, OmniLoop must nudge once and require a tool observation before accepting final output.

**Files:**
- Modify: `src/core/omni-loop.js`
- Test: `scripts/omni-loop-smoke.mjs`

**Behavior:**
- First no-tool answer on actionable tasks is not accepted.
- OmniLoop injects an `[Action/tool-use check]` user message.
- Model gets one chance to call tools.
- Report records `actionNudges` and `roundDetails.status = "action-nudge"`.
- Still bounded: if model refuses again after nudge, final can proceed instead of infinite loop.

**Verification:**
```bash
npm run test:omni-loop
node --check src/core/omni-loop.js
node --check scripts/omni-loop-smoke.mjs
```

**Status:** Implemented in this work block.

### Task P0.2: Model-agnostic tool-call recovery for weak models

**Objective:** OmniLoop must not depend on rented/native function-calling. If a model emits a tool call as plain text, XML, ReAct, or markdown, the harness should recover it and execute the real tool through OmniClaw's own registry.

**Files:**
- Modify: `src/core/omni-loop.js`
- Test: `scripts/tool-call-parse-smoke.mjs`

**Behavior:**
- Supports JSON text calls: `{ "tool": "read_file", "args": {...} }`.
- Supports Hermes/Qwen JSON-in-`<tool_call>` wrappers.
- Supports Qwen3-Coder XML: `<function=read_file><parameter=path>...</parameter></function>`.
- Supports GLM arg-key/value XML.
- **New:** Supports ReAct text: `Action: read_file` + `Action Input: {...}`.
- **New:** Supports markdown/tool blocks: `Tool: exec` + fenced JSON `Input`.
- Unknown/unallowed tool names are ignored so prose cannot smuggle arbitrary tools.
- **New:** Repairs common schema/key mistakes before execution: `filepath/file/filename -> path`, `cmd/shell -> command`, `text/body -> content`, and string numbers/booleans to schema types.
- Report/event telemetry records repairs via `report.toolArgRepairs` and `model_tool_loop.tool_args_repaired`.

**Verification:**
```bash
node scripts/tool-call-parse-smoke.mjs
npm run test:omni-loop
```

**Status:** Implemented after user called out “model konsa bhi ho harness chalni chahiye”, then extended with schema/arg self-repair after “karo”.

### Task P0.3: Keep segmented safe-tool parallelism regression protected

**Objective:** Preserve the previous improvement where `[read_file, list_files, write_file]` runs reads/listing concurrently, then write sequentially.

**Files:**
- Existing test: `scripts/omni-loop-smoke.mjs` Scenario 1b
- Existing code: `src/core/omni-loop.js`

**Verification:**
```bash
npm run test:omni-loop
```

**Status:** Covered by smoke test.

### Task P0.4: Harness-owned pre/post tool hooks and permission gate

**Objective:** Claude Code/OpenClaw style lifecycle control: every OmniLoop tool attempt must pass through deterministic `before_tool_call` and `after_tool_call` hooks outside the model. Hooks can inspect, normalize, block, audit, or attach policy/sandbox decisions before the tool runtime runs.

**Files:**
- Modify: `src/core/omni-loop.js`
- Test: `scripts/omni-loop-smoke.mjs` Scenario 1d

**Behavior:**
- `before_tool_call` receives `{ runId, sessionId, agentId, round, tool, input, source }`.
- Hook result can mutate input via `{ input }`, `{ toolInput }`, or `{ args }`.
- Hook result can block via `{ blocked: true }`, `{ allow: false }`, `{ allowed: false }`, `{ decision: "deny" }`, or `{ action: "block" }`.
- Blocked calls do **not** reach `runtime.tools.run`.
- `after_tool_call` observes both real tool outputs and hook-blocked outputs.
- Telemetry: `report.hookToolBlocks`, `report.hookToolMutations`, `report.hookErrors`, plus gateway events `model_tool_loop.tool_blocked_by_hook`, `model_tool_loop.tool_input_mutated_by_hook`, `model_tool_loop.hook_error`.

**Verification:**
```bash
npm run test:omni-loop
```

**Status:** Implemented after harness-definition note: permissions/logging/hooks belong to OmniClaw harness, not to the rented model.

---

## P1 — Make OmniClaw Robust Like Hermes

### Task P1.1: Toolset/requirements registry

**Objective:** Add Hermes-style toolset metadata: each tool declares requirements, side-effect level, default enabled platforms, and requirement-check status.

**Files:**
- Modify: `src/core/tool-registry.js`
- Modify: UI settings files for tool display
- Add: `scripts/tool-requirements-smoke.mjs`

**Verification:**
```bash
node scripts/tool-requirements-smoke.mjs
npm run build
```

### Task P1.2: Session search / recall

**Objective:** Add fast searchable session recall so OmniClaw can answer “where did we leave this?” without asking the user to repeat.

**Files:**
- Modify/Create: session store/search module under `src/core/`
- Add tool: `session_search`
- Add smoke: `scripts/session-search-smoke.mjs`

**Verification:**
```bash
node scripts/session-search-smoke.mjs
```

### Task P1.3: Skill learning and curation

**Objective:** After a complex verified workflow, allow OmniClaw to suggest/create a skill; track usage and stale skills.

**Files:**
- Modify: `src/core/skill-registry.js`
- Modify: memory/progress tools if needed
- Add smoke: `scripts/skill-curation-smoke.mjs`

**Verification:**
```bash
node scripts/skill-curation-smoke.mjs
npm run test:omni-loop
```

### Task P1.4: Subagent-driven development contract

**Objective:** Upgrade `SubAgentSpawner` from “spawn a worker” to Hermes-style delegated task flow: explicit task context, allowed toolsets, result handle, parent-side verification, and optional reviewer model.

**Files:**
- Modify: `src/core/sub-agent-spawner.js`
- Modify: tool registry delegate/subagent tools
- Add smoke: `scripts/subagent-contract-smoke.mjs`

**Verification:**
```bash
node scripts/subagent-contract-smoke.mjs
npm run build
```

### Task P1.5: Checkpoint/rollback around risky edits

**Objective:** Auto-create a checkpoint before multi-file/risky edits and expose a clean rollback path.

**Files:**
- Modify: `src/core/autonomous-checkpoint-store.js`
- Modify: `src/core/omni-loop.js` or tool execution wrapper
- Add smoke: `scripts/checkpoint-rollback-smoke.mjs`

**Verification:**
```bash
node scripts/checkpoint-rollback-smoke.mjs
```

---

## P2 — Gateway, Cron, Media, UX Parity

### Task P2.1: Hermes-style recurring jobs

**Objective:** Turn schedules into self-contained recurring agent jobs with clear delivery semantics and run history.

**Files:**
- Modify: `src/core/scheduler.js`
- Modify: `src/core/schedule-store.js`
- Add smoke: `scripts/scheduler-agent-job-smoke.mjs`

**Verification:**
```bash
node scripts/scheduler-agent-job-smoke.mjs
```

### Task P2.2: Gateway channel parity

**Objective:** Make gateway sessions robust across web/Telegram/Discord/webhooks with routing, approvals, restart/status, and logs.

**Files:**
- Modify: `src/core/ws-gateway.js`
- Modify: connector worker files
- Add smoke(s): gateway protocol/connector tests

**Verification:**
```bash
npm run build
node scripts/health-smoke.mjs
```

### Task P2.3: UI/browser verification hardening

**Objective:** For UI work, require browser open/screenshot/console check before done.

**Files:**
- Modify: `src/core/omni-loop.js`
- Modify browser tools if needed
- Add smoke: browser verification scenario

**Verification:**
```bash
npm run test:omni-loop
npm run build
```

---

## Definition of Done for Hermes-Grade Changes

Every behavior change must include:

1. Failing smoke/test first.
2. Minimal production code.
3. Green targeted test.
4. Syntax check for touched JS/MJS files.
5. Broader build/test pass.
6. Portable gateway health smoke before release packaging when core loop/gateway files are touched.

---

## Current Work Block Evidence

Implemented P0.1 now:

- Added Scenario 1a in `scripts/omni-loop-smoke.mjs`.
- Confirmed RED: `npm run test:omni-loop` failed because `actionNudges` was undefined and no tool ran.
- Added `isActionableToolTask(...)`, `runtime.omniLoop.enforceToolUse`, `report.actionNudges`, and bounded action nudge logic in `src/core/omni-loop.js`.
- Confirmed GREEN: `npm run test:omni-loop` passed.
