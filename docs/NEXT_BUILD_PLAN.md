# OmniClaw Next Build Plan

This plan is aligned with the deeper OpenClaw research from April 23, 2026.

The goal is not to copy only the visible chat UI. The goal is to copy the real product bones in the right order, then make OmniClaw lighter and stronger.

## Current baseline

Already present in OmniClaw:

- local web UI shell
- gateway process
- WebSocket event flow
- transcript-backed session store
- session detail view
- per-session queued run serialization
- recent run inspection
- plugin manifest discovery
- plugin-declared tools
- plugin-owned config schema
- plugin lifecycle refresh events
- plugin detail and config validation surface
- persistent background jobs
- worker events through gateway
- scheduler-backed recurring jobs
- pairing request and device trust store
- WebSocket token handshake
- dashboard Trust controls
- WebSocket per-RPC scope enforcement
- dashboard one-click copy affordance for newly rotated gateway tokens
- provider context compaction baseline
- approved shell execution baseline
- shell execution governance and audit baseline
- dashboard shell policy editor
- memory promotion and dream sweep baseline
- webhook and file-drop connector baseline
- connector token gates and dashboard security controls
- connector routing and processed-file archive policy
- connector adapter manifest framework
- Telegram polling worker skeleton
- Discord gateway worker skeleton
- unified adapter delivery ledger
- adapter retry outbox and delivery filters
- Telegram/Discord attachment metadata intake
- Discord reconnect/resume backoff loop
- Telegram/Discord attachment download cache
- text-like attachment content extraction
- attachment extract session injection and memory candidates
- automatic attachment ingestion policy with safe cache/extract defaults
- media metadata extraction hooks for image/audio/video/PDF attachments
- media analysis provider layer with `mock`, `http-json`, and `local-command` adapters
- dashboard media analysis presets for mock, local Tesseract OCR, local Whisper CLI, custom local command, and HTTP JSON services
- media-specific analysis routes for image, audio, video, and PDF attachments
- media provider availability test endpoint and dashboard action
- local media engine setup helper for Tesseract, Whisper, FFmpeg, Python, and `pdftotext`
- dashboard action to apply detected media route templates for operator review
- advisory installer-plan workflow for missing local media engines, with risk labels and no auto-run behavior
- attachment cache retention and cleanup policy
- scheduled attachment cleanup tool and dashboard shortcut

Useful, but still not enough for a real OpenClaw-style clone.

## Priority order

## Completed now

- session backbone hardening
- queueing and run control baseline
- plugin-owned config and manifest-first plugin lifecycle
- multi-agent routing baseline
- scheduler and session orchestration baseline
- pairing and trust gates baseline
- WebSocket RPC scope enforcement
- context engine and compaction baseline
- approved shell execution baseline
- shell execution governance and audit baseline
- dashboard shell policy editor and execution detail polish
- memory and dreaming baseline
- channel connectors baseline
- connector auth and enable/disable controls
- connector default routing and file-drop archive policy
- adapter manifests for HTTP webhook, file-drop, Telegram, and Discord
- Telegram polling worker skeleton
- Discord gateway worker skeleton
- unified adapter delivery ledger
- adapter retry outbox and delivery filters
- Telegram/Discord attachment metadata intake
- Discord reconnect/resume backoff loop
- Telegram/Discord attachment download cache
- text-like attachment content extraction
- attachment extract session injection and memory candidates
- automatic attachment ingestion policy with manual dashboard run/retry controls
- media metadata extraction hooks for future OCR/transcription providers
- provider-backed media analysis for OCR/transcription service integration
- local-command media analysis for installed OCR/transcription CLIs without shell interpolation
- dashboard presets for Tesseract, Whisper, mock, custom command, and HTTP JSON media providers
- per-media provider routing for image OCR, audio/video transcription, and PDF analysis
- media provider test checks for mock, HTTP JSON configuration, and local command availability
- local engine setup check with recommended media route generation
- dashboard detected-route apply flow that never installs packages automatically
- installer-plan endpoint and dashboard button that generate commands without executing them
- attachment cache retention cleanup with dashboard control
- scheduled `cleanup_attachment_cache` maintenance via Jobs/Scheduler

## Priority 3. Multi-agent routing follow-through

Status now:

Baseline is now in place:

- per-agent profiles
- per-agent tool restrictions
- per-agent memory, tasks, and skills
- agent workspaces
- dashboard agent switcher
- routed jobs and skill creation

Still worth strengthening later:

- cross-agent handoff rules
- agent-specific connector routing
- workspace-scoped file execution roots
- richer agent detail and transfer controls

## Priority 4. Scheduler and session orchestration follow-through

Status now:

Baseline is now in place:

- schedule store in `data/schedules.json`
- recurring tool schedules
- run-now schedule trigger
- schedule pause/resume/delete
- retry policy on jobs
- queued/running job cancellation state
- dashboard scheduler controls
- selected job detail view

Still worth strengthening later:

- cron-like weekly schedules
- scheduled chat/session runs
- job timeout enforcement
- richer retry backoff policies
- schedule audit detail view

## Priority 5. Pairing and trust gates

Status now:

Baseline is now in place:

