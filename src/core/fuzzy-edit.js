// Fuzzy find/replace for the edit tools — ported from Hermes' multi-strategy
// matcher (itself inspired by OpenCode). The model's copied `find` text is
// frequently NOT byte-exact (indentation drift, collapsed whitespace, smart
// quotes from transport, literal "\n" escapes). Exact-match-only edits fail on
// all of those and the agent gets stuck "can't edit the file". This tries a
// chain of increasingly lenient strategies and only ever replaces a concrete
// span of the ORIGINAL content, so the file is never corrupted.

const UNICODE_MAP = {
  "“": '"', "”": '"',   // smart double quotes
  "‘": "'", "’": "'",   // smart single quotes
  "—": "--", "–": "-",  // em / en dashes
  "…": "...", " ": " ", // ellipsis / non-breaking space
};

function unicodeNormalize(text) {
  let out = text;
  for (const [from, to] of Object.entries(UNICODE_MAP)) {
    out = out.split(from).join(to);
  }
  return out;
}

// All matches of an exact substring, as [start, end) spans.
function exactSpans(content, pattern) {
  const spans = [];
  if (!pattern) return spans;
  let from = 0;
  for (;;) {
    const pos = content.indexOf(pattern, from);
    if (pos === -1) break;
    spans.push([pos, pos + pattern.length]);
    from = pos + 1; // allow overlaps; uniqueness is enforced by the caller
  }
  return spans;
}

// Match whole-line blocks after applying `normLine` to every line on both
// sides. Returns spans over the ORIGINAL content (covering the matched block,
// excluding the trailing newline so replacement keeps it).
function lineWindowSpans(content, pattern, normLine) {
  const contentLines = content.split("\n");
  const patternLines = pattern.split("\n");
  const plen = patternLines.length;
  if (plen === 0 || plen > contentLines.length) return [];

  const normPattern = patternLines.map(normLine).join("\n");

  // Precompute char offset of each content line start.
  const lineStart = new Array(contentLines.length);
  let off = 0;
  for (let i = 0; i < contentLines.length; i += 1) {
    lineStart[i] = off;
    off += contentLines[i].length + 1; // +1 for the "\n"
  }

  const spans = [];
  for (let i = 0; i + plen <= contentLines.length; i += 1) {
    const window = contentLines.slice(i, i + plen).map(normLine).join("\n");
    if (window === normPattern) {
      const start = lineStart[i];
      const last = i + plen - 1;
      const end = lineStart[last] + contentLines[last].length;
      spans.push([start, end]);
    }
  }
  return spans;
}

const STRATEGIES = [
  ["exact", (c, p) => exactSpans(c, p)],
  ["line_trimmed", (c, p) => lineWindowSpans(c, p, (l) => l.trim())],
  ["whitespace_normalized", (c, p) => lineWindowSpans(c, p, (l) => l.replace(/[ \t]+/g, " ").trim())],
  ["indentation_flexible", (c, p) => lineWindowSpans(c, p, (l) => l.replace(/^[ \t]+/, ""))],
  ["escape_normalized", (c, p) => {
    const unescaped = p.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
    return unescaped === p ? [] : exactSpans(c, unescaped);
  }],
  ["unicode_normalized", (c, p) => {
    const nc = unicodeNormalize(c);
    const np = unicodeNormalize(p);
    if (nc === c && np === p) return [];
    // Match on the normalized copies line-by-line, then re-find the matched
    // original block by index in the line grid (safe because line counts are
    // preserved by unicode normalization — it never adds/removes newlines).
    return lineWindowSpans(c, np, (l) => unicodeNormalize(l).trim());
  }],
];

function applyReplacements(content, spans, replacement) {
  // Replace from the end so earlier offsets stay valid.
  const sorted = [...spans].sort((a, b) => b[0] - a[0]);
  let out = content;
  for (const [start, end] of sorted) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

// Returns { content, matchCount, occurrences, strategy, error }. `occurrences`
// is the raw number of places the find text was located (even when the edit is
// rejected for ambiguity); `matchCount` is how many were actually replaced.
function fuzzyFindAndReplace(content, find, replace, replaceAll = false) {
  if (!find) return { content, matchCount: 0, occurrences: 0, strategy: null, error: "find text is required." };
  if (find === replace) return { content, matchCount: 0, occurrences: 0, strategy: null, error: "find and replace are identical." };

  for (const [name, fn] of STRATEGIES) {
    const spans = fn(content, find);
    if (!spans.length) continue;
    if (spans.length > 1 && !replaceAll) {
      return {
        content,
        matchCount: 0,
        occurrences: spans.length,
        strategy: name,
        error: `Find text matches ${spans.length} places in the file (via ${name}). Add surrounding context to make it unique, or pass replaceAll=true.`,
      };
    }
    return { content: applyReplacements(content, spans, replace), matchCount: spans.length, occurrences: spans.length, strategy: name, error: null };
  }
  return { content, matchCount: 0, occurrences: 0, strategy: null, error: "Find text not found in file (tried exact + fuzzy matching)." };
}

// "Did you mean?" — when nothing matched, surface the closest block in the file
// so the model can correct its `find` instead of blindly retrying stale text.
function findClosestSnippet(find, content, { maxLines = 12 } = {}) {
  const patternLines = String(find || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!patternLines.length) return "";
  // Anchor on the LONGEST pattern line, not the first: a generic first line
  // like "};" matches nothing distinctive and the "Did you mean?" hint never
  // fired exactly when the model needed it.
  const anchor = patternLines.reduce((best, line) => (line.length > best.length ? line : best), "");
  if (anchor.length < 4) return "";
  const contentLines = content.split("\n");

  // Character-bigram Dice coefficient in [0,1] — robust to typos and small
  // edits (e.g. "retrun nme" vs "return name"), unlike token overlap.
  const bigrams = (s) => {
    const t = s.toLowerCase();
    const set = new Map();
    for (let i = 0; i < t.length - 1; i += 1) {
      const bg = t.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const score = (a, b) => {
    const ba = bigrams(a);
    const bb = bigrams(b);
    if (!ba.size || !bb.size) return 0;
    let inter = 0;
    for (const [bg, n] of ba) inter += Math.min(n, bb.get(bg) || 0);
    return (2 * inter) / (a.length - 1 + (b.length - 1));
  };

  let best = { idx: -1, s: 0 };
  for (let i = 0; i < contentLines.length; i += 1) {
    const s = score(anchor, contentLines[i].trim());
    if (s > best.s) best = { idx: i, s };
  }
  if (best.idx === -1 || best.s < 0.4) return "";
  const start = Math.max(0, best.idx - 1);
  const end = Math.min(contentLines.length, best.idx + Math.min(maxLines, patternLines.length + 2));
  return contentLines
    .slice(start, end)
    .map((l, k) => `${start + k + 1}\t${l}`)
    .join("\n");
}

export { fuzzyFindAndReplace, findClosestSnippet, unicodeNormalize };
