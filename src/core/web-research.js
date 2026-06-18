import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

function decodeEntities(value = "") {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHost(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

const QUERY_STOP_WORDS = new Set([
  "about",
  "research",
  "overview",
  "explain",
  "details",
  "detail",
  "what",
  "with",
  "from",
  "the",
  "and",
  "for",
  "hai",
  "hain",
  "kya",
  "bara",
  "baare",
  "mein",
  "me",
  "par",
  "kar",
  "karo",
  "bata",
  "btaya",
  "deep",
  "official",
  "sources",
  "source",
]);

function getQueryTerms(query = "") {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9.#+-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term));
}

function isComparisonOrOpinionQuery(query = "") {
  return /\b(alternative|alternatives|vs|versus|compare|comparison|review|reviews|opinion|reddit|youtube|best|top)\b/i.test(String(query || ""));
}

function isOfficialLikeSource(result = {}, queryTerms = []) {
  const url = String(result.url || "").toLowerCase();
  const host = normalizeHost(url);
  const text = `${result.title || ""} ${result.snippet || ""} ${url}`.toLowerCase();
  const hostMatchesEntity = queryTerms.some((term) => host.includes(term));
  const hostOrPathMatchesEntity = queryTerms.some((term) => url.includes(term) || host.includes(term));
  if (/^(community|forum|forums|discuss)\./i.test(host)) {
    return false;
  }
  if (/^docs\.|\.docs\.|developer\.|developers\.|docs-|help\.|support\./i.test(host) && hostMatchesEntity) {
    return true;
  }
  if (/\bofficial\b|\bdocs?\b|\bdocumentation\b|\bdeveloper(s)?\b/i.test(text) && hostMatchesEntity) {
    return true;
  }
  if (hostOrPathMatchesEntity && !/medium\.com|reddit\.com|youtube\.com|youtu\.be|quora\.com|substack\.com/i.test(host)) {
    const compactHost = host.replace(/\.(com|ai|io|dev|org|net|app|co|in)$/i, "");
    return queryTerms.some((term) => compactHost.split(".").some((part) => part === term || part.includes(term)));
  }
  return false;
}

export function scoreSearchResult(result = {}, query = "") {
  const text = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
  const queryTerms = getQueryTerms(query);
  const host = normalizeHost(result.url || "");
  const title = String(result.title || "").toLowerCase();
  const url = String(result.url || "").toLowerCase();
  const comparisonQuery = isComparisonOrOpinionQuery(query);
  let score = 0;
  for (const term of queryTerms) {
    if (text.includes(term)) score += 3;
    if (title.includes(term)) score += 3;
    if (String(result.url || "").toLowerCase().includes(term)) score += 2;
  }
  if (isOfficialLikeSource(result, queryTerms)) score += 70;
  if (/docs\.|developer\.|developers\./i.test(host)) score += 14;
  if (/github\.com/i.test(host)) score += 8;
  if (/wikipedia\.org/i.test(host)) score += comparisonQuery ? 8 : 1;
  if (queryTerms.some((term) => host.replace(/^www\./, "").startsWith(term) || host.includes(`${term}.`))) score += 28;
  if (/nodejs\.org/i.test(host)) score += 35;
  if (/\/(docs|documentation|learn|guide|guides|api-reference|readme|wiki)\b/i.test(url)) score += 24;
  if (/github\.com/i.test(host) && /\/(docs|documentation|readme|wiki)\b/i.test(url)) score += 8;
  if (result.snippet && String(result.snippet).length > 80) score += 2;
  if (result.title && String(result.title).length > 8) score += 1;
  if (!comparisonQuery && /\b(alternative|alternatives|vs|versus|comparison|compare|review|reviews|best|top)\b/i.test(`${result.title || ""} ${result.snippet || ""}`)) score -= 45;
  if (!comparisonQuery && /\b(unofficial|independent experimental|free interface|fan-made|third-party)\b/i.test(`${result.title || ""} ${result.snippet || ""} ${url}`)) score -= 85;
  if (!comparisonQuery && /\b(chat|free|apps?|store)\b/i.test(host) && !/\b(chat|free|app|store)\b/i.test(String(query || ""))) score -= 35;
  if (!comparisonQuery && /reddit\.com|youtube\.com|youtu\.be|medium\.com|quora\.com/i.test(host)) score -= 20;
  if (!comparisonQuery && /^(community|forum|forums|discuss)\./i.test(host)) score -= 25;
  if (!comparisonQuery && queryTerms.some((term) => host === `${term}.com` || host === `${term}.ai` || host === `${term}.io` || host === `${term}.dev`)) score += 18;
  if (!comparisonQuery && queryTerms.some((term) => new RegExp(`/(?:${term})(?:/|$|[?#])`, "i").test(String(result.url || "")))) score += 10;
  if (!comparisonQuery && /\bpricing\b/i.test(title) && !/\b(price|pricing|cost|plan)\b/i.test(String(query || ""))) score -= 12;
  const broadOverviewQuery = !comparisonQuery && /\b(overview|official|models?|api|platform|products?|what|kya)\b/i.test(String(query || ""));
  if (broadOverviewQuery && /\/(news|blog|press|release|changelog)\b/i.test(url)) score -= 18;
  if (broadOverviewQuery && /\b(marketplace|catalog|app-store|play\.google|apps\.apple|apps\.make)\b/i.test(url)) score -= 28;
  if (broadOverviewQuery && /\b(video|image|music|audio|speech)\b/i.test(`${title} ${url}`) && !/\b(video|image|music|audio|speech)\b/i.test(String(query || ""))) score -= 18;
  if (broadOverviewQuery && /\/docs\/guides\/models-intro\b/i.test(url)) score += 22;
  if (broadOverviewQuery && /\/docs\/api-reference\/api-overview\b/i.test(url)) score += 18;
  if (broadOverviewQuery && /^https?:\/\/(?:www\.)?[^/]+\.(?:ai|io|com)\/?$/i.test(String(result.url || ""))) score += 16;
  if (/no results|error|timeout|failed/i.test(`${result.title || ""} ${result.snippet || ""}`)) score -= 20;
  return score;
}

function mergeRankedResults(resultSets = [], query = "", maxResults = 8) {
  const byUrl = new Map();
  for (const result of resultSets.flat()) {
    if (!result?.url) continue;
    const normalizedUrl = String(result.url).replace(/#.*$/, "").replace(/\/$/, "");
    const current = byUrl.get(normalizedUrl);
    const next = {
      ...result,
      url: normalizedUrl,
      score: scoreSearchResult(result, query),
      sources: [result.source || "Search"],
    };
    if (!current || next.score > current.score) {
      byUrl.set(normalizedUrl, {
        ...next,
        sources: [...new Set([...(current?.sources || []), ...next.sources])],
      });
    } else {
      current.sources = [...new Set([...(current.sources || []), ...(next.sources || [])])];
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ score, sources, ...result }) => ({
      ...result,
      source: sources?.join(" + ") || result.source || "Search",
    }));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  if (typeof fetch === "function" && typeof AbortController === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        ...options,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,application/json",
          "Accept-Language": "en-US,en;q=0.9",
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const data = await res.text();
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        data,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;
    const req = client.get(url, {
      ...options,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/json",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function searchDuckDuckGo(query, maxResults = 8, timeoutMs = 10000, attempts = []) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "duckduckgo", status: res.status, results: 0 });
      return [];
    }
    const html = res.data;
    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set();
    while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
      let href = match[1];
      if (href.startsWith("//duckduckgo.com")) continue;
      if (href.startsWith("/")) href = `https://duckduckgo.com${href}`;
      if (seen.has(href)) continue;
      seen.add(href);
      const title = match[2].replace(/<[^>]+>/g, "").trim().slice(0, 150);
      if (!title || title.length < 3) continue;
      const pos = match.index;
      const snippetArea = html.substring(pos, pos + 1500);
      const snippetMatch = snippetArea.match(/class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 300) : "";
      results.push({ title, snippet, url: href, source: "DuckDuckGo" });
    }
    attempts.push({ provider: "duckduckgo", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "duckduckgo", error: error.message, results: 0 });
    return [];
  }
}

async function searchBrave(query, apiKey, maxResults = 8, timeoutMs = 10000, attempts = []) {
  if (!apiKey) return [];
  const encoded = encodeURIComponent(query);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "brave", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.web?.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || "",
      snippet: r.description || "",
      url: r.url || "",
      source: "Brave Search",
    }));
    attempts.push({ provider: "brave", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "brave", error: error.message, results: 0 });
    return [];
  }
}

