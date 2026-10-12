# Scheduler and Job Orchestration

OmniClaw now has a scheduler baseline layered on the existing agent-routed job worker.

## What exists

- `ScheduleStore` persists schedules in `data/schedules.json`.
- `Scheduler` polls active schedules and enqueues due tool jobs.
- Scheduled jobs keep `scheduleId`, `agentId`, retry policy, and source metadata in the job payload.
- Jobs support delayed queueing through `scheduledFor`.
- Queued jobs can be cancelled; running jobs record a cancel request and finish as cancelled after execution returns.
- Failed jobs requeue when retry attempts remain.
- HTTP and WebSocket surfaces expose schedule list/create/run/toggle/delete and job cancel operations.

## Current API shape

- `GET /api/schedules`
- `POST /api/schedules`
- `POST /api/schedules/run`
- `POST /api/schedules/toggle`
- `POST /api/schedules/delete`
- `POST /api/jobs/cancel`

## Next hardening

- Add calendar/weekly schedule expressions.
- Add scheduled chat/session runs, not only tool jobs.
- Add job timeout enforcement.
- Add schedule audit/detail views.
- Add exponential retry backoff.
