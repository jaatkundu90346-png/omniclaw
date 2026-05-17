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

  async search(query, options = {}) {
    const config = this.configStore?.getConfig?.() || {};
    const limit = config.tools?.research?.maxResults || 8;
    const timeoutMs = Math.max(25000, Number(config.tools?.research?.timeoutMs || 10000));
    const maxResults = options.maxResults || limit;
    const attempts = [];

    // Get API keys from secrets
    const braveKey = this.secretStore?.getProviderKey?.("brave") || process.env.BRAVE_API_KEY || "";
    const bingKey = this.secretStore?.getProviderKey?.("bing") || process.env.BING_API_KEY || "";
    const googleKey = this.secretStore?.getProviderKey?.("google-search") || process.env.GOOGLE_SEARCH_API_KEY || "";
    const googleCx = config.tools?.research?.googleCx || process.env.GOOGLE_SEARCH_CX || "";

    // Provider priority chain: configured provider → Brave → Bing → Google → DDG → Wikipedia
    const configuredProvider = config.tools?.research?.provider || "";
    let results = [];

    // If a specific provider is configured with API key, try it first
    if (configuredProvider === "brave" && braveKey) {
      results = await searchBrave(query, braveKey, maxResults, timeoutMs, attempts);
    } else if (configuredProvider === "bing" && bingKey) {
      results = await searchBing(query, bingKey, maxResults, timeoutMs, attempts);
    } else if (configuredProvider === "google" && googleKey && googleCx) {
      results = await searchGoogle(query, googleKey, googleCx, maxResults, timeoutMs, attempts);
    }

    // If no results from configured provider, try all available providers in parallel
    if (results.length === 0) {
      const searches = [];

      if (braveKey) searches.push(searchBrave(query, braveKey, maxResults, timeoutMs, attempts));
      if (bingKey) searches.push(searchBing(query, bingKey, maxResults, timeoutMs, attempts));
      if (googleKey && googleCx) searches.push(searchGoogle(query, googleKey, googleCx, maxResults, timeoutMs, attempts));

      // Free fallback that keeps web search useful when BYOK search keys are not configured.
      searches.push(searchBingRss(query, maxResults, timeoutMs, attempts));

      // Always try DDG (no API key needed)
      searches.push(searchDuckDuckGo(query, maxResults, timeoutMs, attempts));

      // Useful for open-source agent/tooling queries when general web search blocks scraping.
      searches.push(searchGitHubRepos(query, maxResults, timeoutMs, attempts));

      const allResults = await Promise.allSettled(searches);
      for (const result of allResults) {
        if (result.status === "fulfilled" && result.value.length > 0) {
          results = result.value;
          break;
        }
      }
    }

    // Fallback to Wikipedia if still no results
    if (results.length === 0) {
      results = await searchWikipedia(query, maxResults, timeoutMs, attempts);
    }

    // Deduplicate by URL
    const seenUrls = new Set();
    const unique = [];
    for (const r of results) {
      if (r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        unique.push(r);
      }
    }

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

    return {
      query,
      provider: unique[0]?.source?.toLowerCase().replace(/\s+/g, "-") || "unknown",
      attempts,
      results: unique.slice(0, maxResults),
    };
  }

  async fetchUrl(url, maxChars = 5000) {
    const timeoutMs = Number(this.configStore?.getConfig?.()?.tools?.research?.timeoutMs || 10000);
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
        status: res.status,
        contentType: res.headers["content-type"] || "unknown",
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        totalChars: text.length,
      };
    } catch (error) {
      return { url, error: error.message, text: "", truncated: false, totalChars: 0 };
    }
  }
}
