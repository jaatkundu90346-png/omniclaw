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
}
