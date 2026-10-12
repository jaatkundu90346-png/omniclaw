// MediaEngine — harness-side media powers: the model doesn't need to support
// images for OmniClaw to generate them, SEE them, or assemble video.
//
// Philosophy (Mankush): "model jo na kar sake, woh harness kar de."
//   - generateImage: real image generation via a configured OpenAI-compatible
//     images endpoint, falling back to the free keyless Pollinations API.
//   - describeImage: HARNESS EYES — a vision-capable provider (configured
//     profile, the active model if it can see, or the free Pollinations
//     OpenAI-compatible endpoint) describes any image as TEXT, so even a
//     text-only model can "look at" screenshots and generated media.
//   - generateVideo: keyframe images + ffmpeg (zoompan slideshow) → real mp4;
//     without ffmpeg it falls back to an autoplaying HTML slideshow file.
//
// All outputs land under workspace/media/ (inside rootDir) and are reachable
// through the existing /preview/<relPath> static route, so chat can render them.
//
// Config (all optional — free fallbacks make this work with ZERO setup):
//   runtime.media.allowFreeFallback  — default true; set false to disable
//                                      keyless Pollinations calls.
//   runtime.media.image.profileId    — providerProfiles entry whose baseUrl
//                                      serves POST /images/generations.
//   runtime.media.image.model        — model name for that endpoint.
//   runtime.media.vision.profileId   — providerProfiles entry with a
//                                      vision-capable chat model.
//   runtime.media.vision.model       — override model for vision calls.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProvider } from "./provider-factory.js";

const execFileAsync = promisify(execFile);

// Same capability sniff omni-loop uses — one place would be better, but the
// regex is stable and omni-loop's copy is method-bound to its settings.
const VISION_MODEL_RE = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo3\b|\bo4\b|claude|gemini|llava|qwen[.\d-]*vl|pixtral|minicpm-v|internvl|phi-4-multimodal|llama-3\.2[\w-]*vision|llama-4|maverick|scout|grok-(?:2-vision|vision|4)|glm-4v|minimax-vl|nova-(?:lite|pro|premier)|deepseek-vl|step-1v|yi-vision|nemotron[\w-]*vl/;

const POLLINATIONS_IMAGE_URL = "https://image.pollinations.ai/prompt/";
const POLLINATIONS_TEXT_URL = "https://text.pollinations.ai/openai";

// A text-only model answering a vision request says "I can't see images" with
// HTTP 200 — that's a FAILED describe, not a description. Without this check
// describe_image returned ok:true garbage (fake success).
const BLIND_REFUSAL_RE = /(not able to|can't|cannot|unable to)\s+(see|view|process)\s+(the\s+)?image|no image (was )?(attached|provided|here)|don't see (an|any) image|what (image|picture) are you referring/i;

export function isBlindRefusal(text = "") {
  return BLIND_REFUSAL_RE.test(String(text));
}

// Vision models known to exist on specific gateways, tried with the SAME
// baseUrl+key when the profile's own chat model is text-only.
const KNOWN_GATEWAY_VISION_MODELS = [
  { hostRe: /integrate\.api\.nvidia\.com/i, models: ["meta/llama-3.2-90b-vision-instruct", "meta/llama-3.2-11b-vision-instruct"] },
];

function slugify(text = "", max = 48) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max) || "media";
}

function guessMime(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "image/png";
}

export class MediaEngine {
  constructor({ rootDir, configStore, secretStore, provider = null, providerRef = null } = {}) {
    this.rootDir = rootDir || process.cwd();
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.provider = provider; // static provider (tests)
    this.providerRef = providerRef; // () => live provider — agent recreates it on switches
    this.ffmpegChecked = false;
    this.ffmpegPath = "";
    // Injectable for offline tests.
    this.fetchImpl = (...args) => globalThis.fetch(...args);
  }

  activeProvider() {
    try {
      return (typeof this.providerRef === "function" ? this.providerRef() : null) || this.provider;
    } catch {
      return this.provider;
    }
  }

  mediaConfig() {
    try { return this.configStore?.getConfig?.()?.runtime?.media || {}; } catch { return {}; }
  }

  allowFreeFallback() {
    return this.mediaConfig().allowFreeFallback !== false;
  }

  mediaDir() {
    const dir = path.join(this.rootDir, "workspace", "media");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveMedia(buffer, { prompt = "", ext = ".png" } = {}) {
    const dir = this.mediaDir();
    const name = `${Date.now().toString(36)}-${slugify(prompt)}${ext}`;
    const abs = path.join(dir, name);
    fs.writeFileSync(abs, buffer);
    return { path: abs, relPath: path.relative(this.rootDir, abs).replace(/\\/g, "/") };
  }

  // ── Image generation ─────────────────────────────────────────────────────

  /**
   * Generate an image. Tries the configured images endpoint first, then the
   * free Pollinations API. Returns { ok, path, relPath, previewUrl, backend }.
   */
  async generateImage({ prompt, width = 1024, height = 768, seed } = {}) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) return { ok: false, error: true, message: "prompt is required" };

