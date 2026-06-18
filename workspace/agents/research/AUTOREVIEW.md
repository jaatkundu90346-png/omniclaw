# AUTOREVIEW.md - OmniClaw Autoreview

summary: Automated code-review command behavior, reviewer fallback, modes, and validation policy.

## Purpose

Autoreview is a closeout review helper. It selects a review target, runs a reviewer, optionally runs tests in parallel, and reports accepted/actionable findings.

## Modes

- auto: dirty tree -> local review, branch PR/current branch -> branch review
- local: review uncommitted changes
- branch: review diff against base
- commit: review a commit

## Reviewers

Preferred reviewer is Codex. Fallbacks can include Claude, Pi, OpenCode, Droid, and Copilot when configured.

Fallback reviewers receive a generated diff prompt and must not modify files.

## Output Contract

Accepted findings use:

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

## Review Standard

Report only discrete actionable issues introduced by the change. Prioritize correctness, regressions, security, data loss, performance cliffs, and missing tests that catch a real bug.

Do not report style nits, broad rewrites, speculative risks, changelog gaps, or pre-existing issues.

## Validation

Autoreview may run tests in parallel when configured. For special maintainer validation paths, avoid local memory-heavy validation and route proof to the configured remote/testbox path.

## Agent Rule

Do not claim autoreview ran unless a real review command/tool ran. If only this manual is present, explain the intended command behavior and what backend tool is needed.
