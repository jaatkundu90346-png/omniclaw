# Channel Connectors

OmniClaw now has a first-pass channel connector layer.

## What exists

- Connector state is stored in `data/connectors.json`.
- Connector adapter manifests are stored in `connectors/adapters/*/adapter.json`.
- Cached adapter attachments are stored under `data/attachments`.
- Extracted attachment text is tracked in connector state for later session and memory injection.
- File-drop inbox is created at `data/inbox`.
- Webhook intake can create normal OmniClaw sessions through the gateway.
- Webhook intake has a configurable default agent route.
- Webhook payloads can optionally be allowed to override the default route.
- Webhook intake can be enabled/disabled and protected by a connector token.
- Webhook tokens are stored as SHA-256 hashes and only shown once after rotation.
- File-drop scanning can be enabled/disabled from the dashboard.
- File-drop scanning has a configurable default agent route.
- File-drop can optionally archive processed files into `data/inbox/archive`.
- File-drop scanner reads new `.txt`, `.md`, and `.json` files from `data/inbox`.
- File drops are deduplicated by filename and content hash.
- Connector deliveries are tracked with run/session summaries.
- Telegram and Discord adapter deliveries are tracked in a unified persistent ledger.
- Telegram media/file metadata and Discord attachment/embed/sticker metadata are captured in delivery records.
- Telegram files and Discord attachments can be cached locally with byte limits and SHA-256 hashes.
- Cached text-like attachments can be extracted into searchable previews and extracted text records.
- Extracted attachment content can be sent into a normal OmniClaw session and stored as a memory promotion candidate.
- Telegram and Discord attachment deliveries can run an automatic ingestion policy: cache, extract, and optionally inject into a session.
- Image, audio, video, and PDF attachments create media metadata extraction records so OCR/transcription providers can plug in cleanly later.
- Media analysis can now run through provider adapters: built-in `mock` for offline testing, `http-json` for external OCR/transcription services, and `local-command` for local OCR/transcription CLIs.
- Attachment cache retention can purge old/oversized cached files while keeping traceable delivery/extract ledger records.
- Attachment cleanup is available as the `cleanup_attachment_cache` scheduler/job tool for recurring maintenance.
- Failed Telegram and Discord reply sends are stored in a retryable adapter outbox.
- Adapter framework discovers built-in manifests for:
  - HTTP Webhook
  - File Drop
  - Telegram Bot
  - Discord Bot
- Telegram has a polling worker skeleton with start, stop, one-shot poll, offset tracking, media metadata intake, and reply support.
- Discord has a gateway worker skeleton with start, stop, status, dry-run dispatch, reconnect/resume handling, and a real WebSocket connect path.
- Connector secrets are stored in `data/secrets.json`; connector public state only exposes masked previews.
- Dashboard Connectors panel supports:
  - connector security policy controls
  - connector routing controls
  - adapter enable/disable, route, mode, and secret readiness controls
  - adapter manifest tests
  - Telegram poll/start/stop controls
  - Discord dry-run/start/stop controls
  - Telegram/Discord adapter delivery history
  - attachment metadata summaries on adapter deliveries
  - manual attachment cache controls and cache history
  - manual attachment text extraction controls and extract history
  - manual attachment-to-session injection controls and injection history
  - automatic attachment ingestion policy controls and manual run/retry buttons
  - attachment retention controls and manual cache cleanup
  - media analysis provider controls and manual media analysis buttons
  - media analysis presets for mock, local Tesseract OCR, local Whisper CLI, local command, and HTTP JSON services
  - attachment media analysis history
  - one-click daily attachment cleanup schedule creation
  - attachment cleanup run history
  - adapter delivery filters and retry outbox controls
  - webhook token rotation
  - processed-file archive policy
  - webhook test messages
  - file-drop inbox scans
  - pending file preview
  - webhook delivery history
  - processed file-drop history

## API

