const fs = require('fs');
let code = fs.readFileSync('public/app.js', 'utf8');

// 1. EventSource update
code = code.replace(
  'eventStream = new EventSource("/api/events");',
  `const tokenInput = document.querySelector("#gw-token");
  const token = tokenInput ? tokenInput.value.trim() : "";
  const url = token ? \`/api/events?token=\${encodeURIComponent(token)}\` : "/api/events";
  eventStream = new EventSource(url);`
);

// 2. safeFetch update
code = code.replace(
  'async function safeFetch(url, options = {}, retries = 1) {',
  `async function safeFetch(url, options = {}, retries = 1) {
  const tokenInput = document.querySelector("#gw-token");
  const token = tokenInput ? tokenInput.value.trim() : "";
  if (token) {
    options.headers = options.headers || {};
    options.headers["Authorization"] = \`Bearer \${token}\`;
  }`
);

// 3. Global fetch override (so we don't have to rewrite 30 lines)
// We add this right after imports
code = code.replace(
  'const form = document.querySelector("#chat-form");',
  `const originalFetch = window.fetch;
window.fetch = async function (resource, options = {}) {
  const tokenInput = document.querySelector("#gw-token");
  const token = tokenInput ? tokenInput.value.trim() : "";
  if (token) {
    options.headers = options.headers || {};
    if (options.headers instanceof Headers) {
      options.headers.set("Authorization", \`Bearer \${token}\`);
    } else {
      options.headers["Authorization"] = \`Bearer \${token}\`;
    }
  }
  return originalFetch.call(this, resource, options);
};

const form = document.querySelector("#chat-form");`
);

// 4. Chat form streaming update
// We replace the fetch("/api/chat") block
const chatFetchRegex = /const response = await fetch\("\/api\/chat", \{[\s\S]*?body: JSON\.stringify\(payload\),\s*signal: activeChatController\.signal,\s*\}\);[\s\S]*?const data = await response\.json\(\);[\s\S]*?chatOutput\.textContent = formatChatResponse\(data\);/m;

const replacement = `const tokenInput = document.querySelector("#gw-token");
    const token = tokenInput ? tokenInput.value.trim() : "";
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = \`Bearer \${token}\`;

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: activeChatController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(\`Stream failed: \${response.status} \${errText}\`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data = {};
    
    chatOutput.textContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "token") {
              chatOutput.textContent += event.content;
            } else if (event.type === "done") {
              data = event.data || {};
              chatOutput.textContent = formatChatResponse(data);
            } else if (event.type === "error") {
              throw new Error(event.error || "Unknown stream error");
            }
          } catch (err) {
            // ignore JSON parse errors for incomplete chunks
          }
        }
      }
    }

    if (data.run?.id) {
      activeRunId = data.run.id;
      renderLiveRunTimeline("Run completed.");
    }`;

code = code.replace(chatFetchRegex, replacement);

fs.writeFileSync('public/app.js', code);
console.log("Patched public/app.js");