async function searchBing(query, apiKey, maxResults = 8, timeoutMs = 10000, attempts = []) {
  if (!apiKey) return [];
  const encoded = encodeURIComponent(query);
  const url = `https://api.bing.microsoft.com/v7.0/search?q=${encoded}&count=${maxResults}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { "Ocp-Apim-Subscription-Key": apiKey, Accept: "application/json" } }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "bing-api", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.webPages?.value || []).slice(0, maxResults).map((r) => ({
      title: r.name || "",
      snippet: r.snippet || "",
      url: r.url || "",
      source: "Bing",
    }));
    attempts.push({ provider: "bing-api", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "bing-api", error: error.message, results: 0 });
    return [];
  }
}

async function searchBingRss(query, maxResults = 8, timeoutMs = 10000, attempts = []) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/search?format=rss&q=${encoded}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/rss+xml,text/xml" } }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "bing-rss", status: res.status, results: 0 });
      return [];
    }
    const xml = res.data;
    const results = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && results.length < maxResults) {
      const item = match[1];
      const title = decodeEntities((item.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
      const link = decodeEntities((item.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "");
      const snippet = decodeEntities((item.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "");
      if (!title || !link) continue;
      results.push({ title, snippet, url: link, source: "Bing RSS" });
    }
    attempts.push({ provider: "bing-rss", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "bing-rss", error: error.message, results: 0 });
    return [];
  }
}

async function searchGoogle(query, apiKey, cx, maxResults = 8, timeoutMs = 10000, attempts = []) {
  if (!apiKey || !cx) return [];
  const encoded = encodeURIComponent(query);
  const url = `https://www.googleapis.com/customsearch/v1?q=${encoded}&key=${apiKey}&cx=${cx}&num=${Math.min(maxResults, 10)}`;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "google", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.items || []).slice(0, maxResults).map((r) => ({
      title: r.title || "",
      snippet: r.snippet || "",
      url: r.link || "",
      source: "Google Custom Search",
    }));
    attempts.push({ provider: "google", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "google", error: error.message, results: 0 });
    return [];
  }
}