- operator connect handshake state
- device identity storage
- pairing approval flow
- node pairing request model
- reconnect token flow
- dashboard token rotation/revoke controls
- one-click token copy affordance for newly rotated gateway tokens
- trust audit timeline with derived history for existing devices and pairing requests

Still worth strengthening later:

- signed native node identities
- dashboard auth before non-local exposure

## Priority 6. Context engine and compaction

Status now:

Baseline is now in place:

- context breakdown reporting
- compaction reports on each run
- profile-based context budgets
- redaction of secret-looking fields
- tool-result pruning rules
- compacted provider payloads

Still worth strengthening later:

- persisted conversation summaries
- dashboard context detail view
- configurable section budgets
- injected workspace/bootstrap files in runtime context
- future context-engine slot support

## Priority 7. Channel connectors

Status now:

Baseline is now in place:

- local WebChat connector
- webhook connector
- file-drop connector
- connector dashboard panel
- schedulable file-drop scan tool
- webhook token rotation
- optional webhook token requirement
- connector enable/disable controls
- rejected webhook delivery audit
- webhook default agent route
- optional webhook payload route override
- file-drop default agent route
- optional processed-file archive move into `data/inbox/archive`
- adapter manifest discovery from `connectors/adapters/*/adapter.json`
- adapter config state in `data/connectors.json`
- adapter enable/disable, route, mode, and secret readiness controls
- dashboard adapter cards and manifest tests
- Telegram polling worker start/stop/status
- Telegram one-shot poll and dry-run update processing
- Telegram update offset tracking
- Telegram plain-text reply path
- Discord gateway worker start/stop/status
- Discord dry-run `MESSAGE_CREATE` dispatch processing
- Discord Gateway v10 WebSocket connect/identify/heartbeat skeleton
- Discord plain-text reply path
- persistent Telegram/Discord adapter delivery records
- dashboard adapter delivery history
- failed Telegram/Discord reply outbox records
- manual retry controls for failed adapter replies
- dashboard adapter history filters by adapter, status, and search text
- Telegram media/file metadata captured in prompts and delivery records
- Discord attachment/embed/sticker metadata captured in prompts and delivery records
- Discord reconnect scheduling with exponential backoff
- Discord Resume (`op: 6`) path when session id and sequence are available
- safe local attachment cache under `data/attachments`
- manual cache controls for adapter deliveries
- cache records with local path, byte length, MIME type, and SHA-256
- extraction records for cached text/json/markdown/csv/html/code files
- dashboard attachment extract history and extract actions
- extracted attachment content can be injected into a normal `attachment-extract` session
- injected attachment content creates memory promotion candidates
- Telegram/Discord deliveries can automatically cache and extract attachments
- automatic session injection remains opt-in through policy or manual operator action
- image/audio/video/PDF attachments create metadata records instead of dead-end unsupported records
- media attachments can be analyzed manually, automatically during ingestion, or as scheduled/batch jobs
- media analysis can use offline mocks, external HTTP JSON services, or local command-line tools such as Tesseract/Whisper when installed
- media analysis can resolve provider routes by attachment kind before running analysis
- operators can test the resolved media provider from the dashboard before running a real attachment analysis
- operators can check local OCR/transcription dependencies and apply detected route templates without leaving the Connectors panel
- operators can generate reviewed install plans for missing local engines without OmniClaw mutating the laptop
- attachment cache cleanup can purge old/oversized files while preserving ledger history
- attachment cleanup can run manually, as a queued job, or as a daily schedule

Still worth strengthening later:

- Discord shard/session-start-limit handling
- optional approval-backed installer execution for reviewed local engine plans
- richer preset docs for scanned PDF OCR workflows
- richer cleanup retention presets and per-adapter retention rules
- per-connector HMAC signatures
- richer per-connector matching rules
- automatic retry backoff for adapter outbox
- archive retention cleanup policy
- later Telegram/Discord style connectors

## Priority 8. Real execution and approvals

Status now:

Baseline is now in place:

- approved shell-plan execution
- shell execution timeout
- shell output capture and truncation
- destructive pattern blocklist
- command risk labels
- advisory command allowlist policy
- persistent shell audit log
- dashboard execution audit panel
- dashboard shell policy editor
- stdout/stderr detail rendering
- execution events through gateway
- execution result stored on approvals, runs, and session transcript

Still worth strengthening later:

- stronger audit filters
- execution target selection
- streaming output
- richer execution detail view

## Priority 9. Memory and dreaming

Status now:

Baseline is now in place:

- generated `data/MEMORY.md`
- long-term memory promotions
- promotion candidates from notes, conversations, and research
- dream diary
- dashboard memory review panel
- schedulable `dream_memory_sweep` tool

Still worth strengthening later:

- memory archive/delete/edit controls
- model-assisted candidate scoring
- scheduled default dream sweep
- per-agent memory boundaries and transfer controls
- memory conflict detection

## Build rule

Before adding flashy UI or more integrations, check this:

1. Does the feature strengthen the gateway/session backbone?
2. Does it match OpenClaw's actual control-plane architecture?
3. Will it still make sense when multi-agent, jobs, nodes, and memory are all present?

If the answer is no, it is not the next highest-value build.
