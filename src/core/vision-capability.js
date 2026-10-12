// ONE place that answers "can this model look at an image?".
//
// WHY THIS FILE EXISTS: the vision regex used to be duplicated verbatim in
// media-engine.js and omni-loop.js. Two copies of a capability table drift —
// one got the new model families, the other didn't — and the symptom is
// "OmniClaw says the model is blind while the model can obviously see", which is
// very hard to debug. There is now exactly one list.
//
// THE CONTRACT, used by both callers:
//   false  -> the model cannot see. Attachments must be turned into text by a
//             TOOL (describe_image), because nothing else will look at them.
//   true   -> the model can see. Send the image natively as an
//             OpenAI-style content part and let the model look at the real
//             pixels. Calling a tool here is pure waste: the tool would route
//             the image to a DIFFERENT vision model and hand back a lossy text
//             description of something the reader could have seen directly.

import path from "node:path";

// Model families known to accept an image part. Deliberately generous: a false
// positive costs one wasted image part, a false negative costs the model its
// eyes. Keep it in sync by editing THIS file only.
export const VISION_MODEL_RE = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|\bo3\b|\bo4\b|claude|gemini|llava|qwen[.\d-]*vl|pixtral|minicpm-v|internvl|phi-4-multimodal|llama-3\.2[\w-]*vision|llama-4|maverick|scout|grok-(?:2-vision|vision|4)|glm-4v|minimax-vl|nova-(?:lite|pro|premier)|deepseek-vl|step-1v|yi-vision|nemotron[\w-]*vl/;

/** True when a model id looks like it can accept an image input part. */
export function modelLooksVisionCapable(modelId) {
  return VISION_MODEL_RE.test(String(modelId || "").toLowerCase());
}

/**
 * Resolve the vision decision for the ACTIVE chat model.
 *
 * `configured` is `runtime.omniLoop.vision`:
 *   false -> never (the user turned image input off)
 *   true  -> always (the user knows better than a regex; they may be on a proxy)
 *   "auto" (default/undefined) -> ask the model id
 */
export function resolveVisionSupport({ configured, modelId } = {}) {
  if (configured === false) return false;
  if (configured === true) return true;
  return modelLooksVisionCapable(modelId);
}

/** File extension -> image MIME. Falls back to image/png, matching the old helper. */
export function guessImageMime(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".avif") return "image/avif";
  return "image/png";
}

/** Extensions OmniClaw is willing to put in front of a model as an image. */
export const IMAGE_FILE_EXTS = Object.freeze(new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif",
]));