- `GET /api/connectors`
- `GET /api/connectors/adapters`
- `POST /api/connectors/adapters/config`
- `POST /api/connectors/adapters/test`
- `POST /api/connectors/adapters/retry`
- `POST /api/connectors/adapters/attachments/cache`
- `POST /api/connectors/adapters/attachments/extract`
- `POST /api/connectors/adapters/attachments/inject`
- `POST /api/connectors/adapters/attachments/analyze`
- `POST /api/connectors/adapters/attachments/analyze-pending`
- `POST /api/connectors/adapters/attachments/media-provider/test`
- `GET /api/connectors/adapters/attachments/media-provider/setup`
- `POST /api/connectors/adapters/attachments/media-provider/install-plan`
- `POST /api/connectors/adapters/attachments/ingest`
- `POST /api/connectors/adapters/attachments/cleanup`
- `GET /api/connectors/telegram/status`
- `POST /api/connectors/telegram/start`
- `POST /api/connectors/telegram/stop`
- `POST /api/connectors/telegram/poll`
- `GET /api/connectors/discord/status`
- `POST /api/connectors/discord/start`
- `POST /api/connectors/discord/stop`
- `POST /api/connectors/discord/dispatch`
- `POST /api/connectors/config`
- `POST /api/connectors/webhook/token/rotate`
- `POST /api/connectors/webhook`
- `POST /api/connectors/file-drop/scan`

Connector policy payload:

```json
{
  "webhook": {
    "enabled": true,
    "defaultAgentId": "main",
    "allowPayloadAgent": false,
    "requireToken": true
  },
  "fileDrop": {
    "enabled": true,
    "defaultAgentId": "ops",
    "archiveProcessed": true
  },
  "attachmentIngestion": {
    "enabled": true,
    "autoCache": true,
    "autoExtract": true,
    "autoInject": false,
    "maxAttachmentsPerDelivery": 3,
    "maxCacheBytes": 5000000
  },
  "attachmentRetention": {
    "enabled": true,
    "maxAgeDays": 14,
    "failedMaxAgeDays": 3,
    "maxTotalBytes": 100000000,
    "deleteOrphanFiles": true
  },
  "attachmentMediaAnalysis": {
    "enabled": false,
    "autoAnalyze": false,
    "provider": "mock",
    "endpoint": "",
    "command": "",
    "args": [],
    "model": "",
    "apiKey": "optional-write-only",
    "routes": {
      "image": { "enabled": false },
      "audio": { "enabled": false },
      "video": { "enabled": false },
      "pdf": { "enabled": false }
    }
  }
}
```

Webhook payload:

```json
{
  "message": "hello from webhook",
  "label": "external-system",
  "agentId": "optional-payload-route",
  "token": "omni_webhook_..."
}
```

If `allowPayloadAgent` is disabled, webhook payload `agentId` is ignored and the connector's configured `defaultAgentId` is used.

Webhook tokens can also be sent as `x-omniclaw-token`, `x-connector-token`, `Authorization: Bearer <token>`, or `?token=...`.

File-drop scan payload:

```json
{
  "agentId": "main",
  "limit": 10
}
```

Adapter config payload:

```json
{
  "adapterId": "telegram",
  "enabled": true,
  "defaultAgentId": "main",
  "mode": "polling",
  "secret": "telegram-or-discord-bot-token"
}
```

Secrets are stored in the local secret store with hashes and masked previews in connector state. The raw value is not returned by the API.

`GET /api/connectors` includes latest `adapterDeliveries`, `adapterOutbox`, `adapterAttachmentCache`, `adapterAttachmentExtracts`, `adapterAttachmentInjections`, `overview.adapterDeliveries`, `overview.adapterAttachments`, `overview.adapterAttachmentCache`, `overview.adapterAttachmentCacheBytes`, `overview.adapterAttachmentExtracts`, `overview.adapterAttachmentExtractCharacters`, `overview.adapterAttachmentInjections`, `overview.adapterOutboxPending`, and compact run/session summaries for Telegram and Discord deliveries.

Adapter delivery history accepts optional `adapterId`, `adapterStatus`, `adapterQuery`, `adapterLimit`, `outboxStatus`, and `outboxLimit` query params.

Adapter retry payload:

```json
{
  "outboxId": "outbox_..."
}
```

Retry currently supports Telegram and Discord plain-text replies.