function isLocalOrPrivateHttpTarget(url = "") {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
    if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") return true;
    if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
    const match = hostname.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

function resolveProviderEndpoint(baseUrl = "", suffix = "") {
  const trimmed = String(baseUrl || "").trim();
  if (!trimmed) return suffix;
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

async function searchExa(query, apiKey, maxResults = 8, timeoutMs = 10000, attempts = [], options = {}) {
  if (!apiKey) return [];
  const url = resolveProviderEndpoint(options.baseUrl || "https://api.exa.ai", "/search");
  try {
    const contents = options.contents && typeof options.contents === "object"
      ? options.contents
      : { highlights: { numSentences: 3 } };
    const body = {
      query,
      numResults: Math.max(1, Math.min(100, Number(maxResults) || 8)),
      type: options.type || "auto",
      contents,
    };
    if (options.date_after) body.startPublishedDate = options.date_after;
    if (options.date_before) body.endPublishedDate = options.date_before;
    if (options.freshness && !options.date_after && !options.date_before) {
      const now = new Date();
      const days = { day: 1, week: 7, month: 31, year: 366 }[String(options.freshness).toLowerCase()] || 0;
      if (days > 0) {
        const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        body.startPublishedDate = start.toISOString().slice(0, 10);
      }
    }
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "exa", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.results || []).slice(0, maxResults).map((r) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.filter(Boolean).join(" ") : "";
      const text = typeof r.text === "string" ? r.text : "";
      return {
        title: r.title || r.url || "",
        snippet: highlights || r.summary || text.slice(0, 320) || "",
        url: r.url || "",
        source: "Exa Search",
        publishedDate: r.publishedDate || "",
        author: r.author || "",
        summary: r.summary || "",
        highlights: Array.isArray(r.highlights) ? r.highlights : [],
      };
    });
    attempts.push({ provider: "exa", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "exa", error: error.message, results: 0 });
    return [];
  }
}