    const errors = [];
    // 1. Configured OpenAI-compatible images endpoint.
    const viaProfile = await this.generateImageViaProfile(cleanPrompt, { width, height }).catch((error) => {
      errors.push(`profile: ${error.message}`);
      return null;
    });
    if (viaProfile) return viaProfile;

    // 2. Free keyless Pollinations fallback.
    if (this.allowFreeFallback()) {
      try {
        return await this.generateImageViaPollinations(cleanPrompt, { width, height, seed });
      } catch (error) {
        errors.push(`pollinations: ${error.message}`);
      }
    } else {
      errors.push("free fallback disabled (runtime.media.allowFreeFallback=false)");
    }

    return {
      ok: false,
      error: true,
      message: `Image generation failed: ${errors.join("; ") || "no backend available"}. Configure runtime.media.image.profileId or enable the free fallback.`,
    };
  }

  async generateImageViaProfile(prompt, { width, height }) {
    const imageCfg = this.mediaConfig().image || {};
    if (!imageCfg.profileId) return null;
    const profiles = this.configStore?.getConfig?.()?.providerProfiles || {};
    const profile = profiles[imageCfg.profileId];
    if (!profile?.baseUrl) throw new Error(`image profile "${imageCfg.profileId}" not found or has no baseUrl`);
    const apiKey = this.resolveProfileKey(profile, imageCfg.profileId);

    const base = String(profile.baseUrl).replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        model: imageCfg.model || undefined,
        size: `${width}x${height}`,
        n: 1,
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`images endpoint HTTP ${response.status}`);
    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    const url = data?.data?.[0]?.url;
    let buffer;
    if (b64) {
      buffer = Buffer.from(b64, "base64");
    } else if (url) {
      const img = await this.fetchImpl(url, { signal: AbortSignal.timeout(120000) });
      if (!img.ok) throw new Error(`image download HTTP ${img.status}`);
      buffer = Buffer.from(await img.arrayBuffer());
    } else {
      throw new Error("images endpoint returned neither b64_json nor url");
    }
    const saved = this.saveMedia(buffer, { prompt, ext: ".png" });
    return { ok: true, ...saved, previewUrl: `/preview/${saved.relPath}`, backend: `profile:${imageCfg.profileId}`, prompt };
  }

  async generateImageViaPollinations(prompt, { width, height, seed }) {
    const params = new URLSearchParams({
      width: String(Math.min(2048, Math.max(64, Number(width) || 1024))),
      height: String(Math.min(2048, Math.max(64, Number(height) || 768))),
      nologo: "true",
      ...(seed !== undefined ? { seed: String(seed) } : {}),
    });
    const url = `${POLLINATIONS_IMAGE_URL}${encodeURIComponent(prompt)}?${params}`;
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error("suspiciously small image response");
    const saved = this.saveMedia(buffer, { prompt, ext: ".jpg" });
    return { ok: true, ...saved, previewUrl: `/preview/${saved.relPath}`, backend: "pollinations-free", prompt };
  }

  resolveProfileKey(profile, profileId) {
    try {
      if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) return process.env[profile.apiKeyEnv];
      const keyId = profile.apiKeyProviderId || profileId;
      return this.secretStore?.getProviderKey?.(keyId) || this.secretStore?.get?.(`provider:${keyId}`) || "";
    } catch { return ""; }
  }

  // ── Vision: harness eyes ─────────────────────────────────────────────────

  /**
   * Describe an image as text — the harness's eyes for vision-less models.
   * @param {Object} input - { path | base64, question }
   * @returns {{ok, description, backend}}
   */
  async describeImage({ path: imagePath, base64, mime, question } = {}) {
    let dataUrl;
    if (base64) {
      dataUrl = `data:${mime || "image/png"};base64,${base64}`;
    } else if (imagePath) {
      const abs = path.isAbsolute(imagePath) ? imagePath : path.join(this.rootDir, imagePath);
      if (!fs.existsSync(abs)) return { ok: false, error: true, message: `image not found: ${imagePath}` };
      if (fs.statSync(abs).size > 8 * 1024 * 1024) return { ok: false, error: true, message: "image larger than 8MB" };
      dataUrl = `data:${guessMime(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
    } else {
      return { ok: false, error: true, message: "path or base64 is required" };
    }

    const ask = String(question || "").trim()
      || "Describe this image precisely for someone who cannot see it: layout, text content (transcribe exactly), colors, notable elements, and anything broken or unusual.";
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: ask },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }];

    const errors = [];
    // Accepts only a REAL description — a text-only model's "I can't see
    // images" (HTTP 200) previously came back as ok:true garbage.
    const tryProvider = async (provider, { model, backend } = {}) => {
      const completion = await provider.complete(messages, { model: model || undefined, maxTokens: 900 });
      const text = String(completion?.text || completion?.content || "").trim();
      if (!text) { errors.push(`${backend}: empty response`); return null; }
      if (isBlindRefusal(text)) { errors.push(`${backend}: model is blind (refused the image)`); return null; }
      return { ok: true, description: text, backend };
    };

    // 1. Dedicated vision profile (explicit config wins).
    const visionCfg = this.mediaConfig().vision || {};
    if (visionCfg.profileId && this.configStore && this.secretStore) {
      try {
        const provider = getProvider(this.configStore, this.secretStore, visionCfg.profileId);
        if (provider) {
          const hit = await tryProvider(provider, { model: visionCfg.model, backend: `profile:${visionCfg.profileId}` });
          if (hit) return hit;
        } else {
          errors.push(`vision profile "${visionCfg.profileId}" unavailable`);
        }
      } catch (error) {
        errors.push(`vision profile: ${error.message}`);
      }
    }

    // 2. Active provider, when its model can already see.
    try {
      const active = this.activeProvider();
      const model = String(active?.getInfo?.()?.model || "").toLowerCase();
      if (active && VISION_MODEL_RE.test(model)) {
        const hit = await tryProvider(active, { backend: `active:${model}` });
        if (hit) return hit;
      }
    } catch (error) {
      errors.push(`active provider: ${error.message}`);
    }

    // 3. Any SAVED provider profile with a vision-capable model — zero config:
    //    if the user ever saved a Grok/Gemini/GPT-4o/Qwen-VL profile, it becomes
    //    the harness's eyes automatically (first 3 candidates tried).
    if (this.configStore && this.secretStore) {
      const profiles = this.configStore?.getConfig?.()?.providerProfiles || {};
      const candidates = Object.entries(profiles)
        .filter(([, profile]) => VISION_MODEL_RE.test(String(profile?.model || "").toLowerCase()))
        .slice(0, 3);
      for (const [profileId] of candidates) {
        try {
          const provider = getProvider(this.configStore, this.secretStore, profileId);
          if (!provider) continue;
          const hit = await tryProvider(provider, { backend: `profile-scan:${profileId}` });
          if (hit) return hit;
        } catch (error) {
          errors.push(`profile ${profileId}: ${String(error.message).slice(0, 80)}`);
        }
      }

      // 3b. Gateways that HOST vision models even when the saved profile's own
      //     chat model is text-only (e.g. NVIDIA NIM): same baseUrl + key,
      //     known vision model id.
      const allEndpoints = [
        ...Object.entries(profiles).map(([id, profile]) => ({ id, baseUrl: profile?.baseUrl || "" })),
        { id: "__active__", baseUrl: this.configStore?.getConfig?.()?.provider?.baseUrl || "" },
      ];
      for (const endpoint of allEndpoints) {
        const gateway = KNOWN_GATEWAY_VISION_MODELS.find((g) => g.hostRe.test(endpoint.baseUrl));
        if (!gateway) continue;
        const provider = endpoint.id === "__active__"
          ? this.activeProvider()
          : (() => { try { return getProvider(this.configStore, this.secretStore, endpoint.id); } catch { return null; } })();
        if (!provider) continue;
        for (const model of gateway.models) {
          try {
            const hit = await tryProvider(provider, { model, backend: `gateway:${endpoint.id}:${model}` });
            if (hit) return hit;
          } catch (error) {
            errors.push(`gateway ${model}: ${String(error.message).slice(0, 60)}`);
          }
        }
        break; // one matching gateway is enough
      }
    }

    // 4. Free keyless Pollinations vision — legacy API lost vision support
    //    (2026-07: only "openai-fast", text-only), kept as last resort in case
    //    it returns; blind refusals are rejected, never surfaced as success.
    if (this.allowFreeFallback()) {
      try {
        const response = await this.fetchImpl(POLLINATIONS_TEXT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "openai", messages, max_tokens: 900 }),
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const text = String(data?.choices?.[0]?.message?.content || "").trim();
        if (text && !isBlindRefusal(text)) return { ok: true, description: text, backend: "pollinations-free" };
        throw new Error(text ? "model is blind (refused the image)" : "empty description");
      } catch (error) {
        errors.push(`pollinations: ${error.message}`);
      }
    }

    return {
      ok: false,
      error: true,
      message: `No vision backend could describe the image: ${errors.join("; ") || "none configured"}. Save a provider profile whose model can see images (gemini-*, gpt-4o, qwen-vl, ...) in Settings, or set runtime.media.vision.profileId.`,
    };
  }

  // ── Video generation ─────────────────────────────────────────────────────

  async findFfmpeg() {
    if (this.ffmpegChecked) return this.ffmpegPath;
    this.ffmpegChecked = true;
    for (const candidate of ["ffmpeg", "ffmpeg.exe"]) {
      try {
        await execFileAsync(candidate, ["-version"], { timeout: 8000 });
        this.ffmpegPath = candidate;
        break;
      } catch { /* try next */ }
    }
    return this.ffmpegPath;
  }

  /**
   * Generate a video from a prompt: K keyframe images (scene-varied prompts)
   * assembled with ffmpeg into an mp4 (crossfade slideshow). Without ffmpeg,
   * falls back to an autoplaying HTML slideshow.
   */
  async generateVideo({ prompt, seconds = 8, width = 1280, height = 720, frames } = {}) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) return { ok: false, error: true, message: "prompt is required" };
    const frameCount = Math.min(10, Math.max(3, Number(frames) || Math.ceil(Number(seconds) / 2) || 4));

    // 1. Keyframes — scene-varied prompts so the video has progression.
    const images = [];
    const frameErrors = [];
    for (let i = 0; i < frameCount; i += 1) {
      const framePrompt = `${cleanPrompt} — cinematic still, scene ${i + 1} of ${frameCount}, consistent style`;
      const result = await this.generateImage({ prompt: framePrompt, width, height, seed: 1000 + i });
      if (result.ok) images.push(result);
      else frameErrors.push(result.message);
      if (images.length === 0 && frameErrors.length >= 2) break; // backend is down — stop early
    }
    if (images.length < 2) {
      return { ok: false, error: true, message: `Video needs at least 2 keyframes; got ${images.length}. ${frameErrors[0] || ""}` };
    }

    // 2. ffmpeg assembly → real mp4.
    const ffmpeg = await this.findFfmpeg();
    const secPerFrame = Math.max(1, Math.round((Number(seconds) || 8) / images.length));
    if (ffmpeg) {
      try {
        const dir = this.mediaDir();
        const outName = `${Date.now().toString(36)}-${slugify(cleanPrompt)}.mp4`;
        const outPath = path.join(dir, outName);
        const listPath = path.join(dir, `${outName}.txt`);
        const listBody = images
          .map((img) => `file '${img.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\nduration ${secPerFrame}`)
          .join("\n") + `\nfile '${images[images.length - 1].path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`;
        fs.writeFileSync(listPath, listBody, "utf8");
        await execFileAsync(ffmpeg, [
          "-y", "-f", "concat", "-safe", "0", "-i", listPath,
          "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
          "-r", "30", "-c:v", "libx264", "-preset", "fast", "-movflags", "+faststart",
          outPath,
        ], { timeout: 180000 });
        fs.rmSync(listPath, { force: true });
        const relPath = path.relative(this.rootDir, outPath).replace(/\\/g, "/");
        return {
          ok: true, path: outPath, relPath, previewUrl: `/preview/${relPath}`,
          backend: `keyframes+ffmpeg (${images[0].backend})`, frames: images.length,
          frameImages: images.map((img) => img.relPath),
        };
      } catch (error) {
        // fall through to HTML slideshow
        frameErrors.push(`ffmpeg: ${error.message}`);
      }
    }

    // 3. HTML slideshow fallback — plays like a video in the browser/chat.
    const dir = this.mediaDir();
    const htmlName = `${Date.now().toString(36)}-${slugify(cleanPrompt)}-video.html`;
    const htmlPath = path.join(dir, htmlName);
    const frameSources = images.map((img) => path.basename(img.path));
    fs.writeFileSync(htmlPath, [
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + slugify(cleanPrompt) + "</title>",
      "<style>html,body{margin:0;background:#000;height:100%;display:grid;place-items:center}img{max-width:100vw;max-height:100vh;position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .8s}img.on{opacity:1}</style></head><body>",
      ...frameSources.map((src, i) => `<img src="${src}"${i === 0 ? " class=\"on\"" : ""}>`),
      `<script>const f=document.querySelectorAll('img');let i=0;setInterval(()=>{f[i].classList.remove('on');i=(i+1)%f.length;f[i].classList.add('on');},${secPerFrame * 1000});</script>`,
      "</body></html>",
    ].join("\n"), "utf8");
    const relPath = path.relative(this.rootDir, htmlPath).replace(/\\/g, "/");
    return {
      ok: true, path: htmlPath, relPath, previewUrl: `/preview/${relPath}`,
      backend: `keyframes+html-slideshow (${images[0].backend})`, frames: images.length,
      frameImages: images.map((img) => img.relPath),
      note: "ffmpeg not found — produced an autoplaying HTML slideshow instead of mp4. Install ffmpeg for real video output.",
    };
  }
}

export default MediaEngine;
