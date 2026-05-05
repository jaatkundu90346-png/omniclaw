import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MEDIA_ANALYSIS_PROVIDERS = ["mock", "http-json", "local-command"];
const MEDIA_ANALYSIS_ROUTE_KEYS = ["image", "audio", "video", "pdf"];

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createToken(prefix = "omni_connector") {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function hashContent(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function maskToken(value) {
  const token = String(value || "");
  return token ? `${token.slice(0, 10)}...${token.slice(-6)}` : "";
}

function safeEqualHash(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function truncate(value, max = 500) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 18))}...[truncated]`;
}

function summarizeRun(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  return {
    sessionId: result.session?.id || "",
    sessionKey: result.session?.key || "",
    runId: result.run?.id || "",
    runStatus: result.run?.status || "",
    agentId: result.agent?.id || result.session?.agentId || "",
    replyPreview: truncate(result.reply || result.error || "", 280),
    provider: result.provider?.id || "",
  };
}

function normalizeListOptions(input, fallbackLimit = 20) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return {
      limit: Number(input.limit || fallbackLimit),
      adapterId: String(input.adapterId || "").trim(),
      status: String(input.status || "").trim(),
      query: String(input.query || "").trim().toLowerCase(),
    };
  }
  return {
    limit: Number(input || fallbackLimit),
    adapterId: "",
    status: "",
    query: "",
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function matchesText(item, query, fields) {
  if (!query) {
    return true;
  }
  return fields.some((field) => String(item[field] || "").toLowerCase().includes(query));
}

function sanitizeAttachment(input = {}) {
  return {
    type: truncate(input.type || "attachment", 40),
    id: truncate(input.id || input.fileId || "", 120),
    fileUniqueId: truncate(input.fileUniqueId || "", 120),
    name: truncate(input.name || input.fileName || input.filename || "", 180),
    mimeType: truncate(input.mimeType || input.contentType || "", 120),
    size: Number(input.size || input.fileSize || 0),
    width: Number(input.width || 0),
    height: Number(input.height || 0),
    duration: Number(input.duration || 0),
    url: truncate(input.url || "", 500),
  };
}

function summarizeAttachments(attachments = []) {
  return attachments
    .map((item) => {
      const name = item.name ? `:${item.name}` : "";
      const size = item.size ? ` ${item.size}b` : "";
      const shape = item.width && item.height ? ` ${item.width}x${item.height}` : "";
      return `${item.type || "attachment"}${name}${shape}${size}`.trim();
    })
    .join("; ");
}

function safePathSegment(value, fallback = "attachment") {
  const text = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (text || fallback).slice(0, 120);
}

function extensionForAttachment(attachment = {}) {
  const nameExt = path.extname(String(attachment.name || "")).toLowerCase();
  if (nameExt && nameExt.length <= 12) {
    return nameExt;
  }
  const mime = String(attachment.mimeType || "").toLowerCase();
  const mimeMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "text/plain": ".txt",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
  };
  return mimeMap[mime] || ".bin";
}

function maskSourceUrl(value) {
  return truncate(String(value || "").replace(/\/bot[^/]+/g, "/bot..."), 500);
}

function isLikelyTextCache(cache = {}) {
  const mime = String(cache.mimeType || "").toLowerCase();
  const ext = path.extname(String(cache.relativePath || cache.name || "")).toLowerCase();
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/x-yaml",
      "application/yaml",
    ].includes(mime) ||
    [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".html", ".htm", ".xml", ".js", ".ts", ".css", ".yaml", ".yml"].includes(ext)
  );
}

function mediaKindForAttachment(input = {}) {
  const mime = String(input.mimeType || "").toLowerCase();
  const ext = path.extname(String(input.relativePath || input.name || "")).toLowerCase();
  const type = String(input.type || "").toLowerCase();

  if (mime.startsWith("image/") || ["photo", "image"].some((item) => type.includes(item)) || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("audio/") || type.includes("audio") || [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) {
    return "audio";
  }
  if (mime.startsWith("video/") || type.includes("video") || [".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) {
    return "video";
  }
  if (mime === "application/pdf" || ext === ".pdf") {
    return "pdf";
  }
  return "";
}

function mediaAnalysisLabel(kind) {
  if (kind === "image" || kind === "pdf") {
    return "OCR pending";
  }
  if (kind === "audio" || kind === "video") {
    return "transcription pending";
  }
  return "metadata only";
}

function buildMediaMetadataText(cache = {}, stat = {}) {
  const kind = cache.mediaKind || mediaKindForAttachment(cache) || "binary";
  const lines = [
    `Media attachment metadata (${kind})`,
    `Analysis: ${mediaAnalysisLabel(kind)}`,
    `File: ${cache.name || cache.relativePath || cache.id}`,
    `MIME: ${cache.mimeType || "unknown"}`,
    `Bytes: ${cache.byteLength || stat.size || 0}`,
    `SHA-256: ${cache.sha256 || "unknown"}`,
  ];
  if (cache.width || cache.height) {
    lines.push(`Dimensions: ${cache.width || 0}x${cache.height || 0}`);
  }
  if (cache.duration) {
    lines.push(`Duration: ${cache.duration}s`);
  }
  lines.push("Next: attach an OCR/transcription provider to replace this metadata record with extracted text.");
  return lines.join("\n");
}

function normalizeAnalysisText(value, maxChars = 12000) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 18))}...[truncated]`;
}

function pickAnalysisText(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  return (
    payload.text ||
    payload.output ||
    payload.result?.text ||
    payload.result?.output ||
    payload.ocrText ||
    payload.transcription ||
    payload.caption ||
    payload.choices?.[0]?.message?.content ||
    payload.choices?.[0]?.text ||
    ""
  );
}

function mediaAnalysisSecretStatus(secretStore) {
  const status = secretStore?.getConnectorSecretStatus?.("media-analysis", "apiKey") || {};
  return {
    configured: Boolean(status.configured),
    masked: status.masked || "",
  };
}