async function searchTinyFish(query, apiKey, maxResults = 8, timeoutMs = 10000, attempts = []) {
  if (!apiKey) return [];
  const encoded = encodeURIComponent(query);
  const url = `https://api.search.tinyfish.ai?query=${encoded}&location=US&language=en`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "tinyfish-search", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title || r.site_name || "",
      snippet: r.snippet || "",
      url: r.url || "",
      source: "TinyFish Search",
      position: r.position,
      siteName: r.site_name || "",
    }));
    attempts.push({ provider: "tinyfish-search", status: res.status, results: results.length, totalResults: data.total_results });
    return results;
  } catch (error) {
    attempts.push({ provider: "tinyfish-search", error: error.message, results: 0 });
    return [];
  }
}

function buildSearchQueryVariants(query = "") {
  const base = String(query || "").replace(/\s+/g, " ").trim();
  if (!base || isComparisonOrOpinionQuery(base)) {
    return [base].filter(Boolean);
  }
  return [...new Set([
    base,
    `${base} official documentation`,
    `${base} official site overview`,
  ].map((item) => item.trim()).filter(Boolean))];
}

function withProviderTimeout(promise, { provider = "search", timeoutMs = 12000, attempts = [] } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      attempts.push({ provider, error: `timeout after ${timeoutMs}ms`, results: 0 });
      resolve([]);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function withFetchTimeout(promise, { url = "", provider = "web-fetch", timeoutMs = 30000 } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      url,
      provider,
      error: `timeout after ${timeoutMs}ms`,
      text: "",
      markdown: "",
      truncated: false,
      totalChars: 0,
    }), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function searchGitHubRepos(query, maxResults = 6, timeoutMs = 10000, attempts = []) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.github.com/search/repositories?q=${encoded}&per_page=${Math.min(maxResults, 10)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "OmniClaw-WebResearch",
      },
    }, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "github", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const results = (data.items || []).slice(0, maxResults).map((repo) => ({
      title: repo.full_name || repo.name || "GitHub repository",
      snippet: repo.description || `${repo.stargazers_count || 0} stars, ${repo.language || "unknown"} project on GitHub.`,
      url: repo.html_url || "",
      source: "GitHub Search",
    }));
    attempts.push({ provider: "github", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "github", error: error.message, results: 0 });
    return [];
  }
}

