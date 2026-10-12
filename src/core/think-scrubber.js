// Streaming reasoning/thinking-tag scrubber.
//
// JS port of Hermes's agent/think_scrubber.py (MIT). Some models stream their
// chain-of-thought INSIDE the visible `content` channel wrapped in tags like
// <think>...</think> (MiniMax, DeepSeek-R1 via some gateways, Qwen, GLM),
// instead of the separate `reasoning_content` field OmniClaw already routes to
// the thinking bubble. A naive per-delta regex strip leaks reasoning when a tag
// is split across stream deltas (delta1="<think>", delta2="...", delta3=
// "</think>"). This stateful scrubber holds back partial tags at delta
// boundaries so reasoning never leaks into the user-visible answer.
//
// Usage:
//   const s = new StreamingThinkScrubber();
//   for (const delta of stream) { const v = s.feed(delta); if (v) emit(v); }
//   const tail = s.flush(); if (tail) emit(tail);
// Call reset() at the top of each new turn.

const OPEN_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "REASONING_SCRATCHPAD"];
const OPEN_TAGS = OPEN_TAG_NAMES.map((n) => `<${n}>`);
const CLOSE_TAGS = OPEN_TAG_NAMES.map((n) => `</${n}>`);
const MAX_TAG_LEN = Math.max(...OPEN_TAGS.concat(CLOSE_TAGS).map((t) => t.length));

function findFirstTag(buf, tags) {
  const lower = buf.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const tag of tags) {
    const idx = lower.indexOf(tag.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestLen = tag.length;
    }
  }
  return [bestIdx, bestLen];
}

function maxPartialSuffix(buf, tags) {
  if (!buf) return 0;
  const lower = buf.toLowerCase();
  const maxCheck = Math.min(lower.length, MAX_TAG_LEN - 1);
  for (let i = maxCheck; i > 0; i -= 1) {
    const suffix = lower.slice(-i);
    for (const tag of tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower.length > i && tagLower.startsWith(suffix)) return i;
    }
  }
  return 0;
}

function stripOrphanCloseTags(text) {
  if (!text.includes("</")) return text;
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  while (i < text.length) {
    let matched = false;
    if (lower.slice(i, i + 2) === "</") {
      for (const tag of CLOSE_TAGS) {
        const tagLower = tag.toLowerCase();
        const tagLen = tagLower.length;
        if (lower.slice(i, i + tagLen) === tagLower) {
          let j = i + tagLen;
          while (j < text.length && " \t\n\r".includes(text[j])) j += 1;
          i = j;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

export class StreamingThinkScrubber {
  constructor() {
    this._inBlock = false;
    this._buf = "";
    this._lastEmittedEndedNewline = true;
  }

  reset() {
    this._inBlock = false;
    this._buf = "";
    this._lastEmittedEndedNewline = true;
  }

  _findEarliestClosedPair(buf) {
    const lower = buf.toLowerCase();
    let best = null;
    for (let k = 0; k < OPEN_TAGS.length; k += 1) {
      const openLower = OPEN_TAGS[k].toLowerCase();
      const closeLower = CLOSE_TAGS[k].toLowerCase();
      const openIdx = lower.indexOf(openLower);
      if (openIdx === -1) continue;
      const closeIdx = lower.indexOf(closeLower, openIdx + openLower.length);
      if (closeIdx === -1) continue;
      const endIdx = closeIdx + closeLower.length;
      if (best === null || openIdx < best[0]) best = [openIdx, endIdx];
    }
    return best;
  }

  _isBlockBoundary(buf, idx, alreadyEmitted) {
    if (idx === 0) {
      if (alreadyEmitted.length) return alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n");
      return this._lastEmittedEndedNewline;
    }
    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf("\n");
    if (lastNl === -1) {
      const priorNewline = alreadyEmitted.length
        ? alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n")
        : this._lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === "";
    }
    return preceding.slice(lastNl + 1).trim() === "";
  }

  _findOpenAtBoundary(buf, alreadyEmitted) {
    const lower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      for (;;) {
        const idx = lower.indexOf(tagLower, searchStart);
        if (idx === -1) break;
        if (this._isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break;
        }
        searchStart = idx + 1;
      }
    }
    return [bestIdx, bestLen];
  }

  feed(text) {
    if (!text) return "";
    let buf = this._buf + text;
    this._buf = "";
    const out = [];

    while (buf) {
      if (this._inBlock) {
        const [closeIdx, closeLen] = findFirstTag(buf, CLOSE_TAGS);
        if (closeIdx === -1) {
          const held = maxPartialSuffix(buf, CLOSE_TAGS);
          this._buf = held ? buf.slice(-held) : "";
          return out.join("");
        }
        buf = buf.slice(closeIdx + closeLen);
        this._inBlock = false;
      } else {
        const pair = this._findEarliestClosedPair(buf);
        const [openIdx, openLen] = this._findOpenAtBoundary(buf, out);

        if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
          const [startIdx, endIdx] = pair;
          let preceding = buf.slice(0, startIdx);
          if (preceding) {
            preceding = stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this._lastEmittedEndedNewline = preceding.endsWith("\n");
            }
          }
          buf = buf.slice(endIdx);
          continue;
        }

        if (openIdx !== -1) {
          let preceding = buf.slice(0, openIdx);
          if (preceding) {
            preceding = stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this._lastEmittedEndedNewline = preceding.endsWith("\n");
            }
          }
          this._inBlock = true;
          buf = buf.slice(openIdx + openLen);
          continue;
        }

        const heldOpen = maxPartialSuffix(buf, OPEN_TAGS);
        const heldClose = maxPartialSuffix(buf, CLOSE_TAGS);
        const held = Math.max(heldOpen, heldClose);
        let emitText;
        if (held) {
          emitText = buf.slice(0, -held);
          this._buf = buf.slice(-held);
        } else {
          emitText = buf;
          this._buf = "";
        }
        if (emitText) {
          emitText = stripOrphanCloseTags(emitText);
          if (emitText) {
            out.push(emitText);
            this._lastEmittedEndedNewline = emitText.endsWith("\n");
          }
        }
        return out.join("");
      }
    }
    return out.join("");
  }

  flush() {
    if (this._inBlock) {
      this._buf = "";
      this._inBlock = false;
      return "";
    }
    let tail = this._buf;
    this._buf = "";
    if (!tail) return "";
    tail = stripOrphanCloseTags(tail);
    if (tail) this._lastEmittedEndedNewline = tail.endsWith("\n");
    return tail;
  }
}

// Convenience for complete (non-streamed) strings: strip closed reasoning
// pairs and orphan close tags in one pass via the same state machine.
export function scrubThinkTags(text) {
  if (!text || typeof text !== "string") return text;
  if (!/[<]\/?\s*(?:think|thinking|reasoning|thought|reasoning_scratchpad)\b/i.test(text)) {
    return text;
  }
  const s = new StreamingThinkScrubber();
  return (s.feed(text) + s.flush());
}