Adapter attachment cache payload:

```json
{
  "deliveryId": "adapter_...",
  "attachmentIndex": 0,
  "maxBytes": 5000000
}
```

Telegram cache uses Bot API `getFile`, then downloads from the Telegram file endpoint. Discord cache downloads from the attachment URL already present in the Gateway message payload. Cache records include status, local relative path, byte length, MIME type, and SHA-256.

Adapter attachment extract payload:

```json
{
  "cacheId": "cache_...",
  "maxBytes": 1000000,
  "maxChars": 12000
}
```

Extraction supports text-like files such as `.txt`, `.md`, `.json`, `.csv`, `.html`, `.xml`, `.js`, `.ts`, `.css`, `.yaml`, and `text/*` MIME types. JSON is pretty-printed and HTML is stripped to text. Image/audio/video/PDF files now produce `media-metadata` records with dimensions, duration, MIME type, byte count, hash, and an OCR/transcription pending note. Other unsupported binary formats produce a metadata-only extract record rather than crashing.

Adapter media analysis payload:

```json
{
  "extractId": "extract_...",
  "force": true,
  "policy": {
      "enabled": true,
      "provider": "http-json",
      "endpoint": "https://example.com/analyze",
      "model": "ocr-large",
    "maxInputBytes": 5000000,
    "maxOutputChars": 12000,
    "timeoutMs": 30000
  }
}
```

Local command media analysis payload:

```json
{
  "extractId": "extract_...",
  "force": true,
  "policy": {
    "enabled": true,
    "provider": "local-command",
    "command": "tesseract",
    "args": ["{file}", "stdout", "-l", "eng"],
    "model": "tesseract",
    "maxInputBytes": 5000000,
    "maxOutputChars": 12000,
    "timeoutMs": 30000
  }
}
```

`provider=mock` works offline and returns deterministic searchable text for testing. `provider=http-json` sends a JSON payload containing media metadata plus `contentBase64` to the configured endpoint. The endpoint can return plain text or JSON with `text`, `output`, `ocrText`, `transcription`, `caption`, `result.text`, or OpenAI-style `choices[0].message.content`. The optional API key is stored in the local secret store under `media-analysis/apiKey` and sent as `Authorization: Bearer <key>`.

`provider=local-command` runs a configured local executable without shell interpolation and captures stdout/stderr as analysis text. Command args can use placeholders: `{file}`, `{mediaKind}`, `{mimeType}`, `{name}`, `{model}`, `{prompt}`, and `{sha256}`. The dashboard presets only fill the fields; the matching CLI must already be installed and available on PATH or configured with an absolute executable path.

Per-media provider routes can override the base provider for `image`, `audio`, `video`, and `pdf` attachments:

```json
{
  "policy": {
    "enabled": true,
    "provider": "mock",
    "routes": {
      "image": {
        "enabled": true,
        "provider": "local-command",
        "command": "tesseract",
        "args": ["{file}", "stdout", "-l", "eng"],
        "model": "tesseract"
      },
      "audio": {
        "enabled": true,
        "provider": "local-command",
        "command": "whisper",
        "args": ["{file}", "--model", "base", "--task", "transcribe", "--fp16", "False"],
        "model": "whisper-base"
      }
    }
  }
}
```

Media provider test payload:

```json
{
  "mediaKind": "image",
  "policy": {
    "enabled": true,
    "provider": "local-command",
    "command": "tesseract",
    "args": ["{file}", "stdout"],
    "routes": {
      "image": {
        "enabled": true,
        "provider": "local-command",
        "command": "tesseract"
      }
    }
  },
  "testArgs": ["--version"]
}
```

The test endpoint does not analyze a file. It resolves the same base policy plus media route that real analysis would use, then reports whether `mock` is ready, `http-json` has an endpoint, or `local-command` can start the configured executable.

Local media setup helper:

