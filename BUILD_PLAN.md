# OmniClaw → Product Ready Build Plan

## Current State (V2 Score: 86/100)

### ✅ What Works (Already Built)
- [x] CORS + OPTIONS preflight
- [x] Rate limiting (60 req/min)
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] Health endpoint (/api/health)
- [x] SSE streaming chat (/api/chat/stream)
- [x] Real provider streaming (respondStream)
- [x] WebSocket gateway with ping/pong heartbeat
- [x] Memory search (/api/memory/search)
- [x] Config validation (/api/config/validate)
- [x] Session compaction (/api/sessions/compact)
- [x] Approval expiry (/api/approvals/expire)
- [x] Path traversal protection (file-store)
- [x] read_url tool
- [x] 13 provider presets (openai, anthropic, gemini, groq, openrouter, nvidia, codex-cli, local-compatible, ollama, mistral, deepseek, together, fireworks)
- [x] Dark theme CSS
- [x] Toast notifications
- [x] Markdown renderer
- [x] 77 tools registered
- [x] 4 agents (main, research, builder, ops)
- [x] 10 skills
- [x] Multi-turn tool loop (model-guided)
- [x] Shell execution with policy + audit
- [x] Telegram + Discord connector workers
- [x] 90+ API endpoints
- [x] Session/connector/trust/plugin management
- [x] Provider BYOK key management

### ❌ CRITICAL MISSING (OpenClaw Comparison)

#### 1. UI/UX — HALF BUILT
- [ ] Chat panel doesn't use streaming (still fetches /api/chat normally)
- [ ] No markdown rendering in chat bubbles (raw text shown)
- [ ] No keyboard shortcuts (Enter to send)
- [ ] No real-time event feed (SSE /api/events not connected in UI)
- [ ] No sidebar navigation (all panels stacked, no clean nav)
- [ ] No loading states / spinners during API calls
- [ ] No error boundaries — API errors just disappear
- [ ] No responsive mobile layout
- [ ] Boot screen works but first-launch dropdown missing new providers

#### 2. PROVIDER — REAL LLM NOT TESTED
- [ ] respondStream() never tested with real OpenAI API
- [ ] No fallback provider chain (if primary fails, no automatic retry on backup)
- [ ] No request retry on 429/5xx errors
- [ ] No token usage tracking/display
- [ ] Provider test button doesn't show result in UI

#### 3. SESSIONS — WEAK
- [ ] No session export/import
- [ ] No session search (by content)
- [ ] No session merge
- [ ] Compaction not triggered automatically
- [ ] No idle session auto-archive

#### 4. MEMORY — BASIC
- [ ] No semantic search (only text matching)
- [ ] Memory promotion not automatic
- [ ] No memory importance scoring beyond dreams
- [ ] No MEMORY.md file support

#### 5. TOOLS — MISSING KEY ONES
- [ ] No `exec` tool with background process support
- [ ] No `process` tool (manage running commands)
- [ ] No `web_search` tool (DuckDuckGo API)
- [ ] No `image` / `image_generate` tool
- [ ] No `tts` tool
- [ ] No `canvas` tool
- [ ] No `cron` tool
- [ ] No `gateway` tool (restart/config from chat)
- [ ] No `message` tool (send to channels from chat)
- [ ] No `sessions_spawn` / `sessions_send` / `sessions_yield`
- [ ] No `subagents` management
- [ ] No `nodes` tool

#### 6. SECURITY — GAPS
- [ ] No authentication middleware (anyone can call any endpoint)
- [ ] Gateway token not checked on API requests
- [ ] No HTTPS support
- [ ] No CSRF protection

#### 7. FRONTEND JS — MESSY
- [ ] app.js is 4500+ lines — monolithic
- [ ] No module separation
- [ ] DOM queries at top level (fragile)
- [ ] No state management
- [ ] No error handling on fetch calls

#### 8. CONFIG — INCOMPLETE
- [ ] No .env file support
- [ ] No config hot-reload
- [ ] No runtime profile switching from UI
- [ ] No custom agent creation from UI

#### 9. MISSING OPENCLAW FEATURES
- [ ] No cron job management from chat
- [ ] No event bus (events stored but no pub/sub)
- [ ] No heartbeat/polling system
- [ ] No sub-agent spawning
- [ ] No MCP server support
- [ ] No plugin hot-reload
- [ ] No workspace identity files (SOUL.md, USER.md, etc.)

## BUILD PRIORITY (What to build first)

### Phase 1: CORE STABILITY (4 hours)
1. Auth middleware — gateway token check on all /api/* routes
2. Provider retry + fallback chain
3. Session auto-compaction on idle
4. Fix UI chat to actually use streaming
5. Add keyboard shortcuts
6. Error handling on all UI fetch calls

### Phase 2: MISSING TOOLS (6 hours)
7. exec tool with background process
8. process tool (list/poll/kill)
9. web_search tool (DuckDuckGo)
10. gateway tool (restart, config get/patch)
11. cron tool (list/add/remove/run)
12. message tool (send to connectors)
13. sessions_spawn / sessions_send / sessions_yield

### Phase 3: UI POLISH (4 hours)
14. Sidebar navigation
15. Real-time event feed
16. Markdown in chat bubbles
17. Loading spinners
18. Provider dropdown fix (add new providers)
19. Responsive layout basics
20. Session list with search

### Phase 4: ADVANCED (6 hours)
21. Semantic memory search
22. Sub-agent spawning system
23. Event bus (pub/sub)
24. Heartbeat/polling
25. Config hot-reload
26. .env file support
27. Token usage tracking
28. Session export/import

### Phase 5: POLISH (4 hours)
29. MCP server support
30. Plugin hot-reload
31. Workspace identity files
32. HTTPS support
33. Mobile responsive
34. Accessibility basics