async function searchWikipedia(query, maxResults = 5, timeoutMs = 8000, attempts = []) {
  const encoded = encodeURIComponent(query);
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encoded}&limit=${maxResults}&namespace=0&format=json&origin=*`;
  try {
    const res = await fetchWithTimeout(url, {}, timeoutMs);
    if (!res.ok) {
      attempts.push({ provider: "wikipedia", status: res.status, results: 0 });
      return [];
    }
    const data = JSON.parse(res.data);
    const titles = data[1] || [];
    const descriptions = data[2] || [];
    const links = data[3] || [];
    const results = titles.slice(0, maxResults).map((title, i) => ({
      title,
      snippet: descriptions[i] || "",
      url: links[i] || "",
      source: "Wikipedia",
    }));
    attempts.push({ provider: "wikipedia", status: res.status, results: results.length });
    return results;
  } catch (error) {
    attempts.push({ provider: "wikipedia", error: error.message, results: 0 });
    return [];
  }
}

export class WebResearch {
  constructor(configStore, secretStore) {
    this.configStore = configStore;
    this.secretStore = secretStore;
  }

  getSecretKey(...ids) {
    for (const id of ids) {
      const key = this.secretStore?.getProviderKey?.(id);
      if (key) return key;
    }
    return "";
  }

  getTinyFishKey() {
    return this.getSecretKey("tinyfish", "tinyfish-search", "tinyfish-api", "tinyfish-fetch")
      || process.env.TINYFISH_API_KEY
      || "";
  }

  async search(query, options = {}) {
    const config = this.configStore?.getConfig?.() || {};
    const limit = config.tools?.research?.maxResults || 8;
    const timeoutMs = Math.max(5000, Math.min(15000, Number(config.tools?.research?.timeoutMs || 10000)));
    const maxResults = options.maxResults || limit;
    const attempts = [];
    const queryVariants = buildSearchQueryVariants(query);
    const primaryQuery = queryVariants[0] || query;

    // Get API keys from secrets
    const braveKey = this.secretStore?.getProviderKey?.("brave") || process.env.BRAVE_API_KEY || "";
    const bingKey = this.secretStore?.getProviderKey?.("bing") || process.env.BING_API_KEY || "";
    const googleKey = this.secretStore?.getProviderKey?.("google-search") || process.env.GOOGLE_SEARCH_API_KEY || "";
    const googleCx = config.tools?.research?.googleCx || process.env.GOOGLE_SEARCH_CX || "";
    const tinyFishKey = this.getTinyFishKey();
    const exaKey = this.secretStore?.getProviderKey?.("exa") || process.env.EXA_API_KEY || "";
    const exaBaseUrl = config.tools?.research?.exaBaseUrl || process.env.EXA_BASE_URL || "";

    // Provider priority chain: configured provider → Brave → Bing → Google → DDG → Wikipedia
    const configuredProvider = String(options.provider || config.tools?.research?.provider || "").toLowerCase();
    let results = [];

    // If a specific provider is configured with API key, try it first
    if (configuredProvider === "tinyfish" && tinyFishKey) {
      const tinyFishRuns = await Promise.allSettled(
        queryVariants.map((variant) => withProviderTimeout(
          searchTinyFish(variant, tinyFishKey, maxResults, timeoutMs, attempts),
          { provider: "tinyfish-search", timeoutMs: timeoutMs + 2000, attempts },
        )),
      );
      results = mergeRankedResults(
        tinyFishRuns.filter((item) => item.status === "fulfilled").map((item) => item.value),
        primaryQuery,
        maxResults,
      );
    } else if (configuredProvider === "brave" && braveKey) {
      results = await searchBrave(query, braveKey, maxResults, timeoutMs, attempts);
    } else if (configuredProvider === "exa" && exaKey) {
      results = await searchExa(query, exaKey, maxResults, timeoutMs, attempts, { ...options, baseUrl: exaBaseUrl || options.baseUrl });
    } else if (configuredProvider === "bing" && bingKey) {
      results = await searchBing(query, bingKey, maxResults, timeoutMs, attempts);
    } else if (configuredProvider === "google" && googleKey && googleCx) {
      results = await searchGoogle(query, googleKey, googleCx, maxResults, timeoutMs, attempts);
    }

    // If no results from configured provider, try all available providers in parallel
    if (results.length === 0) {
      const searches = [];

      if (tinyFishKey && configuredProvider !== "tinyfish") {
        for (const variant of queryVariants) {
          searches.push(withProviderTimeout(
            searchTinyFish(variant, tinyFishKey, maxResults, timeoutMs, attempts),
            { provider: "tinyfish-search", timeoutMs: timeoutMs + 2000, attempts },
          ));
        }
      }
      if (braveKey && configuredProvider !== "brave") searches.push(withProviderTimeout(searchBrave(query, braveKey, maxResults, timeoutMs, attempts), { provider: "brave", timeoutMs: timeoutMs + 2000, attempts }));
      if (bingKey && configuredProvider !== "bing") searches.push(withProviderTimeout(searchBing(query, bingKey, maxResults, timeoutMs, attempts), { provider: "bing-api", timeoutMs: timeoutMs + 2000, attempts }));
      if (googleKey && googleCx && configuredProvider !== "google") searches.push(withProviderTimeout(searchGoogle(query, googleKey, googleCx, maxResults, timeoutMs, attempts), { provider: "google-api", timeoutMs: timeoutMs + 2000, attempts }));
      if (exaKey && configuredProvider !== "exa") searches.push(withProviderTimeout(searchExa(query, exaKey, maxResults, timeoutMs, attempts, { ...options, baseUrl: exaBaseUrl || options.baseUrl }), { provider: "exa", timeoutMs: timeoutMs + 2000, attempts }));

      // Free fallback that keeps web search useful when BYOK search keys are not configured.
      searches.push(withProviderTimeout(searchBingRss(query, maxResults, timeoutMs, attempts), { provider: "bing-rss", timeoutMs: timeoutMs + 2000, attempts }));

      // Always try DDG (no API key needed)
      searches.push(withProviderTimeout(searchDuckDuckGo(query, maxResults, timeoutMs, attempts), { provider: "duckduckgo", timeoutMs: timeoutMs + 2000, attempts }));

      // Useful for open-source agent/tooling queries when general web search blocks scraping.
      searches.push(withProviderTimeout(searchGitHubRepos(query, maxResults, timeoutMs, attempts), { provider: "github", timeoutMs: timeoutMs + 2000, attempts }));

      const allResults = await Promise.allSettled(searches);
      results = mergeRankedResults(
        [
          ...allResults
          .filter((result) => result.status === "fulfilled" && Array.isArray(result.value))
          .map((result) => result.value),
        ],
        primaryQuery,
        maxResults,
      );
    }

    // Fallback to Wikipedia if still no results
    if (results.length === 0) {
      results = await searchWikipedia(query, maxResults, timeoutMs, attempts);
    }

    const unique = mergeRankedResults([results], query, maxResults);

    if (unique.length === 0) {
      return {
        query,
        provider: "none",
        attempts,
        results: [{
          title: "No results found",
          snippet: `Web search returned no results for "${query}". Try a different query or provide a specific URL to fetch.`,
          url: "",
          source: "Search",
        }],
      };
    }

    const fetchLimit = Math.max(0, Math.min(8, Number(options.fetchTop ?? config.tools?.research?.fetchTop ?? 5)));
    const fetchCandidates = unique
      .filter((item) => /^https?:\/\//i.test(item.url || ""))
      .slice(0, Math.max(fetchLimit, Math.min(8, maxResults)))
      .map((item, index) => ({
        rank: index + 1,
        title: item.title || "",
        url: item.url || "",
        snippet: item.snippet || "",
        source: item.source || "",
      }));
    const fetchedContent = [];
    if (fetchLimit > 0) {
      const targets = fetchCandidates.slice(0, fetchLimit);
      const fetched = await Promise.allSettled(targets.map((item) => withFetchTimeout(
        this.fetchUrl(item.url, 12000),
        { url: item.url, provider: "web-fetch", timeoutMs: Math.max(25000, timeoutMs + 15000) },
      )));
      for (const item of fetched) {
        if (item.status === "fulfilled") {
          fetchedContent.push(item.value);
        }
      }
      if (!fetchedContent.some((item) => item.text && !item.error)) {
        for (const item of targets) {
          const snippet = String(item.snippet || item.title || "").replace(/\s+/g, " ").trim();
          if (!snippet) continue;
          fetchedContent.push({
            url: item.url,
            status: "search-snippet-fallback",
            contentType: "text/search-result",
            text: snippet,
            truncated: false,
            totalChars: snippet.length,
            fallback: true,
          });
        }
      }
    }

    const cleanContentFetched = fetchedContent.some((item) => item.text && !item.error && !item.fallback);

    return {
      query,
      provider: unique[0]?.source?.toLowerCase().replace(/\s+/g, "-") || "unknown",
      attempts,
      results: unique.slice(0, maxResults),
      fetchCandidates,
      fetchedContent,
      contentFetched: cleanContentFetched,
      nextAction: cleanContentFetched
        ? "Synthesize from fetchedContent and source URLs."
        : "Choose the best fetchCandidates URL and call read_url or web_fetch; do not finalize from snippets only unless all fetches fail.",
    };
  }

  async fetchUrl(url, maxChars = 5000) {
    const timeoutMs = Math.max(10000, Math.min(45000, Number(this.configStore?.getConfig?.()?.tools?.research?.fetchTimeoutMs || this.configStore?.getConfig?.()?.tools?.research?.timeoutMs || 30000)));
    const tinyFishKey = this.getTinyFishKey();
    const attempts = [];
    if (tinyFishKey && /^https?:\/\//i.test(String(url || "")) && !isLocalOrPrivateHttpTarget(url)) {
      const tinyFish = await this.fetchUrlWithTinyFish(url, maxChars, tinyFishKey, timeoutMs);
      attempts.push({
        provider: "tinyfish-fetch",
        ok: Boolean(tinyFish.text && !tinyFish.error),
        error: tinyFish.error || "",
        chars: tinyFish.totalChars || 0,
      });
      if (tinyFish.text && !tinyFish.error) {
        return {
          ...tinyFish,
          attempts,
          markdown: tinyFish.text,
        };
      }
    }

    try {
      const res = await fetchWithTimeout(url, {}, timeoutMs);
      if (!res.ok) return { url, error: `HTTP ${res.status}`, text: "", truncated: false, totalChars: 0 };
      const text = res.data
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        url,
        finalUrl: url,
        provider: "http-fetch",
        status: res.status,
        contentType: res.headers["content-type"] || "unknown",
        text: text.slice(0, maxChars),
        markdown: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        totalChars: text.length,
        attempts: [
          ...attempts,
          { provider: "http-fetch", ok: true, status: res.status, chars: text.length },
        ],
      };
    } catch (error) {
      return {
        url,
        provider: "http-fetch",
        error: error.message,
        text: "",
        markdown: "",
        truncated: false,
        totalChars: 0,
        attempts: [...attempts, { provider: "http-fetch", ok: false, error: error.message }],
      };
    }
  }

  async fetchUrlWithTinyFish(url, maxChars = 12000, apiKey, timeoutMs = 30000) {
    try {
      const res = await fetchWithTimeout("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          urls: [String(url || "").trim()],
          format: "markdown",
          links: false,
          image_links: false,
        }),
      }, Math.max(10000, Math.min(45000, timeoutMs)));
      if (!res.ok) {
        return { url, error: `TinyFish Fetch HTTP ${res.status}`, provider: "tinyfish-fetch", text: "", truncated: false, totalChars: 0 };
      }
      const data = JSON.parse(res.data);
      const page = (data.results || [])[0];
      const pageError = (data.errors || []).find((item) => item.url === url) || (data.errors || [])[0];
      if (!page) {
        return {
          url,
          error: pageError?.error || "TinyFish Fetch returned no page content.",
          provider: "tinyfish-fetch",
          text: "",
          truncated: false,
          totalChars: 0,
        };
      }
      const text = typeof page.text === "string" ? page.text : JSON.stringify(page.text || "");
      return {
        url: page.url || url,
        finalUrl: page.final_url || page.url || url,
        title: page.title || "",
        description: page.description || "",
        status: 200,
        contentType: `text/${page.format || "markdown"}`,
        provider: "tinyfish-fetch",
        text: text.slice(0, maxChars),
        markdown: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        totalChars: text.length,
        latencyMs: page.latency_ms || null,
      };
    } catch (error) {
      return { url, error: `TinyFish Fetch failed: ${error.message}`, provider: "tinyfish-fetch", text: "", truncated: false, totalChars: 0 };
    }
  }
}
