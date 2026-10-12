// Smoke test: HTML entity decoding for web research text (iteration 18).
// Bug: fetchUrl's http-fetch path stripped tags but never decoded entities, so
// page text kept raw "&amp;", "&#39;", "&nbsp;", "&rsquo;" — wasting tokens and
// garbling what the model reads. Fix: decodeHtmlEntities (named + numeric),
// applied in the http-fetch path and the RSS decodeEntities helper.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { decodeHtmlEntities, decodeEntities } = await import(pathToFileURL(path.join(ROOT, "src/core/web-research.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

// ── decodeHtmlEntities: named ───────────────────────────────────────────────
check("&amp; -> &", decodeHtmlEntities("Tom &amp; Jerry") === "Tom & Jerry");
check("&lt;/&gt; -> </>", decodeHtmlEntities("a &lt;b&gt; c") === "a <b> c");
check("&quot; -> \"", decodeHtmlEntities("say &quot;hi&quot;") === 'say "hi"');
check("&nbsp; -> space", decodeHtmlEntities("a&nbsp;b") === "a b");
check("&rsquo; -> curly apostrophe", decodeHtmlEntities("it&rsquo;s") === "it’s");
check("&mdash; -> em dash", decodeHtmlEntities("a&mdash;b") === "a—b");
check("&hellip; -> ellipsis", decodeHtmlEntities("wait&hellip;") === "wait…");

// ── decodeHtmlEntities: numeric decimal + hex ───────────────────────────────
check("&#39; -> apostrophe", decodeHtmlEntities("it&#39;s") === "it's");
check("&#8217; -> curly apostrophe", decodeHtmlEntities("it&#8217;s") === "it’s");
check("&#x27; -> apostrophe (hex)", decodeHtmlEntities("it&#x27;s") === "it's");
check("&#x2014; -> em dash (hex)", decodeHtmlEntities("a&#x2014;b") === "a—b");

// ── Unknown / malformed entities are left untouched (no data loss) ──────────
check("unknown entity preserved", decodeHtmlEntities("A&fakeent;B") === "A&fakeent;B");
check("bare ampersand preserved", decodeHtmlEntities("R&D budget") === "R&D budget");
check("out-of-range numeric preserved", decodeHtmlEntities("x&#9999999999;y") === "x&#9999999999;y");

// ── decodeEntities: html fragment -> clean plain text ───────────────────────
check("strips tags AND decodes entities",
  decodeEntities("<p>Tom &amp; Jerry&#39;s <b>show</b></p>") === "Tom & Jerry's show",
  decodeEntities("<p>Tom &amp; Jerry&#39;s <b>show</b></p>"));
check("entity-encoded angle brackets survive tag-strip (decode after strip)",
  decodeEntities("use &lt;div&gt; here") === "use <div> here",
  decodeEntities("use &lt;div&gt; here"));
check("CDATA unwrapped", decodeEntities("<![CDATA[Hello &amp; bye]]>") === "Hello & bye");

// ── Simulated tag-stripped page text (the real http-fetch scenario) ─────────
const rawPageText = "News &amp; Analysis&nbsp;&mdash; it&rsquo;s here &#8230; R&amp;D up 5&#37;";
const cleaned = decodeHtmlEntities(rawPageText).replace(/\s+/g, " ").trim();
check("realistic page text fully decoded, no raw entities left",
  !/&(#x?[0-9a-f]+|[a-z]+);/i.test(cleaned) && cleaned.includes("News & Analysis") && cleaned.includes("it’s"),
  cleaned);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