```json
{
  "checkedAt": "2026-04-25T00:00:00.000Z",
  "platform": "win32",
  "readyCount": 1,
  "missingCount": 4,
  "engines": [
    {
      "id": "tesseract",
      "name": "Tesseract OCR",
      "command": "tesseract",
      "status": "missing",
      "mediaKinds": ["image"],
      "setupSteps": ["Install Tesseract OCR and make sure tesseract is available on PATH."]
    }
  ],
  "recommendedRoutes": {
    "image": { "enabled": false },
    "audio": { "enabled": false },
    "video": { "enabled": false },
    "pdf": { "enabled": false }
  }
}
```

`GET /api/connectors/adapters/attachments/media-provider/setup` probes known local engines without installing anything: Tesseract OCR, Whisper CLI, FFmpeg, Python, and `pdftotext`. The dashboard can apply detected route templates into the media routes JSON, but the operator still reviews and saves the policy explicitly.

Installer plan payload:

```json
{
  "engineIds": ["tesseract", "ffmpeg"],
  "includeAvailable": false,
  "platform": "win32"
}
```

Installer plan response:

```json
{
  "executesAutomatically": false,
  "requiresApproval": true,
  "targetCount": 2,
  "commandCount": 4,
  "targets": [
    {
      "id": "tesseract",
      "status": "missing",
      "steps": [
        {
          "title": "Find a Tesseract package",
          "displayCommand": "winget search tesseract",
          "risk": "low",
          "requiresApproval": true,
          "executesAutomatically": false
        }
      ]
    }
  ]
}
```

Installer plans are advisory only. OmniClaw returns commands, risk labels, and notes, but never executes package installs from this endpoint.

Pending media analysis batch payload:

```json
{
  "limit": 5,
  "policy": {
    "enabled": true,
    "provider": "mock"
  }
}
```

The scheduler/job tools are:

- `analyze_attachment_media`
- `analyze_pending_media_attachments`
- `cleanup_attachment_cache`

Adapter attachment session injection payload:

```json
{
  "extractId": "extract_...",
  "agentId": "main",
  "sessionId": "optional-existing-session",
  "maxChars": 12000
}
```

Injection sends the extracted content through the normal session/run pipeline on the `attachment-extract` channel, records an injection ledger item, and adds an `attachment-extract` memory promotion candidate. This keeps file content traceable from adapter delivery -> cache -> extract -> session -> memory.

Adapter attachment ingestion payload:

```json
{
  "deliveryId": "adapter_...",
  "force": true,
  "policy": {
    "autoInject": false,
    "maxAttachmentsPerDelivery": 3,
    "maxCacheBytes": 5000000
  }
}
```

Automatic ingestion runs from Telegram/Discord workers whenever an incoming delivery has attachments and the connector policy is enabled. The safe default caches and extracts text-like files but does not send extracted content into a session until `autoInject` is explicitly enabled or a dashboard operator presses the manual session injection button.

Adapter attachment cleanup payload:

```json
{
  "dryRun": false,
  "policy": {
    "enabled": true,
    "maxAgeDays": 14,
    "failedMaxAgeDays": 3,
    "maxTotalBytes": 100000000,
    "deleteOrphanFiles": true
  }
}
```

Cleanup only deletes files under `data/attachments`. The cache ledger is retained and records are marked `purged` with a purge reason. Extracts and session-injection ledgers remain available for audit/history.

Scheduled cleanup:

```json
{
  "tool": "cleanup_attachment_cache",
  "intervalSeconds": 86400,
  "input": {
    "dryRun": false,
    "policy": {
      "enabled": true,
      "maxAgeDays": 14,
      "failedMaxAgeDays": 3,
      "maxTotalBytes": 100000000,
      "deleteOrphanFiles": true
    }
  }
}
```

The dashboard's `Schedule daily cleanup` button creates this recurring schedule through the normal scheduler, so it shows up in Jobs/Schedules and emits the same gateway events as other background work.

Telegram one-shot poll payload:

```json
{
  "limit": 10,
  "timeoutSeconds": 1
}
```

Telegram dry-run payload:

```json
{
  "mockUpdates": [
    {
      "update_id": 1001,
      "message": {
        "message_id": 1,
        "chat": { "id": 123, "type": "private" },
        "from": { "first_name": "Test" },
        "text": "hello OmniClaw",
        "photo": [
          {
            "file_id": "telegram-file-id",
            "file_unique_id": "unique-id",
            "width": 1024,
            "height": 768,
            "file_size": 123456
          }
        ]
      }
    }
  ],
  "reply": false
}
```

