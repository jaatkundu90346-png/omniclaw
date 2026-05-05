import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";

/**
 * Lightweight browser operator that fetches URL content 
 * and performs basic HTML to Markdown conversion without heavy dependencies.
 */
export class BrowserOperator {
  constructor() {
    this.maxBytes = 200_000; // Limit to 200KB to stay lightweight
  }

  async readUrl(url) {
    try {
      const html = await this.fetchHtml(url);
      const markdown = this.htmlToMarkdown(html);
      return {
        url,
        content: markdown,
        length: markdown.length,
        status: "success"
      };
    } catch (error) {
      return {
        url,
        error: error.message,
        status: "error"
      };
    }
  }

  openUrl(url) {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("Browser URL must start with http:// or https://");
    }
    const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      opened: true,
      url: target,
      app: process.platform === "win32" ? "default Windows browser" : "default browser",
    };
  }

  fetchHtml(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const req = client.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OmniClaw/1.0"
        }
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Status Code: ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > this.maxBytes) {
            req.destroy();
            resolve(data + "\n\n... (content truncated)");
          }
        });
        res.on("end", () => resolve(data));
      });

      req.on("error", (err) => reject(err));
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
    });
  }

  htmlToMarkdown(html) {
    let text = html;

    // Remove scripts and styles
    text = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "");
    text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "");

    // Basic tags to MD
    text = text.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gmi, (m, c) => `\n## ${c.trim()}\n`);
    text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gmi, (m, c) => `\n${c.trim()}\n`);
    text = text.replace(/<br\s*\/?>/gmi, "\n");
    text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gmi, (m, c) => `* ${c.trim()}\n`);
    
    // Strip all other tags
    text = text.replace(/<[^>]+>/g, "");

    // Decode entities
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&quot;/g, '"');

    // Clean up whitespace
    text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
    
    return text.trim();
  }
}
