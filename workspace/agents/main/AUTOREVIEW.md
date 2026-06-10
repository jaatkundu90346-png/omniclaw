# AUTOREVIEW.md - OmniClaw Main Agent Autoreview

summary: Automated code-review command behavior, reviewer fallback, modes, and validation policy.

Autoreview is a closeout review helper. It should inspect a selected target and report only actionable issues introduced by the change.

## Modes

- auto: dirty tree -> local, branch/PR -> branch
- local: uncommitted changes
- branch: diff against base
- commit: single commit

## Reviewer Path

Prefer Codex review. Fallback reviewers may include Claude, Pi, OpenCode, Droid, and Copilot. Fallback prompt reviewers must not modify files.

## Findings

```text
[P<0-3>] Short title
File: path:line
Why: one sentence
Fix: one sentence
```

Clean result:

```text
autoreview clean: no accepted/actionable findings reported
```

## Standard

Prioritize correctness, regressions, security, data loss, performance cliffs, and missing tests. Avoid style nits, speculative risks, broad rewrites, changelog gaps, and pre-existing issues.
