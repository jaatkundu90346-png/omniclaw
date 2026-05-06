function normalizeWikipediaResults(data, limit) {
  const titles = data?.[1] || [];
  const descriptions = data?.[2] || [];
  const links = data?.[3] || [];

  return titles.slice(0, limit).map((title, index) => ({
    title,
    snippet: descriptions[index] || "",
    url: links[index] || "",
    source: "Wikipedia",
  }));
}

async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "OmniClaw/0.1 research",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class WebResearch {
  constructor(configStore) {
    this.configStore = configStore;
  }

  async search(query) {
    const config = this.configStore.getConfig();
    const limit = config.tools.research.maxResults;
    const timeoutMs = Number(config.tools.research.timeoutMs || 10000);
    const encoded = encodeURIComponent(query);
    const results = [];

    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
      const ddgData = await fetchJsonWithTimeout(ddgUrl, timeoutMs);

      if (ddgData.AbstractText || ddgData.AbstractURL) {
        results.push({
          title: ddgData.Heading || query,
          snippet: ddgData.AbstractText || "",
          url: ddgData.AbstractURL || "",
          source: "DuckDuckGo Instant Answer",
        });
      }

      for (const topic of ddgData.RelatedTopics || []) {
        if (results.length >= limit) {
          break;
        }

        if (topic.Text || topic.FirstURL) {
          results.push({
            title: topic.Text || topic.FirstURL || "Related topic",
            snippet: topic.Text || "",
            url: topic.FirstURL || "",
            source: "DuckDuckGo Related Topic",
          });
        }

        for (const child of topic.Topics || []) {
          if (results.length >= limit) {
            break;
          }
          results.push({
            title: child.Text || child.FirstURL || "Related topic",
            snippet: child.Text || "",
            url: child.FirstURL || "",
            source: "DuckDuckGo Related Topic",
          });
        }
      }
    } catch (error) {
      results.push({
        title: "DuckDuckGo request failed",
        snippet: error.message,
        url: "",
        source: "DuckDuckGo Error",
      });
    }

    if (results.length >= limit) {
      return {
        query,
        provider: "duckduckgo",
        results: results.slice(0, limit),
      };
    }

    let wikiResults = [];
    try {
      const wikiUrl =
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encoded}` +
        `&limit=${limit}&namespace=0&format=json&origin=*`;
      const wikiData = await fetchJsonWithTimeout(wikiUrl, timeoutMs);
      wikiResults = normalizeWikipediaResults(wikiData, limit);
    } catch (error) {
      wikiResults = [
        {
          title: "Wikipedia request failed",
          snippet: error.message,
          url: "",
          source: "Wikipedia Error",
        },
      ];
    }

    return {
      query,
      provider: results.length > 0 ? "duckduckgo+wikipedia" : "wikipedia",
      results: [...results, ...wikiResults].slice(0, limit),
    };
  }

  // ─── HTML Search (DuckDuckGo Lite) ────────────────────────────
  async searchHtml(query, maxResults = 8) {
    const encoded = encodeURIComponent(query);
    const url = `https://lite.duckduckgo.com/lite/?q=${encoded}&kl=wt-wt`;
    const timeoutMs = Number(this.configStore?.getConfig?.()?.tools?.research?.timeoutMs || 10000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OmniClaw/0.1)",
          Accept: "text/html",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      // Parse results from DDG Lite HTML
      const results = [];
      const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
      
      // Fallback: parse any links with snippets
      const rows = html.split(/<tr[^>]*>/);
      for (const row of rows) {
        if (results.length >= maxResults) break;
        const linkMatch = row.match(/href="(https?:\/\/[^"]+)"/);
        const titleMatch = row.match(/<a[^>]*>([\s\S]*?)<\/a>/);
        if (linkMatch && titleMatch) {
          const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
          const href = linkMatch[1];
          if (!title || href.includes("duckduckgo.com")) continue;
          const snippetMatch = row.match(/class="result-snippet"[\s\S]*?>([\s\S]*?)<\/td>/);
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
          results.push({ title, snippet: snippet.slice(0, 300), url: href, source: "DuckDuckGo" });
        }
      }
      return { query, provider: "duckduckgo-html", results };
    } catch (error) {
      return { query, provider: "duckduckgo-html", results: [{ title: "Search failed", snippet: error.message, url: "", source: "Error" }] };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── URL Fetch ────────────────────────────────────────────────
  async fetchUrl(url, maxChars = 5000) {
    const timeoutMs = Number(this.configStore?.getConfig?.()?.tools?.research?.timeoutMs || 10000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "OmniClaw/0.1 research", Accept: "text/html,text/plain,application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      // Simple text extraction: strip HTML tags if present
      const cleaned = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        url,
        status: response.status,
        contentType: response.headers.get("content-type") || "unknown",
        text: cleaned.slice(0, maxChars),
        truncated: cleaned.length > maxChars,
        totalChars: cleaned.length,
      };
    } catch (error) {
      return { url, error: error.message, text: "", truncated: false, totalChars: 0 };
    } finally {
      clearTimeout(timer);
    }
  }
}