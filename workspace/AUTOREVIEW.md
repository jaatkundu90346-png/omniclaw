# AUTOREVIEW.md - OmniClaw Shared Autoreview

summary: Automated code-review command behavior, reviewer fallback, modes, and validation policy.

Autoreview selects a review target, runs a reviewer, optionally runs tests in parallel, and reports accepted/actionable findings.

## Modes

- auto
- local
- branch
- commit

## Reviewers

Preferred reviewer is Codex. Fallbacks may include Claude, Pi, OpenCode, Droid, and Copilot.

## Finding Format

```text
[P<0-3>] Short title
File: path:line
Why: one sentence
Fix: one sentence
```

If clean:

```text
autoreview clean: no accepted/actionable findings reported
```

Report only actionable issues introduced by the change. Do not report style nits, speculative risks, broad rewrites, or pre-existing issues.