The worker follows Telegram Bot API long-polling semantics: `getUpdates` accepts `offset`, `limit`, `timeout`, and `allowed_updates`, and updates are confirmed by calling `getUpdates` with an offset higher than the processed `update_id`.

Discord dry-run dispatch payload:

```json
{
  "mockEvents": [
    {
      "op": 0,
      "t": "MESSAGE_CREATE",
      "s": 101,
      "d": {
        "id": "message-id",
        "channel_id": "channel-id",
        "guild_id": "guild-id",
        "author": { "username": "tester", "bot": false },
        "content": "hello OmniClaw",
        "attachments": [
          {
            "id": "attachment-id",
            "filename": "screenshot.png",
            "content_type": "image/png",
            "size": 123456,
            "width": 1280,
            "height": 720,
            "url": "https://cdn.discordapp.com/..."
          }
        ]
      }
    }
  ],
  "reply": false
}
```

Discord live start payload:

```json
{
  "connectNow": true
}
```

Discord Gateway notes:

- The worker uses Discord Gateway v10 JSON payloads.
- `MESSAGE_CREATE` dispatches are routed into OmniClaw sessions.
- Gateway close/reconnect requests schedule exponential reconnect attempts.
- When a session id and sequence are available, reconnect attempts send Discord Resume (`op: 6`) after Hello.
- The identify payload requests `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, and `MESSAGE_CONTENT` intents.
- Message content requires enabling the Message Content privileged intent in the Discord Developer Portal for many bots.

## WebSocket RPC

- `connectors.overview`
- `connectors.adapters`
- `connectors.updateAdapter`
- `connectors.testAdapter`
- `connectors.retryAdapterOutbox`
- `connectors.cacheAdapterAttachment`
- `connectors.extractAdapterAttachment`
- `connectors.injectAdapterAttachment`
- `connectors.analyzeAdapterAttachment`
- `connectors.analyzePendingAdapterAttachments`
- `connectors.testMediaProvider`
- `connectors.mediaProviderSetup`
- `connectors.mediaProviderInstallPlan`
- `connectors.ingestAdapterAttachments`
- `connectors.cleanupAdapterAttachments`
- `connectors.telegramStatus`
- `connectors.telegramStart`
- `connectors.telegramStop`
- `connectors.telegramPoll`
- `connectors.discordStatus`
- `connectors.discordStart`
- `connectors.discordStop`
- `connectors.discordDispatch`
- `connectors.webhook`
- `connectors.updateConfig`
- `connectors.rotateWebhookToken`
- `connectors.scanFileDrop`

## Tool

- `scan_file_drop`

Because `scan_file_drop` is a tool, it can be scheduled from the Scheduler panel.

## Current limits

- File-drop scanning reads top-level inbox files only.
- Processed files are marked processed by hash; optional archive mode moves them after processing.
- Binary files are intentionally ignored.
- Telegram media/file metadata is parsed, files can be cached manually, text-like cached files can be extracted, and media can be analyzed with mock, HTTP JSON, or local-command providers.
- Telegram worker sends plain text replies only.
- Telegram failed reply sends can be retried from the adapter outbox.
- Discord attachment/embed/sticker metadata is parsed, URL-backed attachments can be cached manually, text-like cached files can be extracted, and media can be analyzed with mock, HTTP JSON, or local-command providers.
- Discord worker sends plain text replies only.
- Discord failed reply sends can be retried from the adapter outbox.
- Discord reconnect/resume now has a backoff loop, but shard/session-start-limit strategy is not implemented yet.

## Next hardening

- Add per-connector HMAC signatures.
- Add richer install guidance and preset validation for local OCR/transcription CLIs.
- Add bundled local OCR/transcription setup helpers.
- Add Discord shard/session-start-limit handling.
- Add richer per-connector matching rules.
- Add archive retention cleanup policy.
- Add Telegram/Discord style connectors.
- Add streaming connector events and retry policies.