function normalizeCommandArgs(input = []) {
  if (Array.isArray(input)) {
    return input.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40);
  }
  return String(input || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function formatCommandDisplay(command, args = []) {
  if (command === "manual") {
    return args.join(" ");
  }
  return [command, ...args]
    .filter(Boolean)
    .map((part) => {
      const text = String(part);
      return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    })
    .join(" ");
}

function defaultMediaAnalysisRoutes() {
  return Object.fromEntries(
    MEDIA_ANALYSIS_ROUTE_KEYS.map((key) => [
      key,
      {
        enabled: false,
        provider: "",
        endpoint: "",
        model: "",
        command: "",
        args: [],
        prompt: "",
        maxInputBytes: 0,
        maxOutputChars: 0,
        timeoutMs: 0,
      },
    ]),
  );
}

function localMediaEngineCatalog() {
  return [
    {
      id: "tesseract",
      name: "Tesseract OCR",
      role: "ocr",
      command: "tesseract",
      testArgs: ["--version"],
      mediaKinds: ["image"],
      routeTemplate: {
        enabled: true,
        provider: "local-command",
        command: "tesseract",
        args: ["{file}", "stdout", "-l", "eng"],
        model: "tesseract",
      },
      setupSteps: [
        "Install Tesseract OCR and make sure tesseract is available on PATH.",
        "Restart OmniClaw after PATH changes so the gateway process can see the command.",
      ],
      installPlans: {
        win32: [
          {
            title: "Find a Tesseract package",
            command: "winget",
            args: ["search", "tesseract"],
            risk: "low",
            note: "Shows available Tesseract OCR packages before choosing one.",
          },
          {
            title: "Install Tesseract OCR with winget",
            command: "winget",
            args: ["install", "--id", "UB-Mannheim.TesseractOCR", "-e"],
            risk: "medium",
            note: "Installs the common Windows Tesseract OCR build. Verify the package id with winget search if it fails.",
          },
        ],
        generic: [
          {
            title: "Install Tesseract OCR",
            command: "manual",
            args: ["Install Tesseract OCR for your OS and add it to PATH."],
            risk: "manual",
            note: "Use your OS package manager, then restart OmniClaw.",
          },
        ],
      },
    },
    {
      id: "whisper",
      name: "Whisper CLI",
      role: "transcription",
      command: "whisper",
      testArgs: ["--help"],
      mediaKinds: ["audio", "video"],
      dependencies: ["ffmpeg"],
      routeTemplate: {
        enabled: true,
        provider: "local-command",
        command: "whisper",
        args: ["{file}", "--model", "base", "--task", "transcribe", "--fp16", "False"],
        model: "whisper-base",
        timeoutMs: 120000,
      },
      setupSteps: [
        "Install Python, FFmpeg, and the Whisper CLI, then make sure whisper and ffmpeg are available on PATH.",
        "Use a small model first on low-memory machines; base/tiny are safer than large models.",
      ],
      installPlans: {
        win32: [
          {
            title: "Install Whisper CLI with Python pip",
            command: "python",
            args: ["-m", "pip", "install", "-U", "openai-whisper"],
            risk: "medium",
            note: "Requires Python and internet access. Use tiny/base models on low-memory laptops.",
          },
        ],
        generic: [
          {
            title: "Install Whisper CLI",
            command: "python",
            args: ["-m", "pip", "install", "-U", "openai-whisper"],
            risk: "medium",
            note: "Requires Python, pip, FFmpeg, and internet access.",
          },
        ],
      },
    },
    {
      id: "ffmpeg",
      name: "FFmpeg",
      role: "media-dependency",
      command: "ffmpeg",
      testArgs: ["-version"],
      mediaKinds: ["audio", "video"],
      setupSteps: [
        "Install FFmpeg and make sure ffmpeg is available on PATH.",
        "Whisper-style audio/video transcription usually needs FFmpeg for decoding media files.",
      ],
      installPlans: {
        win32: [
          {
            title: "Find an FFmpeg package",
            command: "winget",
            args: ["search", "ffmpeg"],
            risk: "low",
            note: "Shows FFmpeg packages available through winget.",
          },
          {
            title: "Install FFmpeg with winget",
            command: "winget",
            args: ["install", "--id", "Gyan.FFmpeg", "-e"],
            risk: "medium",
            note: "Installs a common Windows FFmpeg distribution. Verify the package id with winget search if it fails.",
          },
        ],
        generic: [
          {
            title: "Install FFmpeg",
            command: "manual",
            args: ["Install FFmpeg for your OS and add it to PATH."],
            risk: "manual",
            note: "Use your OS package manager, then restart OmniClaw.",
          },
        ],
      },
    },
    {
      id: "python",
      name: "Python",
      role: "runtime",
      command: "python",
      testArgs: ["--version"],
      mediaKinds: ["audio", "video"],
      setupSteps: [
        "Install Python and make sure python is available on PATH.",
        "Python is commonly needed for local Whisper CLI installs.",
      ],
      installPlans: {
        win32: [
          {
            title: "Find Python packages",
            command: "winget",
            args: ["search", "Python.Python"],
            risk: "low",
            note: "Shows currently available Python versions before installing one.",
          },
          {
            title: "Install Python 3 with winget",
            command: "winget",
            args: ["install", "--id", "Python.Python.3", "-e"],
            risk: "medium",
            note: "Installs Python 3 if the winget package id is available. Use winget search output if the id changes.",
          },
        ],
        generic: [
          {
            title: "Install Python 3",
            command: "manual",
            args: ["Install Python 3 for your OS and add it to PATH."],
            risk: "manual",
            note: "Restart OmniClaw after PATH changes.",
          },
        ],
      },
    },
    {
      id: "pdftotext",
      name: "PDF text extractor",
      role: "pdf-text",
      command: "pdftotext",
      testArgs: ["-v"],
      mediaKinds: ["pdf"],
      routeTemplate: {
        enabled: true,
        provider: "local-command",
        command: "pdftotext",
        args: ["{file}", "-"],
        model: "pdftotext",
      },
      setupSteps: [
        "Install Poppler utilities and make sure pdftotext is available on PATH.",
        "This handles text-based PDFs. Scanned PDFs still need OCR-specific tooling.",
      ],
      installPlans: {
        win32: [
          {
            title: "Find Poppler packages",
            command: "winget",
            args: ["search", "poppler"],
            risk: "low",
            note: "Shows Poppler packages that provide pdftotext.",
          },
          {
            title: "Install Poppler with winget",
            command: "winget",
            args: ["install", "--id", "oschwartz10612.Poppler", "-e"],
            risk: "medium",
            note: "Installs Poppler utilities if the winget package id is available. Verify with winget search if it fails.",
          },
        ],
        generic: [
          {
            title: "Install Poppler utilities",
            command: "manual",
            args: ["Install Poppler for your OS and add pdftotext to PATH."],
            risk: "manual",
            note: "Use your OS package manager, then restart OmniClaw.",
          },
        ],
      },
    },
  ];
}

function normalizeOptionalLimit(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return clampNumber(number, number, min, max);
}

function replaceCommandPlaceholders(value, replacements = {}) {
  return String(value || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ? String(replacements[key]) : match,
  );
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExtractedText(cache = {}, buffer = Buffer.alloc(0)) {
  const raw = buffer.toString("utf8").replace(/\u0000/g, "");
  const mime = String(cache.mimeType || "").toLowerCase();
  const ext = path.extname(String(cache.relativePath || cache.name || "")).toLowerCase();

  if (mime === "application/json" || ext === ".json") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  if (mime === "text/html" || [".html", ".htm"].includes(ext)) {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export class ConnectorStore {
  constructor(rootDir, { secretStore = null } = {}) {
    this.rootDir = rootDir;
    this.secretStore = secretStore;
    this.filePath = path.join(rootDir, "data", "connectors.json");
    this.inboxDir = path.join(rootDir, "data", "inbox");
    this.archiveDir = path.join(this.inboxDir, "archive");
    this.attachmentsDir = path.join(rootDir, "data", "attachments");
    this.adaptersDir = path.join(rootDir, "connectors", "adapters");
    this.ensure();
  }

  defaultConfig() {
    return {
      webhook: {
        enabled: true,
        defaultAgentId: "main",
        allowPayloadAgent: true,
        requireToken: false,
        tokenHash: "",
        tokenPreview: "",
        tokenRotatedAt: null,
      },
      fileDrop: {
        enabled: true,
        defaultAgentId: "main",
        archiveProcessed: false,
        inboxDir: this.inboxDir,
        archiveDir: this.archiveDir,
      },
      attachmentIngestion: {
        enabled: true,
        autoCache: true,
        autoExtract: true,
        autoInject: false,
        includeUnsupported: false,
        maxAttachmentsPerDelivery: 3,
        maxCacheBytes: 5_000_000,
        maxExtractBytes: 1_000_000,
        maxExtractChars: 12000,
      },
      attachmentRetention: {
        enabled: true,
        maxAgeDays: 14,
        failedMaxAgeDays: 3,
        maxTotalBytes: 100_000_000,
        deleteOrphanFiles: true,
      },
      attachmentMediaAnalysis: {
        enabled: false,
        autoAnalyze: false,
        provider: "mock",
        endpoint: "",
        model: "",
        command: "",
        args: [],
        prompt: "Extract useful text, captions, and searchable details from this attachment.",
        maxInputBytes: 5_000_000,
        maxOutputChars: 12000,
        timeoutMs: 30000,
        routes: defaultMediaAnalysisRoutes(),
      },
    };
  }

  ensure() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            config: this.defaultConfig(),
            adapters: {},
            adapterDeliveries: [],
            adapterOutbox: [],
            adapterAttachmentCache: [],
            adapterAttachmentExtracts: [],
            adapterAttachmentInjections: [],
            adapterAttachmentAnalyses: [],
            attachmentCleanupRuns: [],
            webhookDeliveries: [],
            fileDrop: {
              inboxDir: this.inboxDir,
              processed: [],
            },
          },
          null,
          2,
        ),
      );
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const defaults = this.defaultConfig();
    return {
      config: {
        webhook: {
          ...defaults.webhook,
          ...(parsed.config?.webhook && typeof parsed.config.webhook === "object" ? parsed.config.webhook : {}),
        },
        fileDrop: {
          ...defaults.fileDrop,
          ...(parsed.config?.fileDrop && typeof parsed.config.fileDrop === "object" ? parsed.config.fileDrop : {}),
          inboxDir: this.inboxDir,
          archiveDir: this.archiveDir,
        },
        attachmentIngestion: this.normalizeAttachmentIngestionPolicy({
          ...defaults.attachmentIngestion,
          ...(parsed.config?.attachmentIngestion && typeof parsed.config.attachmentIngestion === "object"
            ? parsed.config.attachmentIngestion
            : {}),
        }),
        attachmentRetention: this.normalizeAttachmentRetentionPolicy({
          ...defaults.attachmentRetention,
          ...(parsed.config?.attachmentRetention && typeof parsed.config.attachmentRetention === "object"
            ? parsed.config.attachmentRetention
            : {}),
        }),
        attachmentMediaAnalysis: this.normalizeAttachmentMediaAnalysisPolicy({
          ...defaults.attachmentMediaAnalysis,
          ...(parsed.config?.attachmentMediaAnalysis && typeof parsed.config.attachmentMediaAnalysis === "object"
            ? parsed.config.attachmentMediaAnalysis
            : {}),
        }),
      },
      adapters: parsed.adapters && typeof parsed.adapters === "object" ? parsed.adapters : {},
      adapterDeliveries: Array.isArray(parsed.adapterDeliveries) ? parsed.adapterDeliveries : [],
      adapterOutbox: Array.isArray(parsed.adapterOutbox) ? parsed.adapterOutbox : [],
      adapterAttachmentCache: Array.isArray(parsed.adapterAttachmentCache) ? parsed.adapterAttachmentCache : [],
      adapterAttachmentExtracts: Array.isArray(parsed.adapterAttachmentExtracts) ? parsed.adapterAttachmentExtracts : [],
      adapterAttachmentInjections: Array.isArray(parsed.adapterAttachmentInjections) ? parsed.adapterAttachmentInjections : [],
      adapterAttachmentAnalyses: Array.isArray(parsed.adapterAttachmentAnalyses) ? parsed.adapterAttachmentAnalyses : [],
      attachmentCleanupRuns: Array.isArray(parsed.attachmentCleanupRuns) ? parsed.attachmentCleanupRuns : [],
      webhookDeliveries: Array.isArray(parsed.webhookDeliveries) ? parsed.webhookDeliveries : [],
      fileDrop: {
        inboxDir: parsed.fileDrop?.inboxDir || this.inboxDir,
        processed: Array.isArray(parsed.fileDrop?.processed) ? parsed.fileDrop.processed : [],
      },
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  getAllowedExtensions() {
    return new Set([".txt", ".md", ".json"]);
  }

  listAdapterManifests() {
    if (!fs.existsSync(this.adaptersDir)) {
      return [];
    }
    return fs
      .readdirSync(this.adaptersDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.adaptersDir, entry.name, "adapter.json"))
      .filter((adapterPath) => fs.existsSync(adapterPath))
      .map((adapterPath) => {
        const manifest = JSON.parse(fs.readFileSync(adapterPath, "utf8"));
        return {
          id: String(manifest.id || path.basename(path.dirname(adapterPath))).trim(),
          name: String(manifest.name || manifest.id || "Connector adapter").trim(),
          type: String(manifest.type || "custom").trim(),
          transport: String(manifest.transport || "custom").trim(),
          direction: String(manifest.direction || "inbound").trim(),
          defaultEnabled: manifest.defaultEnabled !== false,
          description: String(manifest.description || "").trim(),
          capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
          requiredSecrets: Array.isArray(manifest.requiredSecrets) ? manifest.requiredSecrets.map(String) : [],
          defaultAgentId: this.normalizeAgentId(manifest.defaultAgentId),
          docsHint: String(manifest.docsHint || "").trim(),
          manifestPath: path.relative(this.rootDir, adapterPath),
        };
      })
      .filter((manifest) => manifest.id)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getAdapterManifest(adapterId) {
    const id = String(adapterId || "").trim();
    const manifest = this.listAdapterManifests().find((item) => item.id === id);
    if (!manifest) {
      throw new Error(`Connector adapter not found: ${id || "(missing)"}`);
    }
    return manifest;
  }

  getAdapterStatus(manifest, state = {}) {
    if (state.enabled === false) {
      return "disabled";
    }
    if ((manifest.requiredSecrets || []).length > 0 && !state.secretConfigured) {
      return "needs-secret";
    }
    if (["telegram", "discord"].includes(manifest.id)) {
      return "configured";
    }
    return "ready";
  }

  publicAdapter(manifest, state = {}) {
    const enabled = "enabled" in state ? state.enabled !== false : manifest.defaultEnabled !== false;
    const secretStatus = this.secretStore?.getConnectorSecretStatus?.(manifest.id, "botToken") || {};
    const secretConfigured = (manifest.requiredSecrets || []).length > 0
      ? Boolean(secretStatus.configured)
      : Boolean(state.secretHash);
    return {
      id: manifest.id,
      name: manifest.name,
      type: manifest.type,
      transport: manifest.transport,
      direction: manifest.direction,
      description: manifest.description,
      capabilities: manifest.capabilities,
      requiredSecrets: manifest.requiredSecrets,
      enabled,
      status: this.getAdapterStatus(manifest, { ...state, enabled, secretConfigured }),
      defaultAgentId: this.normalizeAgentId(state.defaultAgentId, manifest.defaultAgentId),
      secretConfigured,
      secretPreview: state.secretPreview || secretStatus.masked || "",
      secretRotatedAt: state.secretRotatedAt || null,
      mode: state.mode || "manual",
      lastTestAt: state.lastTestAt || null,
      lastTestStatus: state.lastTestStatus || "",
      lastTestMessage: state.lastTestMessage || "",
      lastPollAt: state.lastPollAt || null,
      lastPollStatus: state.lastPollStatus || "",
      lastPollMessage: state.lastPollMessage || "",
      lastUpdateId: Number(state.lastUpdateId || 0),
      lastEventAt: state.lastEventAt || null,
      lastEventStatus: state.lastEventStatus || "",
      lastEventMessage: state.lastEventMessage || "",
      lastSequence: Number(state.lastSequence || 0),
      totalUpdates: Number(state.totalUpdates || 0),
      totalEvents: Number(state.totalEvents || 0),
      docsHint: manifest.docsHint,
      manifestPath: manifest.manifestPath,
    };
  }

  listAdapters() {
    const data = this.read();
    return this.listAdapterManifests().map((manifest) => this.publicAdapter(manifest, data.adapters[manifest.id] || {}));
  }

  getAdaptersOverview() {
    const adapters = this.listAdapters();
    return {
      total: adapters.length,
      enabled: adapters.filter((adapter) => adapter.enabled).length,
      ready: adapters.filter((adapter) => ["ready", "configured"].includes(adapter.status)).length,
      needsSecret: adapters.filter((adapter) => adapter.status === "needs-secret").length,
      manifestDir: this.adaptersDir,
    };
  }

  setAdapterConfig(input = {}) {
    const adapterId = String(input.adapterId || input.id || "").trim();
    const manifest = this.getAdapterManifest(adapterId);
    const data = this.read();
    const previous = data.adapters[manifest.id] || {};
    const next = {
      enabled: "enabled" in input
        ? Boolean(input.enabled)
        : "enabled" in previous
          ? previous.enabled !== false
          : manifest.defaultEnabled !== false,
      defaultAgentId: "defaultAgentId" in input
        ? this.normalizeAgentId(input.defaultAgentId, manifest.defaultAgentId)
        : this.normalizeAgentId(previous.defaultAgentId, manifest.defaultAgentId),
      mode: String(input.mode || previous.mode || "manual").trim() || "manual",
      secretHash: previous.secretHash || "",
      secretPreview: previous.secretPreview || "",
      secretRotatedAt: previous.secretRotatedAt || null,
      lastTestAt: previous.lastTestAt || null,
      lastTestStatus: previous.lastTestStatus || "",
      lastTestMessage: previous.lastTestMessage || "",
      lastPollAt: previous.lastPollAt || null,
      lastPollStatus: previous.lastPollStatus || "",
      lastPollMessage: previous.lastPollMessage || "",
      lastUpdateId: Number(previous.lastUpdateId || 0),
      totalUpdates: Number(previous.totalUpdates || 0),
      lastEventAt: previous.lastEventAt || null,
      lastEventStatus: previous.lastEventStatus || "",
      lastEventMessage: previous.lastEventMessage || "",
      lastSequence: Number(previous.lastSequence || 0),
      totalEvents: Number(previous.totalEvents || 0),
    };

    const secret = String(input.secret || input.botToken || "").trim();
    if (secret) {
      if (this.secretStore?.setConnectorSecret) {
        this.secretStore.setConnectorSecret(manifest.id, "botToken", secret);
      }
      next.secretHash = hashSecret(secret);
      next.secretPreview = maskToken(secret);
      next.secretRotatedAt = new Date().toISOString();
    }

    data.adapters[manifest.id] = next;
    this.syncCoreAdapterConfig(data, manifest.id, next);
    this.write(data);
    return {
      adapter: this.publicAdapter(manifest, next),
      secretUpdated: Boolean(secret),
    };
  }

  syncCoreAdapterConfig(data, adapterId, adapterState) {
    if (adapterId === "http-webhook") {
      data.config.webhook.enabled = adapterState.enabled !== false;
      data.config.webhook.defaultAgentId = this.normalizeAgentId(adapterState.defaultAgentId);
    }
    if (adapterId === "file-drop") {
      data.config.fileDrop.enabled = adapterState.enabled !== false;
      data.config.fileDrop.defaultAgentId = this.normalizeAgentId(adapterState.defaultAgentId);
    }
  }

  testAdapter(adapterId) {
    const manifest = this.getAdapterManifest(adapterId);
    const data = this.read();
    const current = data.adapters[manifest.id] || {};
    const adapter = this.publicAdapter(manifest, current);
    const test = {
      adapterId: manifest.id,
      ok: ["ready", "configured"].includes(adapter.status),
      status: adapter.status,
      checkedAt: new Date().toISOString(),
      message: "",
    };

    if (adapter.status === "disabled") {
      test.message = `${manifest.name} is disabled.`;
    } else if (adapter.status === "needs-secret") {
      test.message = `${manifest.name} needs ${manifest.requiredSecrets.join(", ")} before workers can start.`;
    } else if (["telegram", "discord"].includes(manifest.id)) {
      test.message = `${manifest.name} manifest and secret are ready.`;
    } else {
      test.message = `${manifest.name} is ready.`;
    }

    data.adapters[manifest.id] = {
      ...current,
      defaultAgentId: this.normalizeAgentId(current.defaultAgentId, manifest.defaultAgentId),
      enabled: "enabled" in current ? current.enabled !== false : manifest.defaultEnabled !== false,
      mode: current.mode || "manual",
      lastTestAt: test.checkedAt,
      lastTestStatus: test.status,
      lastTestMessage: test.message,
    };
    this.write(data);
    return {
      ...test,
      adapter: this.publicAdapter(manifest, data.adapters[manifest.id]),
    };
  }

  getAdapter(adapterId) {
    const manifest = this.getAdapterManifest(adapterId);
    const state = this.read().adapters[manifest.id] || {};
    return this.publicAdapter(manifest, state);
  }

  getAdapterSecret(adapterId, key = "botToken") {
    return this.secretStore?.getConnectorSecret?.(adapterId, key) || "";
  }

  updateAdapterRuntime(adapterId, updates = {}) {
    const manifest = this.getAdapterManifest(adapterId);
    const data = this.read();
    const current = data.adapters[manifest.id] || {};
    data.adapters[manifest.id] = {
      ...current,
      defaultAgentId: this.normalizeAgentId(current.defaultAgentId, manifest.defaultAgentId),
      enabled: "enabled" in current ? current.enabled !== false : manifest.defaultEnabled !== false,
      mode: current.mode || "manual",
      ...updates,
      runtimeUpdatedAt: new Date().toISOString(),
    };
    this.write(data);
    return this.publicAdapter(manifest, data.adapters[manifest.id]);
  }

  getPublicConfig() {
    const config = this.read().config;
    return {
      webhook: {
        enabled: config.webhook.enabled !== false,
        defaultAgentId: String(config.webhook.defaultAgentId || "main").trim() || "main",
        allowPayloadAgent: config.webhook.allowPayloadAgent !== false,
        requireToken: Boolean(config.webhook.requireToken),
        tokenConfigured: Boolean(config.webhook.tokenHash),
        tokenPreview: config.webhook.tokenPreview || "",
        tokenRotatedAt: config.webhook.tokenRotatedAt || null,
        acceptedHeaders: ["x-omniclaw-token", "Authorization: Bearer <token>"],
      },
      fileDrop: {
        enabled: config.fileDrop.enabled !== false,
        defaultAgentId: String(config.fileDrop.defaultAgentId || "main").trim() || "main",
        archiveProcessed: Boolean(config.fileDrop.archiveProcessed),
        inboxDir: this.inboxDir,
        archiveDir: this.archiveDir,
        allowedExtensions: Array.from(this.getAllowedExtensions()),
      },
      attachmentIngestion: this.normalizeAttachmentIngestionPolicy(config.attachmentIngestion),
      attachmentRetention: this.normalizeAttachmentRetentionPolicy(config.attachmentRetention),
      attachmentMediaAnalysis: {
        ...this.normalizeAttachmentMediaAnalysisPolicy(config.attachmentMediaAnalysis),
        apiKey: "",
        apiKeyConfigured: mediaAnalysisSecretStatus(this.secretStore).configured,
        apiKeyPreview: mediaAnalysisSecretStatus(this.secretStore).masked,
      },
    };
  }

  normalizeAttachmentIngestionPolicy(input = {}) {
    const defaults = this.defaultConfig().attachmentIngestion;
    return {
      enabled: "enabled" in input ? Boolean(input.enabled) : defaults.enabled,
      autoCache: "autoCache" in input ? Boolean(input.autoCache) : defaults.autoCache,
      autoExtract: "autoExtract" in input ? Boolean(input.autoExtract) : defaults.autoExtract,
      autoInject: "autoInject" in input ? Boolean(input.autoInject) : defaults.autoInject,
      includeUnsupported: "includeUnsupported" in input ? Boolean(input.includeUnsupported) : defaults.includeUnsupported,
      maxAttachmentsPerDelivery: clampNumber(input.maxAttachmentsPerDelivery, defaults.maxAttachmentsPerDelivery, 1, 10),
      maxCacheBytes: clampNumber(input.maxCacheBytes, defaults.maxCacheBytes, 1024, 25_000_000),
      maxExtractBytes: clampNumber(input.maxExtractBytes, defaults.maxExtractBytes, 1024, 5_000_000),
      maxExtractChars: clampNumber(input.maxExtractChars, defaults.maxExtractChars, 256, 50000),
    };
  }

  getAttachmentIngestionPolicy(overrides = {}) {
    return this.normalizeAttachmentIngestionPolicy({
      ...this.read().config.attachmentIngestion,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    });
  }

  normalizeAttachmentRetentionPolicy(input = {}) {
    const defaults = this.defaultConfig().attachmentRetention;
    return {
      enabled: "enabled" in input ? Boolean(input.enabled) : defaults.enabled,
      maxAgeDays: clampNumber(input.maxAgeDays, defaults.maxAgeDays, 1, 365),
      failedMaxAgeDays: clampNumber(input.failedMaxAgeDays, defaults.failedMaxAgeDays, 1, 365),
      maxTotalBytes: clampNumber(input.maxTotalBytes, defaults.maxTotalBytes, 1, 5_000_000_000),
      deleteOrphanFiles: "deleteOrphanFiles" in input ? Boolean(input.deleteOrphanFiles) : defaults.deleteOrphanFiles,
    };
  }

  getAttachmentRetentionPolicy(overrides = {}) {
    return this.normalizeAttachmentRetentionPolicy({
      ...this.read().config.attachmentRetention,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    });
  }

  normalizeAttachmentMediaAnalysisRoute(input = {}) {
    const route = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const provider = String(route.provider || "").trim();
    return {
      enabled: Boolean(route.enabled),
      provider: MEDIA_ANALYSIS_PROVIDERS.includes(provider) ? provider : "",
      endpoint: String(route.endpoint || "").trim(),
      model: String(route.model || "").trim(),
      command: String(route.command || "").trim(),
      args: normalizeCommandArgs(route.args || []),
      prompt: String(route.prompt || "").trim(),
      maxInputBytes: normalizeOptionalLimit(route.maxInputBytes, 1024, 25_000_000),
      maxOutputChars: normalizeOptionalLimit(route.maxOutputChars, 256, 50000),
      timeoutMs: normalizeOptionalLimit(route.timeoutMs, 1000, 120000),
    };
  }

  normalizeAttachmentMediaAnalysisRoutes(input = {}) {
    const routes = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    return Object.fromEntries(
      MEDIA_ANALYSIS_ROUTE_KEYS.map((key) => [key, this.normalizeAttachmentMediaAnalysisRoute(routes[key])]),
    );
  }

  normalizeAttachmentMediaAnalysisPolicy(input = {}) {
    const defaults = this.defaultConfig().attachmentMediaAnalysis;
    const provider = String(input.provider || defaults.provider).trim();
    return {
      enabled: "enabled" in input ? Boolean(input.enabled) : defaults.enabled,
      autoAnalyze: "autoAnalyze" in input ? Boolean(input.autoAnalyze) : defaults.autoAnalyze,
      provider: MEDIA_ANALYSIS_PROVIDERS.includes(provider) ? provider : defaults.provider,
      endpoint: String(input.endpoint || defaults.endpoint).trim(),
      model: String(input.model || defaults.model).trim(),
      command: String(input.command || defaults.command).trim(),
      args: normalizeCommandArgs("args" in input ? input.args : defaults.args),
      prompt: String(input.prompt || defaults.prompt).trim() || defaults.prompt,
      maxInputBytes: clampNumber(input.maxInputBytes, defaults.maxInputBytes, 1024, 25_000_000),
      maxOutputChars: clampNumber(input.maxOutputChars, defaults.maxOutputChars, 256, 50000),
      timeoutMs: clampNumber(input.timeoutMs, defaults.timeoutMs, 1000, 120000),
      routes: this.normalizeAttachmentMediaAnalysisRoutes("routes" in input ? input.routes : defaults.routes),
    };
  }

  getAttachmentMediaAnalysisPolicy(overrides = {}) {
    const policy = this.normalizeAttachmentMediaAnalysisPolicy({
      ...this.read().config.attachmentMediaAnalysis,
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    });
    return {
      ...policy,
      apiKey: this.secretStore?.getConnectorSecret?.("media-analysis", "apiKey") || "",
    };
  }

  resolveAttachmentMediaAnalysisPolicy(policy = {}, mediaKind = "") {
    const normalized = this.normalizeAttachmentMediaAnalysisPolicy(policy);
    const key = String(mediaKind || "").trim().toLowerCase();
    const routeKey = MEDIA_ANALYSIS_ROUTE_KEYS.includes(key) ? key : "";
    const route = routeKey ? normalized.routes[routeKey] : null;
    if (!route?.enabled) {
      return {
        ...normalized,
        apiKey: policy.apiKey || "",
        routeMediaKind: routeKey,
        routeApplied: false,
      };
    }

    const overrides = {};
    for (const field of ["provider", "endpoint", "model", "command", "prompt"]) {
      if (route[field]) {
        overrides[field] = route[field];
      }
    }
    if (route.args.length > 0) {
      overrides.args = route.args;
    }
    for (const field of ["maxInputBytes", "maxOutputChars", "timeoutMs"]) {
      if (route[field] > 0) {
        overrides[field] = route[field];
      }
    }

    return {
      ...this.normalizeAttachmentMediaAnalysisPolicy({
        ...normalized,
        ...overrides,
        routes: normalized.routes,
      }),
      apiKey: policy.apiKey || "",
      routeMediaKind: routeKey,
      routeApplied: true,
    };
  }

  normalizeAgentId(agentId, fallback = "main") {
    return String(agentId || "").trim() || fallback;
  }

  resolveWebhookAgent(requestedAgentId = "") {
    const config = this.read().config.webhook;
    const defaultAgentId = this.normalizeAgentId(config.defaultAgentId);
    if (config.allowPayloadAgent !== false && String(requestedAgentId || "").trim()) {
      return this.normalizeAgentId(requestedAgentId, defaultAgentId);
    }
    return defaultAgentId;
  }

  resolveFileDropAgent(requestedAgentId = "") {
    const config = this.read().config.fileDrop;
    return this.normalizeAgentId(requestedAgentId, this.normalizeAgentId(config.defaultAgentId));
  }

  updateConfig(input = {}) {
    const data = this.read();
    let generatedWebhookToken = "";

    if (input.webhook && typeof input.webhook === "object") {
      if ("enabled" in input.webhook) {
        data.config.webhook.enabled = Boolean(input.webhook.enabled);
      }
      if ("defaultAgentId" in input.webhook) {
        data.config.webhook.defaultAgentId = this.normalizeAgentId(input.webhook.defaultAgentId);
      }
      if ("allowPayloadAgent" in input.webhook) {
        data.config.webhook.allowPayloadAgent = Boolean(input.webhook.allowPayloadAgent);
      }
      if ("requireToken" in input.webhook) {
        data.config.webhook.requireToken = Boolean(input.webhook.requireToken);
        if (data.config.webhook.requireToken && !data.config.webhook.tokenHash) {
          generatedWebhookToken = this.applyWebhookToken(data);
        }
      }
    }

    if (input.fileDrop && typeof input.fileDrop === "object") {
      if ("enabled" in input.fileDrop) {
        data.config.fileDrop.enabled = Boolean(input.fileDrop.enabled);
      }
      if ("defaultAgentId" in input.fileDrop) {
        data.config.fileDrop.defaultAgentId = this.normalizeAgentId(input.fileDrop.defaultAgentId);
      }
      if ("archiveProcessed" in input.fileDrop) {
        data.config.fileDrop.archiveProcessed = Boolean(input.fileDrop.archiveProcessed);
      }
    }

    if (input.attachmentIngestion && typeof input.attachmentIngestion === "object") {
      data.config.attachmentIngestion = this.normalizeAttachmentIngestionPolicy({
        ...data.config.attachmentIngestion,
        ...input.attachmentIngestion,
      });
    }

    if (input.attachmentRetention && typeof input.attachmentRetention === "object") {
      data.config.attachmentRetention = this.normalizeAttachmentRetentionPolicy({
        ...data.config.attachmentRetention,
        ...input.attachmentRetention,
      });
    }

    if (input.attachmentMediaAnalysis && typeof input.attachmentMediaAnalysis === "object") {
      const rawApiKey = String(input.attachmentMediaAnalysis.apiKey || "").trim();
      if (rawApiKey && this.secretStore?.setConnectorSecret) {
        this.secretStore.setConnectorSecret("media-analysis", "apiKey", rawApiKey);
      }
      if (input.attachmentMediaAnalysis.clearApiKey === true && this.secretStore?.setConnectorSecret) {
        this.secretStore.setConnectorSecret("media-analysis", "apiKey", "");
      }
      const { apiKey, clearApiKey, ...policyInput } = input.attachmentMediaAnalysis;
      data.config.attachmentMediaAnalysis = this.normalizeAttachmentMediaAnalysisPolicy({
        ...data.config.attachmentMediaAnalysis,
        ...policyInput,
      });
    }

    this.write(data);
    return {
      config: this.getPublicConfig(),
      generatedWebhookToken,
    };
  }

  applyWebhookToken(data) {
    const token = createToken("omni_webhook");
    data.config.webhook.tokenHash = hashSecret(token);
    data.config.webhook.tokenPreview = maskToken(token);
    data.config.webhook.tokenRotatedAt = new Date().toISOString();
    return token;
  }

  rotateWebhookToken() {
    const data = this.read();
    const token = this.applyWebhookToken(data);
    this.write(data);
    return {
      token,
      config: this.getPublicConfig(),
    };
  }

  authorizeWebhook(token = "") {
    const config = this.read().config.webhook;
    if (config.enabled === false) {
      return {
        ok: false,
        code: "connector_disabled",
        statusCode: 403,
        message: "Webhook connector is disabled.",
      };
    }

    if (!config.requireToken) {
      return {
        ok: true,
        auth: "open",
      };
    }

    if (!config.tokenHash) {
      return {
        ok: false,
        code: "token_not_configured",
        statusCode: 403,
        message: "Webhook token is required but no token is configured.",
      };
    }

    const tokenHash = hashSecret(token);
    if (token && safeEqualHash(tokenHash, config.tokenHash)) {
      return {
        ok: true,
        auth: "token",
      };
    }

    return {
      ok: false,
      code: "invalid_connector_token",
      statusCode: 401,
      message: "Webhook token is required or invalid.",
    };
  }

  assertFileDropEnabled() {
    if (this.read().config.fileDrop.enabled === false) {
      const error = new Error("File-drop connector is disabled.");
      error.code = "connector_disabled";
      error.statusCode = 403;
      throw error;
    }
  }

  getOverview() {
    const data = this.read();
    const pending = this.listPendingFiles({ limit: 100 });
    return {
      webhookEnabled: data.config.webhook.enabled !== false,
      webhookDefaultAgentId: this.normalizeAgentId(data.config.webhook.defaultAgentId),
      webhookAllowPayloadAgent: data.config.webhook.allowPayloadAgent !== false,
      webhookRequireToken: Boolean(data.config.webhook.requireToken),
      webhookTokenConfigured: Boolean(data.config.webhook.tokenHash),
      fileDropEnabled: data.config.fileDrop.enabled !== false,
      fileDropDefaultAgentId: this.normalizeAgentId(data.config.fileDrop.defaultAgentId),
      fileDropArchiveProcessed: Boolean(data.config.fileDrop.archiveProcessed),
      adapterDeliveries: data.adapterDeliveries.length,
      adapterAttachments: data.adapterDeliveries.reduce((sum, item) => sum + Number(item.attachmentCount || 0), 0),
      adapterOutbox: data.adapterOutbox.length,
      adapterOutboxPending: data.adapterOutbox.filter((item) => !["sent", "abandoned"].includes(item.status)).length,
      adapterAttachmentCache: data.adapterAttachmentCache.length,
      adapterAttachmentCacheBytes: data.adapterAttachmentCache
        .filter((item) => item.status === "cached")
        .reduce((sum, item) => sum + Number(item.byteLength || 0), 0),
      adapterAttachmentCachePurged: data.adapterAttachmentCache.filter((item) => item.status === "purged").length,
      adapterAttachmentExtracts: data.adapterAttachmentExtracts.length,
      adapterAttachmentMediaMetadata: data.adapterAttachmentExtracts.filter((item) => item.status === "media-metadata").length,
      adapterAttachmentExtractCharacters: data.adapterAttachmentExtracts.reduce((sum, item) => sum + Number(item.characterCount || 0), 0),
      adapterAttachmentInjections: data.adapterAttachmentInjections.length,
      adapterAttachmentInjectionFailures: data.adapterAttachmentInjections.filter((item) => item.status === "failed").length,
      adapterAttachmentAnalyses: data.adapterAttachmentAnalyses.length,
      adapterAttachmentAnalysisFailures: data.adapterAttachmentAnalyses.filter((item) => item.status === "failed").length,
      attachmentCleanupRuns: data.attachmentCleanupRuns.length,
      webhookDeliveries: data.webhookDeliveries.length,
      fileDropProcessed: data.fileDrop.processed.length,
      fileDropPending: pending.length,
      inboxDir: this.inboxDir,
      lastWebhookAt: data.webhookDeliveries[data.webhookDeliveries.length - 1]?.createdAt || null,
      lastFileDropAt: data.fileDrop.processed[data.fileDrop.processed.length - 1]?.processedAt || null,
      lastAdapterDeliveryAt: data.adapterDeliveries[data.adapterDeliveries.length - 1]?.createdAt || null,
      lastAdapterOutboxAt: data.adapterOutbox[data.adapterOutbox.length - 1]?.createdAt || null,
      lastAdapterCacheAt: data.adapterAttachmentCache[data.adapterAttachmentCache.length - 1]?.createdAt || null,
      lastAdapterExtractAt: data.adapterAttachmentExtracts[data.adapterAttachmentExtracts.length - 1]?.createdAt || null,
      lastAdapterInjectionAt: data.adapterAttachmentInjections[data.adapterAttachmentInjections.length - 1]?.createdAt || null,
      lastAdapterAnalysisAt: data.adapterAttachmentAnalyses[data.adapterAttachmentAnalyses.length - 1]?.createdAt || null,
      lastAttachmentCleanupAt: data.attachmentCleanupRuns[data.attachmentCleanupRuns.length - 1]?.createdAt || null,
    };
  }

  listAdapterDeliveries(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterDeliveries
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status || item.replyStatus === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "adapterId",
          "channel",
          "eventType",
          "externalId",
          "conversationId",
          "author",
          "messagePreview",
          "agentId",
          "label",
          "source",
          "status",
          "replyStatus",
          "replyError",
          "attachmentSummary",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAdapterOutbox(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterOutbox
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "deliveryId",
          "adapterId",
          "channel",
          "conversationId",
          "externalId",
          "replyPreview",
          "messagePreview",
          "agentId",
          "source",
          "status",
          "error",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAdapterAttachmentCache(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterAttachmentCache
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "deliveryId",
          "adapterId",
          "attachmentId",
          "type",
          "name",
          "mimeType",
          "relativePath",
          "sha256",
          "status",
          "error",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAdapterAttachmentExtracts(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterAttachmentExtracts
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "cacheId",
          "deliveryId",
          "adapterId",
          "attachmentId",
          "type",
          "name",
          "mimeType",
          "method",
          "status",
          "error",
          "contentPreview",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAdapterAttachmentInjections(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterAttachmentInjections
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "extractId",
          "cacheId",
          "deliveryId",
          "adapterId",
          "attachmentId",
          "name",
          "mimeType",
          "agentId",
          "label",
          "sessionId",
          "runId",
          "status",
          "error",
          "messagePreview",
          "replyPreview",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAdapterAttachmentAnalyses(options = 20) {
    const { limit, adapterId, status, query } = normalizeListOptions(options, 20);
    return this.read().adapterAttachmentAnalyses
      .slice()
      .reverse()
      .filter((item) => !adapterId || adapterId === "all" || item.adapterId === adapterId)
      .filter((item) => !status || status === "all" || item.status === status)
      .filter((item) =>
        matchesText(item, query, [
          "id",
          "extractId",
          "cacheId",
          "deliveryId",
          "adapterId",
          "attachmentId",
          "name",
          "mimeType",
          "mediaKind",
          "provider",
          "model",
          "status",
          "error",
          "contentPreview",
        ]),
      )
      .slice(0, Math.max(1, limit || 20));
  }

  listAttachmentCleanupRuns(limit = 10) {
    return this.read().attachmentCleanupRuns
      .slice()
      .reverse()
      .slice(0, Math.max(1, Number(limit || 10)));
  }

  listWebhookDeliveries(limit = 20) {
    return this.read().webhookDeliveries.slice(-Number(limit || 20)).reverse();
  }

  listFileDropRecords(limit = 20) {
    return this.read().fileDrop.processed.slice(-Number(limit || 20)).reverse();
  }

  recordWebhook(input = {}) {
    const data = this.read();
    const record = {
      id: createId("webhook"),
      createdAt: new Date().toISOString(),
      messagePreview: truncate(input.message || "", 260),
      label: String(input.label || "webhook").trim(),
      agentId: String(input.agentId || "main").trim() || "main",
      requestedAgentId: String(input.requestedAgentId || "").trim(),
      auth: String(input.auth || "").trim(),
      source: String(input.source || "").trim(),
      status: input.status || "completed",
      error: input.error || "",
      result: summarizeRun(input.result),
    };
    data.webhookDeliveries.push(record);
    if (data.webhookDeliveries.length > 200) {
      data.webhookDeliveries = data.webhookDeliveries.slice(-200);
    }
    this.write(data);
    return record;
  }

  recordAdapterDelivery(input = {}) {
    const data = this.read();
    const attachments = Array.isArray(input.attachments) ? input.attachments.slice(0, 10).map(sanitizeAttachment) : [];
    const attachmentSummary = truncate(input.attachmentSummary || summarizeAttachments(attachments), 420);
    const record = {
      id: createId("adapter"),
      createdAt: new Date().toISOString(),
      adapterId: String(input.adapterId || "").trim(),
      channel: String(input.channel || input.adapterId || "adapter").trim(),
      eventType: String(input.eventType || "message").trim(),
      externalId: String(input.externalId || "").trim(),
      conversationId: String(input.conversationId || "").trim(),
      author: String(input.author || "").trim(),
      messagePreview: truncate(input.message || input.messagePreview || input.content || "", 260),
      attachments,
      attachmentCount: Number(input.attachmentCount || attachments.length || 0),
      attachmentSummary,
      agentId: String(input.agentId || "main").trim() || "main",
      label: String(input.label || input.adapterId || "adapter").trim(),
      source: String(input.source || "").trim(),
      status: input.status || "completed",
      error: input.error || "",
      replySent: Boolean(input.replySent),
      replyStatus: String(input.replyStatus || (input.replySent ? "sent" : "skipped")).trim(),
      replyError: String(input.replyError || "").trim(),
      outboxId: String(input.outboxId || "").trim(),
      result: summarizeRun(input.result),
    };
    data.adapterDeliveries.push(record);
    if (data.adapterDeliveries.length > 300) {
      data.adapterDeliveries = data.adapterDeliveries.slice(-300);
    }
    this.write(data);
    return record;
  }

  updateAdapterDelivery(deliveryId, updates = {}) {
    const data = this.read();
    const index = data.adapterDeliveries.findIndex((item) => item.id === deliveryId);
    if (index === -1) {
      return null;
    }
    data.adapterDeliveries[index] = {
      ...data.adapterDeliveries[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.adapterDeliveries[index];
  }

  getAdapterDelivery(deliveryId) {
    const id = String(deliveryId || "").trim();
    const delivery = this.read().adapterDeliveries.find((item) => item.id === id);
    if (!delivery) {
      throw new Error(`Adapter delivery not found: ${id || "(missing)"}`);
    }
    return delivery;
  }

  getAdapterDeliveryAttachment(input = {}) {
    const delivery = this.getAdapterDelivery(input.deliveryId || input.id);
    const attachments = Array.isArray(delivery.attachments) ? delivery.attachments : [];
    const attachmentId = String(input.attachmentId || "").trim();
    const attachmentIndex = attachmentId
      ? attachments.findIndex((item) => item.id === attachmentId || item.fileUniqueId === attachmentId)
      : Math.max(0, Number(input.attachmentIndex || 0));
    const attachment = attachments[attachmentIndex];
    if (!attachment) {
      throw new Error(`Attachment not found on delivery ${delivery.id}.`);
    }
    return {
      delivery,
      attachment: sanitizeAttachment(attachment),
      attachmentIndex,
    };
  }

  recordAdapterAttachmentCache(input = {}) {
    const data = this.read();
    const deliveryIndex = data.adapterDeliveries.findIndex((item) => item.id === String(input.deliveryId || "").trim());
    if (deliveryIndex === -1) {
      throw new Error(`Adapter delivery not found: ${input.deliveryId || "(missing)"}`);
    }
    const delivery = data.adapterDeliveries[deliveryIndex];
    const attachmentIndex = Math.max(0, Number(input.attachmentIndex || 0));
    const attachment = sanitizeAttachment(input.attachment || delivery.attachments?.[attachmentIndex] || {});
    const recordId = createId("cache");
    const status = String(input.status || "cached").trim();
    const buffer = Buffer.isBuffer(input.contentBuffer) ? input.contentBuffer : Buffer.from(input.contentBuffer || "");
    const byteLength = status === "cached" ? buffer.length : 0;
    const sha256 = status === "cached" ? crypto.createHash("sha256").update(buffer).digest("hex") : "";
    const adapterId = String(input.adapterId || delivery.adapterId || attachment.type || "adapter").trim();
    const cacheDir = path.resolve(this.attachmentsDir, safePathSegment(adapterId), safePathSegment(delivery.id));
    const extension = extensionForAttachment(attachment);
    const rawName = String(attachment.name || attachment.id || attachment.type || "attachment");
    const baseSource = path.extname(rawName) ? path.basename(rawName, path.extname(rawName)) : rawName;
    const fileName = `${recordId}-${safePathSegment(baseSource)}${extension}`;
    const absolutePath = path.resolve(cacheDir, fileName);
    const root = path.resolve(this.attachmentsDir);

    if (!absolutePath.startsWith(root)) {
      throw new Error("Resolved attachment cache path escaped the attachment cache directory.");
    }

    let relativePath = "";
    if (status === "cached") {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(absolutePath, buffer);
      relativePath = path.relative(this.rootDir, absolutePath);
    }

    const record = {
      id: recordId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deliveryId: delivery.id,
      adapterId,
      attachmentIndex,
      attachmentId: String(attachment.id || attachment.fileUniqueId || "").trim(),
      type: attachment.type || "attachment",
      name: attachment.name || "",
      mimeType: String(input.mimeType || attachment.mimeType || "").trim(),
      expectedSize: Number(attachment.size || 0),
      byteLength,
      sha256,
      relativePath,
      absolutePath: status === "cached" ? absolutePath : "",
      mediaKind: mediaKindForAttachment({
        ...attachment,
        mimeType: input.mimeType || attachment.mimeType,
        relativePath,
      }),
      width: Number(attachment.width || 0),
      height: Number(attachment.height || 0),
      duration: Number(attachment.duration || 0),
      retentionPinned: Boolean(input.retentionPinned),
      sourceUrlPreview: maskSourceUrl(input.sourceUrl),
      status,
      error: String(input.error || "").trim(),
    };

    data.adapterAttachmentCache.push(record);
    if (data.adapterAttachmentCache.length > 300) {
      data.adapterAttachmentCache = data.adapterAttachmentCache.slice(-300);
    }

    const deliveryAttachments = Array.isArray(delivery.attachments) ? [...delivery.attachments] : [];
    if (deliveryAttachments[attachmentIndex]) {
      deliveryAttachments[attachmentIndex] = {
        ...deliveryAttachments[attachmentIndex],
        cacheStatus: status,
        cacheId: record.id,
        cachePath: record.relativePath,
        cachedAt: record.createdAt,
        cacheError: record.error,
      };
    }
    data.adapterDeliveries[deliveryIndex] = {
      ...delivery,
      attachments: deliveryAttachments,
      attachmentCacheCount: deliveryAttachments.filter((item) => item.cacheStatus === "cached").length,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return {
      cache: record,
      delivery: data.adapterDeliveries[deliveryIndex],
    };
  }

  getAdapterAttachmentCacheItem(cacheId) {
    const id = String(cacheId || "").trim();
    const cache = this.read().adapterAttachmentCache.find((item) => item.id === id);
    if (!cache) {
      throw new Error(`Adapter attachment cache record not found: ${id || "(missing)"}`);
    }
    return cache;
  }

  resolveAdapterAttachmentCache(input = {}) {
    const cacheId = String(input.cacheId || input.id || "").trim();
    if (cacheId) {
      return this.getAdapterAttachmentCacheItem(cacheId);
    }

    const deliveryId = String(input.deliveryId || "").trim();
    if (!deliveryId) {
      throw new Error("cacheId or deliveryId is required.");
    }
    const attachmentIndex = Math.max(0, Number(input.attachmentIndex || 0));
    const cache = this.read()
      .adapterAttachmentCache
      .slice()
      .reverse()
      .find((item) => item.deliveryId === deliveryId && Number(item.attachmentIndex || 0) === attachmentIndex && item.status === "cached");
    if (!cache) {
      throw new Error(`No cached attachment found for delivery ${deliveryId} attachment ${attachmentIndex}.`);
    }
    return cache;
  }

  getAdapterAttachmentExtractItem(extractId) {
    const id = String(extractId || "").trim();
    const extract = this.read().adapterAttachmentExtracts.find((item) => item.id === id);
    if (!extract) {
      throw new Error(`Adapter attachment extract record not found: ${id || "(missing)"}`);
    }
    return extract;
  }

  extractAdapterAttachmentCache(input = {}) {
    const data = this.read();
    const cache = this.resolveAdapterAttachmentCache(input);
    const cacheIndex = data.adapterAttachmentCache.findIndex((item) => item.id === cache.id);
    if (cacheIndex === -1) {
      throw new Error(`Adapter attachment cache record not found: ${cache.id}`);
    }

    const maxBytes = Math.max(1024, Number(input.maxBytes || 1_000_000));
    const maxChars = Math.max(256, Number(input.maxChars || 12000));
    const root = path.resolve(this.attachmentsDir);
    const absolutePath = path.resolve(cache.absolutePath || path.join(this.rootDir, cache.relativePath || ""));
    if (!isPathInside(absolutePath, root)) {
      throw new Error("Resolved attachment path escaped the attachment cache directory.");
    }

    const extractId = createId("extract");
    let status = "completed";
    let error = "";
    let method = "utf8-text";
    let extractedText = "";
    let characterCount = 0;
    let contentHash = "";

    try {
      if (cache.status !== "cached") {
        throw new Error(`Attachment cache status is ${cache.status}; only cached files can be extracted.`);
      }
      if (!fs.existsSync(absolutePath)) {
        throw new Error("Cached attachment file is missing on disk.");
      }
      const stat = fs.statSync(absolutePath);
      if (stat.size > maxBytes) {
        throw new Error(`Cached attachment is too large to extract (${stat.size} bytes > ${maxBytes} bytes).`);
      }
      if (!isLikelyTextCache(cache)) {
        const mediaKind = cache.mediaKind || mediaKindForAttachment(cache);
        if (mediaKind) {
          status = "media-metadata";
          method = `${mediaKind}-metadata`;
          extractedText = buildMediaMetadataText({ ...cache, mediaKind }, stat);
        } else {
          status = "unsupported";
          method = "metadata-only";
          extractedText = [
            `Unsupported extraction type: ${cache.mimeType || cache.type || "unknown"}`,
            `File: ${cache.name || cache.relativePath || cache.id}`,
            `Bytes: ${cache.byteLength || stat.size}`,
            `SHA-256: ${cache.sha256 || "unknown"}`,
          ].join("\n");
        }
      } else {
        const buffer = fs.readFileSync(absolutePath);
        extractedText = normalizeExtractedText(cache, buffer);
      }
      if (extractedText.length > maxChars) {
        extractedText = `${extractedText.slice(0, Math.max(0, maxChars - 18))}...[truncated]`;
      }
      characterCount = extractedText.length;
      contentHash = crypto.createHash("sha256").update(extractedText).digest("hex");
    } catch (extractError) {
      status = "failed";
      error = extractError.message;
    }

    const record = {
      id: extractId,
      createdAt: new Date().toISOString(),
      cacheId: cache.id,
      deliveryId: cache.deliveryId,
      adapterId: cache.adapterId,
      attachmentIndex: Number(cache.attachmentIndex || 0),
      attachmentId: cache.attachmentId || "",
      type: cache.type || "attachment",
      name: cache.name || "",
      mimeType: cache.mimeType || "",
      relativePath: cache.relativePath || "",
      byteLength: Number(cache.byteLength || 0),
      mediaKind: cache.mediaKind || mediaKindForAttachment(cache),
      width: Number(cache.width || 0),
      height: Number(cache.height || 0),
      duration: Number(cache.duration || 0),
      method,
      status,
      error,
      characterCount,
      contentHash,
      contentPreview: truncate(extractedText || error || "", 1800),
      extractedText,
    };

    data.adapterAttachmentExtracts.push(record);
    if (data.adapterAttachmentExtracts.length > 300) {
      data.adapterAttachmentExtracts = data.adapterAttachmentExtracts.slice(-300);
    }

    data.adapterAttachmentCache[cacheIndex] = {
      ...data.adapterAttachmentCache[cacheIndex],
      extractStatus: status,
      extractId: record.id,
      extractedAt: record.createdAt,
      extractError: error,
      contentPreview: record.contentPreview,
      updatedAt: new Date().toISOString(),
    };

    const deliveryIndex = data.adapterDeliveries.findIndex((item) => item.id === cache.deliveryId);
    if (deliveryIndex !== -1) {
      const delivery = data.adapterDeliveries[deliveryIndex];
      const attachments = Array.isArray(delivery.attachments) ? [...delivery.attachments] : [];
      if (attachments[record.attachmentIndex]) {
        attachments[record.attachmentIndex] = {
          ...attachments[record.attachmentIndex],
          extractStatus: status,
          extractId: record.id,
          extractedAt: record.createdAt,
          extractError: error,
          contentPreview: record.contentPreview,
        };
      }
      data.adapterDeliveries[deliveryIndex] = {
        ...delivery,
        attachments,
        attachmentExtractCount: attachments.filter((item) => ["completed", "unsupported", "media-metadata"].includes(item.extractStatus)).length,
        updatedAt: new Date().toISOString(),
      };
    }

    this.write(data);
    return {
      extract: record,
      cache: data.adapterAttachmentCache[cacheIndex],
      delivery: deliveryIndex !== -1 ? data.adapterDeliveries[deliveryIndex] : null,
    };
  }

  resolveMediaAnalysisExtract(data, input = {}) {
    const extractId = String(input.extractId || input.id || "").trim();
    if (extractId) {
      const extract = data.adapterAttachmentExtracts.find((item) => item.id === extractId);
      if (!extract) {
        throw new Error(`Adapter attachment extract record not found: ${extractId}`);
      }
      return extract;
    }

    const cacheId = String(input.cacheId || "").trim();
    if (cacheId) {
      const extract = data.adapterAttachmentExtracts
        .slice()
        .reverse()
        .find((item) => item.cacheId === cacheId && item.status === "media-metadata");
      if (!extract) {
        throw new Error(`No media metadata extract found for cache ${cacheId}.`);
      }
      return extract;
    }

    const deliveryId = String(input.deliveryId || "").trim();
    if (deliveryId) {
      const attachmentIndex = Math.max(0, Number(input.attachmentIndex || 0));
      const extract = data.adapterAttachmentExtracts
        .slice()
        .reverse()
        .find((item) => item.deliveryId === deliveryId && Number(item.attachmentIndex || 0) === attachmentIndex && item.status === "media-metadata");
      if (!extract) {
        throw new Error(`No media metadata extract found for delivery ${deliveryId} attachment ${attachmentIndex}.`);
      }
      return extract;
    }

    throw new Error("extractId, cacheId, or deliveryId is required.");
  }

  async runMediaAnalysisProvider({ policy, cache, extract, absolutePath, buffer }) {
    if (policy.provider === "mock") {
      const kind = extract.mediaKind || cache.mediaKind || "media";
      const label = kind === "image" || kind === "pdf" ? "OCR" : kind === "audio" || kind === "video" ? "transcription" : "media analysis";
      return {
        provider: "mock",
        model: "local-mock",
        text: [
          `Mock ${label} result for ${extract.name || cache.name || extract.id}.`,
          `Media kind: ${kind}`,
          `MIME: ${extract.mimeType || cache.mimeType || "unknown"}`,
          `Bytes: ${cache.byteLength || buffer.length}`,
          extract.width || extract.height ? `Dimensions: ${extract.width || 0}x${extract.height || 0}` : "",
          extract.duration ? `Duration: ${extract.duration}s` : "",
          "Replace provider=mock with provider=http-json and an endpoint for real OCR/transcription.",
        ].filter(Boolean).join("\n"),
      };
    }

    if (policy.provider !== "http-json") {
      if (policy.provider !== "local-command") {
        throw new Error(`Unsupported media analysis provider: ${policy.provider}`);
      }

      if (!policy.command) {
        throw new Error("Media analysis command is required for local-command provider.");
      }
      const replacements = {
        file: absolutePath,
        mediaKind: extract.mediaKind || cache.mediaKind || "",
        mimeType: extract.mimeType || cache.mimeType || "",
        name: extract.name || cache.name || "",
        model: policy.model || "",
        prompt: policy.prompt || "",
        sha256: cache.sha256 || "",
      };
      const args = (policy.args.length ? policy.args : ["{file}"]).map((item) => replaceCommandPlaceholders(item, replacements));
      const output = await execFileAsync(policy.command, args, {
        timeout: policy.timeoutMs,
        maxBuffer: Math.max(1_000_000, policy.maxOutputChars * 8),
        windowsHide: true,
      });
      const stdout = String(output.stdout || "").trim();
      const stderr = String(output.stderr || "").trim();
      return {
        provider: "local-command",
        model: policy.model || path.basename(policy.command),
        text: stdout || stderr,
        rawPreview: truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), 1200),
      };
    }

    if (!policy.endpoint) {
      throw new Error("Media analysis endpoint is required for http-json provider.");
    }
    if (typeof fetch !== "function") {
      throw new Error("This Node runtime does not provide fetch for http-json media analysis.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      const headers = {
        "Content-Type": "application/json",
      };
      if (policy.apiKey) {
        headers.Authorization = `Bearer ${policy.apiKey}`;
      }
      const response = await fetch(policy.endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          provider: "omniclaw-media-analysis",
          model: policy.model,
          prompt: policy.prompt,
          mediaKind: extract.mediaKind || cache.mediaKind || "",
          mimeType: extract.mimeType || cache.mimeType || "",
          name: extract.name || cache.name || "",
          bytes: buffer.length,
          sha256: cache.sha256 || "",
          width: extract.width || cache.width || 0,
          height: extract.height || cache.height || 0,
          duration: extract.duration || cache.duration || 0,
          fileName: path.basename(absolutePath),
          contentBase64: buffer.toString("base64"),
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Media analysis failed: ${response.status} ${raw.slice(0, 240)}`);
      }
      let payload = raw;
      try {
        payload = JSON.parse(raw);
      } catch {
        // Plain text endpoints are accepted too.
      }
      return {
        provider: "http-json",
        model: payload?.model || policy.model || "",
        text: pickAnalysisText(payload),
        rawPreview: truncate(raw, 1200),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async testAttachmentMediaAnalysisProvider(input = {}) {
    const basePolicy = this.getAttachmentMediaAnalysisPolicy(input.policy && typeof input.policy === "object" ? input.policy : {});
    const policy = this.resolveAttachmentMediaAnalysisPolicy(basePolicy, input.mediaKind || "");
    const checkedAt = new Date().toISOString();
    const result = {
      ok: false,
      available: false,
      status: "unknown",
      provider: policy.provider,
      model: policy.model || "",
      mediaKind: String(input.mediaKind || "").trim(),
      routeApplied: Boolean(policy.routeApplied),
      routeMediaKind: policy.routeMediaKind || "",
      checkedAt,
      message: "",
      command: policy.provider === "local-command" ? policy.command : "",
      testArgs: [],
      outputPreview: "",
    };

    if (policy.provider === "mock") {
      return {
        ...result,
        ok: true,
        available: true,
        status: "ready",
        message: "Mock media provider is available offline.",
      };
    }

    if (policy.provider === "http-json") {
      return {
        ...result,
        ok: Boolean(policy.endpoint),
        available: Boolean(policy.endpoint),
        status: policy.endpoint ? "configured" : "missing-endpoint",
        message: policy.endpoint
          ? "HTTP JSON provider has an endpoint configured. Run a real analysis to validate the remote service."
          : "HTTP JSON provider needs an endpoint before media analysis can run.",
      };
    }

    if (policy.provider !== "local-command") {
      return {
        ...result,
        status: "unsupported",
        message: `Unsupported media analysis provider: ${policy.provider}`,
      };
    }

    if (!policy.command) {
      return {
        ...result,
        status: "missing-command",
        message: "Local-command provider needs a command name or absolute executable path.",
      };
    }

    const testArgs = input.testArgs == null ? ["--version"] : normalizeCommandArgs(input.testArgs);
    try {
      const output = await execFileAsync(policy.command, testArgs, {
        timeout: Math.min(policy.timeoutMs || 5000, 15000),
        maxBuffer: 10000,
        windowsHide: true,
      });
      const stdout = String(output.stdout || "").trim();
      const stderr = String(output.stderr || "").trim();
      return {
        ...result,
        ok: true,
        available: true,
        status: "available",
        testArgs,
        message: "Local command started successfully.",
        outputPreview: truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), 1200),
      };
    } catch (error) {
      const stdout = String(error.stdout || "").trim();
      const stderr = String(error.stderr || "").trim();
      const missing = ["ENOENT", "EACCES"].includes(error.code);
      return {
        ...result,
        ok: !missing,
        available: !missing,
        status: missing ? "missing" : "started-with-error",
        testArgs,
        message: missing
          ? `Local command was not found or not executable: ${policy.command}`
          : `Local command started but returned an error: ${error.message}`,
        outputPreview: truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), 1200),
      };
    }
  }

  async probeLocalMediaEngine(engine = {}) {
    const checkedAt = new Date().toISOString();
    const base = {
      id: engine.id || engine.command || "engine",
      name: engine.name || engine.id || engine.command || "Local engine",
      role: engine.role || "local-command",
      command: engine.command || "",
      testArgs: normalizeCommandArgs(engine.testArgs || []),
      mediaKinds: Array.isArray(engine.mediaKinds) ? engine.mediaKinds : [],
      dependencies: Array.isArray(engine.dependencies) ? engine.dependencies : [],
      routeTemplate: engine.routeTemplate || null,
      setupSteps: Array.isArray(engine.setupSteps) ? engine.setupSteps : [],
      checkedAt,
      available: false,
      status: "unknown",
      message: "",
      outputPreview: "",
    };

    if (!base.command) {
      return {
        ...base,
        status: "missing-command",
        message: "No command configured for this engine.",
      };
    }

    try {
      const output = await execFileAsync(base.command, base.testArgs, {
        timeout: 15000,
        maxBuffer: 20000,
        windowsHide: true,
      });
      const stdout = String(output.stdout || "").trim();
      const stderr = String(output.stderr || "").trim();
      return {
        ...base,
        available: true,
        status: "available",
        message: `${base.name} is available.`,
        outputPreview: truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), 1200),
      };
    } catch (error) {
      const stdout = String(error.stdout || "").trim();
      const stderr = String(error.stderr || "").trim();
      const missing = ["ENOENT", "EACCES"].includes(error.code);
      return {
        ...base,
        available: false,
        status: missing ? "missing" : "started-with-error",
        message: missing
          ? `${base.name} was not found on PATH.`
          : `${base.name} started but returned an error: ${error.message}`,
        outputPreview: truncate([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), 1200),
      };
    }
  }

  async getLocalMediaProviderSetup() {
    const catalog = localMediaEngineCatalog();
    const engines = await Promise.all(catalog.map((engine) => this.probeLocalMediaEngine(engine)));
    const byId = Object.fromEntries(engines.map((engine) => [engine.id, engine]));
    const recommendedRoutes = defaultMediaAnalysisRoutes();
    const warnings = [];

    for (const engine of engines) {
      if (!engine.available || !engine.routeTemplate) {
        continue;
      }
      for (const mediaKind of engine.mediaKinds) {
        if (MEDIA_ANALYSIS_ROUTE_KEYS.includes(mediaKind) && !recommendedRoutes[mediaKind].enabled) {
          recommendedRoutes[mediaKind] = this.normalizeAttachmentMediaAnalysisRoute(engine.routeTemplate);
        }
      }
    }

    if (byId.whisper?.available && byId.ffmpeg && !byId.ffmpeg.available) {
      warnings.push("Whisper is available, but FFmpeg is missing; audio/video decoding may fail until FFmpeg is installed.");
    }
    if (byId.tesseract?.available && !recommendedRoutes.pdf.enabled) {
      warnings.push("Tesseract is available for image OCR. Scanned PDFs still need a PDF-to-image/OCR workflow before PDF routes are fully covered.");
    }

    return {
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      engines,
      readyCount: engines.filter((engine) => engine.available).length,
      missingCount: engines.filter((engine) => !engine.available).length,
      recommendedRoutes,
      recommendedPolicy: {
        enabled: true,
        autoAnalyze: false,
        provider: "mock",
        routes: recommendedRoutes,
      },
      warnings,
      nextSteps: [
        "Install any missing local engines you want to use, then restart OmniClaw if PATH changed.",
        "Use Apply detected routes in the dashboard, review the JSON, then Save policy.",
        "Run Test media provider for each media kind before enabling auto-analyze.",
      ],
    };
  }

  async createLocalMediaProviderInstallPlan(input = {}) {
    const setup = await this.getLocalMediaProviderSetup();
    const catalog = localMediaEngineCatalog();
    const byEngineId = Object.fromEntries(setup.engines.map((engine) => [engine.id, engine]));
    const requestedIds = Array.isArray(input.engineIds)
      ? input.engineIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const includeAvailable = Boolean(input.includeAvailable);
    const platform = String(input.platform || process.platform).trim() || process.platform;
    const targetCatalog = catalog.filter((engine) => {
      if (requestedIds.length > 0 && !requestedIds.includes(engine.id)) {
        return false;
      }
      const probe = byEngineId[engine.id];
      return includeAvailable || !probe?.available;
    });

    const targets = targetCatalog.map((engine) => {
      const probe = byEngineId[engine.id] || {};
      const rawSteps = engine.installPlans?.[platform] || engine.installPlans?.generic || [];
      const steps = rawSteps.map((step, index) => {
        const args = normalizeCommandArgs(step.args || []);
        const command = String(step.command || "").trim();
        return {
          id: `${engine.id}_install_step_${index + 1}`,
          title: step.title || `Install ${engine.name}`,
          command,
          args,
          displayCommand: formatCommandDisplay(command, args),
          risk: step.risk || "medium",
          requiresApproval: true,
          executesAutomatically: false,
          note: step.note || "",
        };
      });
      return {
        id: engine.id,
        name: engine.name,
        role: engine.role,
        status: probe.status || "unknown",
        available: Boolean(probe.available),
        command: engine.command,
        mediaKinds: engine.mediaKinds || [],
        dependencies: engine.dependencies || [],
        setupSteps: engine.setupSteps || [],
        routeTemplate: engine.routeTemplate || null,
        steps,
        blocked: steps.length === 0,
        blockedReason: steps.length === 0 ? "No installer plan is available for this platform." : "",
      };
    });

    return {
      createdAt: new Date().toISOString(),
      platform,
      detectedPlatform: process.platform,
      executesAutomatically: false,
      requiresApproval: true,
      includeAvailable,
      requestedEngineIds: requestedIds,
      readyCount: setup.readyCount,
      missingCount: setup.missingCount,
      targetCount: targets.length,
      commandCount: targets.reduce((sum, target) => sum + target.steps.length, 0),
      targets,
      warnings: [
        ...setup.warnings,
        "Installer plans are advisory. OmniClaw does not run them automatically.",
        "After installing or changing PATH, restart OmniClaw and run Check local engines again.",
      ],
      nextSteps: [
        "Review each command before running it.",
        "Run only the commands for engines you actually need.",
        "Restart OmniClaw after PATH changes, then test the media provider route.",
      ],
    };
  }

  async analyzeAdapterAttachmentMedia(input = {}) {
    const data = this.read();
    let policy = this.getAttachmentMediaAnalysisPolicy(input.policy || {});
    const force = input.force === true;
    const extract = this.resolveMediaAnalysisExtract(data, input);
    const extractIndex = data.adapterAttachmentExtracts.findIndex((item) => item.id === extract.id);
    const cacheIndex = data.adapterAttachmentCache.findIndex((item) => item.id === extract.cacheId);
    if (cacheIndex === -1) {
      throw new Error(`Adapter attachment cache record not found: ${extract.cacheId || "(missing)"}`);
    }
    const cache = data.adapterAttachmentCache[cacheIndex];
    const mediaKind = extract.mediaKind || cache.mediaKind || mediaKindForAttachment(extract);
    policy = this.resolveAttachmentMediaAnalysisPolicy(policy, mediaKind);
    const root = path.resolve(this.attachmentsDir);
    const absolutePath = path.resolve(cache.absolutePath || path.join(this.rootDir, cache.relativePath || ""));
    const analysisId = createId("analysis");
    let status = "completed";
    let error = "";
    let text = "";
    let providerResult = {
      provider: policy.provider,
      model: policy.model,
      rawPreview: "",
    };

    try {
      if (!policy.enabled && !force) {
        status = "skipped";
        throw new Error("Media analysis policy is disabled.");
      }
      if (!force && extract.status !== "media-metadata") {
        status = "skipped";
        throw new Error(`Extract status is ${extract.status}; only media-metadata extracts are analyzed.`);
      }
      if (cache.status !== "cached") {
        throw new Error(`Attachment cache status is ${cache.status}; media analysis needs a cached file.`);
      }
      if (!isPathInside(absolutePath, root)) {
        throw new Error("Resolved media path escaped the attachment cache directory.");
      }
      if (!fs.existsSync(absolutePath)) {
        throw new Error("Cached media file is missing on disk.");
      }
      const stat = fs.statSync(absolutePath);
      if (stat.size > policy.maxInputBytes) {
        throw new Error(`Cached media is too large to analyze (${stat.size} bytes > ${policy.maxInputBytes} bytes).`);
      }
      const buffer = fs.readFileSync(absolutePath);
      providerResult = await this.runMediaAnalysisProvider({
        policy,
        cache,
        extract,
        absolutePath,
        buffer,
      });
      text = normalizeAnalysisText(providerResult.text, policy.maxOutputChars);
      if (!text) {
        throw new Error("Media analysis provider returned no text.");
      }
    } catch (analysisError) {
      error = analysisError.message;
      if (status !== "skipped") {
        status = "failed";
      }
    }

    const analyzedAt = new Date().toISOString();
    const contentHash = text ? crypto.createHash("sha256").update(text).digest("hex") : "";
    const analysis = {
      id: analysisId,
      createdAt: analyzedAt,
      extractId: extract.id,
      cacheId: extract.cacheId || "",
      deliveryId: extract.deliveryId || "",
      adapterId: extract.adapterId || "",
      attachmentIndex: Number(extract.attachmentIndex || 0),
      attachmentId: extract.attachmentId || "",
      type: extract.type || "attachment",
      name: extract.name || "",
      mimeType: extract.mimeType || "",
      mediaKind,
      routeMediaKind: policy.routeMediaKind || "",
      routeApplied: Boolean(policy.routeApplied),
      provider: providerResult.provider || policy.provider,
      model: providerResult.model || policy.model || "",
      status,
      error,
      characterCount: text.length,
      contentHash,
      contentPreview: truncate(text || error || "", 1800),
      text,
      rawPreview: providerResult.rawPreview || "",
    };

    data.adapterAttachmentAnalyses.push(analysis);
    if (data.adapterAttachmentAnalyses.length > 300) {
      data.adapterAttachmentAnalyses = data.adapterAttachmentAnalyses.slice(-300);
    }

    data.adapterAttachmentExtracts[extractIndex] = {
      ...extract,
      analysisStatus: status,
      analysisId: analysis.id,
      analyzedAt,
      analysisProvider: analysis.provider,
      analysisModel: analysis.model,
      analysisError: error,
      updatedAt: analyzedAt,
      ...(status === "completed"
        ? {
            status: "completed",
            method: `${analysis.provider}-${analysis.mediaKind || "media"}-analysis`,
            mediaMetadataText: extract.mediaMetadataText || extract.extractedText || "",
            extractedText: text,
            contentPreview: analysis.contentPreview,
            characterCount: text.length,
            contentHash,
            error: "",
          }
        : {}),
    };

    data.adapterAttachmentCache[cacheIndex] = {
      ...cache,
      analysisStatus: status,
      analysisId: analysis.id,
      analyzedAt,
      analysisError: error,
      ...(status === "completed"
        ? {
            extractStatus: "completed",
            contentPreview: analysis.contentPreview,
          }
        : {}),
      updatedAt: analyzedAt,
    };

    const deliveryIndex = data.adapterDeliveries.findIndex((item) => item.id === extract.deliveryId);
    if (deliveryIndex !== -1) {
      const delivery = data.adapterDeliveries[deliveryIndex];
      const attachments = Array.isArray(delivery.attachments) ? [...delivery.attachments] : [];
      if (attachments[analysis.attachmentIndex]) {
        attachments[analysis.attachmentIndex] = {
          ...attachments[analysis.attachmentIndex],
          analysisStatus: status,
          analysisId: analysis.id,
          analyzedAt,
          analysisError: error,
          ...(status === "completed"
            ? {
                extractStatus: "completed",
                contentPreview: analysis.contentPreview,
              }
            : {}),
        };
      }
      data.adapterDeliveries[deliveryIndex] = {
        ...delivery,
        attachments,
        attachmentExtractCount: attachments.filter((item) => ["completed", "unsupported", "media-metadata"].includes(item.extractStatus)).length,
        attachmentAnalysisCount: attachments.filter((item) => item.analysisStatus === "completed").length,
        updatedAt: analyzedAt,
      };
    }

    this.write(data);
    return {
      analysis,
      extract: data.adapterAttachmentExtracts[extractIndex],
      cache: data.adapterAttachmentCache[cacheIndex],
      delivery: deliveryIndex !== -1 ? data.adapterDeliveries[deliveryIndex] : null,
    };
  }

  async analyzePendingMediaAttachments(input = {}) {
    const limit = clampNumber(input.limit, 5, 1, 25);
    const data = this.read();
    const candidates = data.adapterAttachmentExtracts
      .slice()
      .reverse()
      .filter((item) => item.status === "media-metadata" && item.analysisStatus !== "completed")
      .slice(0, limit);
    const results = [];
    for (const extract of candidates) {
      try {
        results.push(await this.analyzeAdapterAttachmentMedia({
          extractId: extract.id,
          force: input.force === true,
          policy: input.policy && typeof input.policy === "object" ? input.policy : {},
        }));
      } catch (error) {
        results.push({
          extractId: extract.id,
          error: error.message,
        });
      }
    }
    return {
      scanned: candidates.length,
      completed: results.filter((item) => item.analysis?.status === "completed").length,
      failed: results.filter((item) => item.error || item.analysis?.status === "failed").length,
      skipped: results.filter((item) => item.analysis?.status === "skipped").length,
      results,
    };
  }

  cleanupAdapterAttachmentCache(input = {}) {
    const data = this.read();
    const policy = this.getAttachmentRetentionPolicy(input.policy || input);
    const dryRun = input.dryRun !== false;
    const now = Date.now();
    const root = path.resolve(this.attachmentsDir);
    const maxAgeMs = policy.maxAgeDays * 24 * 60 * 60 * 1000;
    const failedMaxAgeMs = policy.failedMaxAgeDays * 24 * 60 * 60 * 1000;
    const candidateIds = new Set();
    const candidates = [];

    const addCandidate = (cache, reason) => {
      if (!cache?.id || candidateIds.has(cache.id) || cache.retentionPinned) {
        return;
      }
      candidateIds.add(cache.id);
      candidates.push({
        id: cache.id,
        deliveryId: cache.deliveryId || "",
        adapterId: cache.adapterId || "",
        name: cache.name || "",
        status: cache.status || "",
        reason,
        byteLength: Number(cache.byteLength || 0),
        relativePath: cache.relativePath || "",
        absolutePath: cache.absolutePath || "",
      });
    };

    for (const cache of data.adapterAttachmentCache) {
      const createdAt = new Date(cache.createdAt || 0).getTime();
      const ageMs = Number.isFinite(createdAt) ? now - createdAt : 0;
      if (cache.status === "failed" && ageMs > failedMaxAgeMs) {
        addCandidate(cache, "failed-expired");
      } else if (cache.status === "cached" && ageMs > maxAgeMs) {
        addCandidate(cache, "age-expired");
      }
    }

    let runningBytes = data.adapterAttachmentCache
      .filter((item) => item.status === "cached")
      .reduce((sum, item) => sum + Number(item.byteLength || 0), 0);
    const cachedByAge = data.adapterAttachmentCache
      .filter((item) => item.status === "cached" && !item.retentionPinned)
      .slice()
      .sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime());

    for (const cache of cachedByAge) {
      if (runningBytes <= policy.maxTotalBytes) {
        break;
      }
      addCandidate(cache, "size-budget");
      runningBytes -= Number(cache.byteLength || 0);
    }

    const knownFiles = new Set(
      data.adapterAttachmentCache
        .map((item) => path.resolve(item.absolutePath || path.join(this.rootDir, item.relativePath || "")))
        .filter((item) => isPathInside(item, root)),
    );
    const orphanFiles = [];
    if (policy.deleteOrphanFiles && fs.existsSync(root)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolutePath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(absolutePath);
          } else if (entry.isFile()) {
            const resolved = path.resolve(absolutePath);
            if (!knownFiles.has(resolved)) {
              const stat = fs.statSync(resolved);
              const ageMs = now - stat.mtimeMs;
              if (ageMs > maxAgeMs) {
                orphanFiles.push({
                  relativePath: path.relative(this.rootDir, resolved),
                  absolutePath: resolved,
                  byteLength: stat.size,
                  reason: "orphan-expired",
                });
              }
            }
          }
        }
      };
      walk(root);
    }

    const summary = {
      id: createId("cleanup"),
      createdAt: new Date().toISOString(),
      dryRun,
      policy,
      status: policy.enabled || input.force ? "completed" : "skipped",
      candidates: candidates.length,
      orphanCandidates: orphanFiles.length,
      purged: 0,
      orphanPurged: 0,
      bytesWouldFree: candidates.reduce((sum, item) => sum + Number(item.byteLength || 0), 0) + orphanFiles.reduce((sum, item) => sum + Number(item.byteLength || 0), 0),
      bytesFreed: 0,
      errors: [],
      items: candidates.slice(0, 50),
      orphans: orphanFiles.slice(0, 50).map((item) => ({
        relativePath: item.relativePath,
        byteLength: item.byteLength,
        reason: item.reason,
      })),
    };

    if (!policy.enabled && !input.force) {
      data.attachmentCleanupRuns.push(summary);
      data.attachmentCleanupRuns = data.attachmentCleanupRuns.slice(-50);
      this.write(data);
      return summary;
    }

    if (!dryRun) {
      for (const candidate of candidates) {
        const cacheIndex = data.adapterAttachmentCache.findIndex((item) => item.id === candidate.id);
        if (cacheIndex === -1) {
          continue;
        }
        const cache = data.adapterAttachmentCache[cacheIndex];
        const absolutePath = path.resolve(cache.absolutePath || path.join(this.rootDir, cache.relativePath || ""));
        try {
          if (cache.status === "cached" && cache.relativePath && isPathInside(absolutePath, root) && fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            summary.bytesFreed += Number(cache.byteLength || 0);
          }
          data.adapterAttachmentCache[cacheIndex] = {
            ...cache,
            status: "purged",
            purgedAt: summary.createdAt,
            purgeReason: candidate.reason,
            absolutePath: "",
            byteLength: 0,
            updatedAt: summary.createdAt,
          };
          summary.purged += 1;

          const deliveryIndex = data.adapterDeliveries.findIndex((item) => item.id === cache.deliveryId);
          if (deliveryIndex !== -1) {
            const delivery = data.adapterDeliveries[deliveryIndex];
            const attachments = Array.isArray(delivery.attachments) ? [...delivery.attachments] : [];
            const attachmentIndex = Number(cache.attachmentIndex || 0);
            if (attachments[attachmentIndex]?.cacheId === cache.id) {
              attachments[attachmentIndex] = {
                ...attachments[attachmentIndex],
                cacheStatus: "purged",
                cachePath: "",
                cacheError: `Purged by retention: ${candidate.reason}`,
                purgedAt: summary.createdAt,
              };
            }
            data.adapterDeliveries[deliveryIndex] = {
              ...delivery,
              attachments,
              updatedAt: summary.createdAt,
            };
          }

          for (let extractIndex = 0; extractIndex < data.adapterAttachmentExtracts.length; extractIndex += 1) {
            if (data.adapterAttachmentExtracts[extractIndex].cacheId === cache.id) {
              data.adapterAttachmentExtracts[extractIndex] = {
                ...data.adapterAttachmentExtracts[extractIndex],
                cachePurgedAt: summary.createdAt,
                cachePurgeReason: candidate.reason,
                updatedAt: summary.createdAt,
              };
            }
          }
        } catch (error) {
          summary.errors.push({
            id: cache.id,
            error: error.message,
          });
        }
      }

      for (const orphan of orphanFiles) {
        try {
          if (isPathInside(orphan.absolutePath, root) && fs.existsSync(orphan.absolutePath)) {
            fs.unlinkSync(orphan.absolutePath);
            summary.bytesFreed += Number(orphan.byteLength || 0);
            summary.orphanPurged += 1;
          }
        } catch (error) {
          summary.errors.push({
            path: orphan.relativePath,
            error: error.message,
          });
        }
      }

      if (fs.existsSync(root)) {
        const dirs = [];
        const collectDirs = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              const absolutePath = path.join(dir, entry.name);
              collectDirs(absolutePath);
              dirs.push(absolutePath);
            }
          }
        };
        collectDirs(root);
        for (const dir of dirs.sort((left, right) => right.length - left.length)) {
          try {
            if (isPathInside(dir, root) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
            }
          } catch {
            // Empty directory cleanup is best-effort only.
          }
        }
      }
    }

    summary.status = summary.errors.length ? (summary.purged || summary.orphanPurged ? "partial" : "failed") : summary.status;
    data.attachmentCleanupRuns.push(summary);
    data.attachmentCleanupRuns = data.attachmentCleanupRuns.slice(-50);
    this.write(data);
    return summary;
  }

  recordAdapterAttachmentInjection(input = {}) {
    const data = this.read();
    const extractId = String(input.extractId || input.id || "").trim();
    const extractIndex = data.adapterAttachmentExtracts.findIndex((item) => item.id === extractId);
    if (extractIndex === -1) {
      throw new Error(`Adapter attachment extract record not found: ${extractId || "(missing)"}`);
    }

    const extract = data.adapterAttachmentExtracts[extractIndex];
    const result = input.result && typeof input.result === "object" ? input.result : null;
    const resultSummary = summarizeRun(result);
    const status = String(input.status || (input.error || result?.error ? "failed" : "completed")).trim();
    const record = {
      id: createId("inject"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      extractId: extract.id,
      cacheId: extract.cacheId || "",
      deliveryId: extract.deliveryId || "",
      adapterId: extract.adapterId || "",
      attachmentIndex: Number(extract.attachmentIndex || 0),
      attachmentId: extract.attachmentId || "",
      type: extract.type || "attachment",
      name: extract.name || "",
      mimeType: extract.mimeType || "",
      relativePath: extract.relativePath || "",
      extractStatus: extract.status || "",
      characterCount: Number(extract.characterCount || 0),
      agentId: String(input.agentId || resultSummary?.agentId || "main").trim() || "main",
      label: String(input.label || "attachment-extract").trim(),
      sessionId: String(input.sessionId || resultSummary?.sessionId || "").trim(),
      sessionKey: String(input.sessionKey || resultSummary?.sessionKey || "").trim(),
      runId: String(input.runId || resultSummary?.runId || "").trim(),
      runStatus: String(input.runStatus || resultSummary?.runStatus || "").trim(),
      provider: String(input.provider || resultSummary?.provider || "").trim(),
      status,
      error: String(input.error || result?.error || "").trim(),
      messagePreview: truncate(input.message || "", 700),
      replyPreview: truncate(result?.reply || resultSummary?.replyPreview || "", 700),
      result: resultSummary,
      source: String(input.source || "manual").trim(),
    };

    data.adapterAttachmentInjections.push(record);
    if (data.adapterAttachmentInjections.length > 300) {
      data.adapterAttachmentInjections = data.adapterAttachmentInjections.slice(-300);
    }

    data.adapterAttachmentExtracts[extractIndex] = {
      ...extract,
      injectionStatus: status,
      injectionId: record.id,
      injectedAt: record.createdAt,
      injectionError: record.error,
      injectionSessionId: record.sessionId,
      injectionRunId: record.runId,
      injectedAgentId: record.agentId,
      updatedAt: new Date().toISOString(),
    };

    const cacheIndex = data.adapterAttachmentCache.findIndex((item) => item.id === extract.cacheId);
    if (cacheIndex !== -1) {
      data.adapterAttachmentCache[cacheIndex] = {
        ...data.adapterAttachmentCache[cacheIndex],
        injectionStatus: status,
        injectionId: record.id,
        injectedAt: record.createdAt,
        injectionError: record.error,
        updatedAt: new Date().toISOString(),
      };
    }

    const deliveryIndex = data.adapterDeliveries.findIndex((item) => item.id === extract.deliveryId);
    if (deliveryIndex !== -1) {
      const delivery = data.adapterDeliveries[deliveryIndex];
      const attachments = Array.isArray(delivery.attachments) ? [...delivery.attachments] : [];
      if (attachments[record.attachmentIndex]) {
        attachments[record.attachmentIndex] = {
          ...attachments[record.attachmentIndex],
          injectionStatus: status,
          injectionId: record.id,
          injectedAt: record.createdAt,
          injectionError: record.error,
          injectionSessionId: record.sessionId,
          injectionRunId: record.runId,
        };
      }
      data.adapterDeliveries[deliveryIndex] = {
        ...delivery,
        attachments,
        attachmentInjectionCount: attachments.filter((item) => item.injectionStatus === "completed").length,
        updatedAt: new Date().toISOString(),
      };
    }

    this.write(data);
    return {
      injection: record,
      extract: data.adapterAttachmentExtracts[extractIndex],
      cache: cacheIndex !== -1 ? data.adapterAttachmentCache[cacheIndex] : null,
      delivery: deliveryIndex !== -1 ? data.adapterDeliveries[deliveryIndex] : null,
    };
  }

  recordAdapterOutbox(input = {}) {
    const data = this.read();
    const replyText = truncate(input.replyText || input.content || "", 3500);
    const record = {
      id: createId("outbox"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deliveryId: String(input.deliveryId || "").trim(),
      adapterId: String(input.adapterId || "").trim(),
      channel: String(input.channel || input.adapterId || "adapter").trim(),
      conversationId: String(input.conversationId || "").trim(),
      externalId: String(input.externalId || "").trim(),
      agentId: String(input.agentId || "main").trim() || "main",
      source: String(input.source || "").trim(),
      messagePreview: truncate(input.message || input.messagePreview || "", 260),
      replyText,
      replyPreview: truncate(replyText, 260),
      status: String(input.status || "failed").trim(),
      error: String(input.error || "").trim(),
      attempts: Number(input.attempts || 0),
      maxAttempts: Number(input.maxAttempts || 3),
      lastAttemptAt: input.lastAttemptAt || null,
      sentAt: null,
    };
    data.adapterOutbox.push(record);
    if (data.adapterOutbox.length > 300) {
      data.adapterOutbox = data.adapterOutbox.slice(-300);
    }
    this.write(data);
    return record;
  }

  getAdapterOutboxItem(outboxId) {
    const id = String(outboxId || "").trim();
    const item = this.read().adapterOutbox.find((entry) => entry.id === id);
    if (!item) {
      throw new Error(`Adapter outbox item not found: ${id || "(missing)"}`);
    }
    return item;
  }

  markAdapterOutboxAttempt(outboxId, input = {}) {
    const data = this.read();
    const index = data.adapterOutbox.findIndex((item) => item.id === String(outboxId || "").trim());
    if (index === -1) {
      throw new Error(`Adapter outbox item not found: ${outboxId || "(missing)"}`);
    }
    const current = data.adapterOutbox[index];
    const status = String(input.status || current.status || "failed").trim();
    data.adapterOutbox[index] = {
      ...current,
      status,
      error: String(input.error || "").trim(),
      attempts: Number(current.attempts || 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      sentAt: status === "sent" ? new Date().toISOString() : current.sentAt || null,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.adapterOutbox[index];
  }

  fileKey(fileName, hash) {
    return `${fileName}:${hash}`;
  }

  listPendingFiles({ limit = 20, agentId = "main" } = {}) {
    const data = this.read();
    if (data.config.fileDrop.enabled === false) {
      return [];
    }
    const routedAgentId = this.resolveFileDropAgent(agentId);
    const processedKeys = new Set(data.fileDrop.processed.map((item) => item.key));
    const allowed = this.getAllowedExtensions();
    const entries = fs
      .readdirSync(this.inboxDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => allowed.has(path.extname(fileName).toLowerCase()))
      .sort();
    const files = [];

    for (const fileName of entries) {
      const absolutePath = path.join(this.inboxDir, fileName);
      const stat = fs.statSync(absolutePath);
      const content = fs.readFileSync(absolutePath, "utf8");
      const hash = hashContent(content);
      const key = this.fileKey(fileName, hash);
      if (processedKeys.has(key)) {
        continue;
      }

      files.push({
        id: createId("filedrop"),
        key,
        fileName,
        absolutePath,
        relativePath: path.relative(this.rootDir, absolutePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hash,
        agentId: routedAgentId,
        label: `file:${fileName}`,
        message: [
          `File drop received: ${fileName}`,
          "",
          truncate(content, 12000),
        ].join("\n"),
        contentPreview: truncate(content, 500),
      });

      if (files.length >= Number(limit || 20)) {
        break;
      }
    }

    return files;
  }

  markFileProcessed(file, input = {}) {
    const data = this.read();
    const existing = data.fileDrop.processed.find((item) => item.key === file.key);
    if (existing) {
      return existing;
    }

    const record = {
      id: file.id || createId("filedrop"),
      key: file.key,
      fileName: file.fileName,
      relativePath: file.relativePath,
      size: file.size,
      hash: file.hash,
      agentId: file.agentId || "main",
      label: file.label || `file:${file.fileName}`,
      contentPreview: file.contentPreview || "",
      status: input.status || "completed",
      error: input.error || "",
      processedAt: new Date().toISOString(),
      archivedAt: null,
      archivePath: "",
      result: summarizeRun(input.result),
    };
    this.archiveProcessedFile(record, file, data.config.fileDrop);
    data.fileDrop.processed.push(record);
    if (data.fileDrop.processed.length > 300) {
      data.fileDrop.processed = data.fileDrop.processed.slice(-300);
    }
    this.write(data);
    return record;
  }

  archiveProcessedFile(record, file, config) {
    if (!config.archiveProcessed || !file.absolutePath || !fs.existsSync(file.absolutePath)) {
      return;
    }

    fs.mkdirSync(this.archiveDir, { recursive: true });
    const ext = path.extname(file.fileName);
    const baseName = path.basename(file.fileName, ext);
    let destination = path.join(this.archiveDir, file.fileName);
    if (fs.existsSync(destination)) {
      destination = path.join(this.archiveDir, `${baseName}-${record.id}${ext}`);
    }
    fs.renameSync(file.absolutePath, destination);
    record.archivedAt = new Date().toISOString();
    record.archivePath = path.relative(this.rootDir, destination);
  }
}
