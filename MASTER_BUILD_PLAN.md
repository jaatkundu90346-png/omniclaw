# OmniClaw → Product Ready Master Plan
# Generated: 2026-05-06 | V2 Score: 86 → Target: 95+

## Current State
- 45 JS files, ~24,500 lines
- 90+ API endpoints (many stubs)
- 77 tools registered (many placeholders)
- Mock provider works, real providers untested
- UI has 24 panels, routing works but no sidebar
- SSE events exist but not rendered in UI
- Streaming exists in backend but UI still uses /api/chat

## ═══════════════════════════════════════════════════════════════
## PHASE 1: CRITICAL BACKEND FIXES (Priority: 🔴 HIGH)
## ═══════════════════════════════════════════════════════════════

### 1.1 Provider Fallback Chain
- File: src/core/agent.js, src/core/providers/
- When primary provider fails (429/5xx/timeout), try next configured provider
- Config: provider.fallbacks = ["openai", "anthropic", "mock"]
- Add fallback logic in executeMessageRun()

### 1.2 Event Bus (Pub/Sub)
- File: src/core/event-bus.js (NEW)
- on(event, callback), emit(event, data), off(event, callback)
- Wire into gateway-store addEvent() to also emit
- Used by: UI SSE feed, heartbeat, cron triggers

### 1.3 Real Cron Execution
- File: src/core/scheduler.js (upgrade)
- Currently schedule-store only stores schedules, no actual execution
- Add setInterval-based scheduler that reads schedules and runs tools
- Add cron expression parser (simple: every/cron/at)

### 1.4 Token Usage Tracking
- File: src/core/agent.js (add token tracking)
- Parse usage from OpenAI response: prompt_tokens, completion_tokens
- Store in session metadata
- Display in UI session detail

### 1.5 Session Export/Import
- Endpoints: POST /api/sessions/export, POST /api/sessions/import
- Export: full session + transcript as JSON
- Import: restore from JSON

### 1.6 Session Search
- Endpoint: GET /api/sessions/search?q=keyword
- Search across session labels, transcript content

### 1.7 Config Hot-Reload
- File watcher on config/default.json
- On change: reload config, emit event
- Debounce 1s to avoid rapid reloads

## ═══════════════════════════════════════════════════════════════
## PHASE 2: CRITICAL UI FIXES (Priority: 🔴 HIGH)
## ═══════════════════════════════════════════════════════════════

### 2.1 Chat Panel → Use Streaming
- Wire chat form to /api/chat/stream (SSE)
- Show tokens arriving in real-time
- Markdown render in chat bubbles

### 2.2 Sidebar Navigation
- Replace hidden section switching with visible sidebar
- Icons + labels for: Chat, Overview, Sessions, Tools, Memory, etc.
- Active state indicator
- Mobile: hamburger menu

### 2.3 Real-Time Event Feed
- Connect openEventStream() to a visible panel
- Show gateway events as they happen
- Auto-scroll, filter by type

### 2.4 Loading States
- Spinner/skeleton for every async operation
- Button disable during loading
- Toast for success/error

### 2.5 Error Handling
- Every fetch: try/catch with user-facing error toast
- API error responses shown clearly
- Network errors: "Connection lost, retrying..."

### 2.6 Keyboard Shortcuts
- Enter to send (Shift+Enter for newline)
- Escape to abort
- Ctrl+K for search

## ═══════════════════════════════════════════════════════════════
## PHASE 3: REAL TOOL IMPLEMENTATIONS (Priority: 🟡 MEDIUM)
## ═══════════════════════════════════════════════════════════════

### 3.1 exec Tool (Real)
- Execute shell commands with output capture
- Background mode: spawn + track process ID
- Timeout support
- Working directory support

### 3.2 process Tool (Real)
- List running background processes
- Poll for output
- Kill processes
- Send input to stdin

### 3.3 web_search Tool (Real)
- DuckDuckGo HTML scraping (no API key needed)
- Parse results: title, URL, snippet
- Rate limit to avoid blocking

### 3.4 message Tool (Real)
- Send through active connector adapters
- Support Telegram, Discord, webhook dispatch
- Queue in adapter outbox

### 3.5 canvas Tool (Upgrade)
- Create/manage HTML canvas surfaces
- eval JavaScript in canvas context
- Snapshot to image

### 3.6 tts Tool (Upgrade)
- If Web Speech API available, use browser TTS
- Otherwise: return text with note about provider needed

### 3.7 image_generate Tool (Upgrade)
- If DALL-E/Stability API configured, use it
- Otherwise: placeholder with clear message

## ═══════════════════════════════════════════════════════════════
## PHASE 4: ADVANCED FEATURES (Priority: 🟢 MEDIUM)
## ═══════════════════════════════════════════════════════════════

### 4.1 Sub-Agent Spawning
- Spawn isolated agent sessions for parallel work
- Delegate task → new session → result callback
- sessions_spawn, sessions_send, sessions_yield tools

### 4.2 Heartbeat Polling
- Periodic check system (like OpenClaw heartbeats)
- Configurable interval, check list
- Can trigger: email, calendar, notifications, weather

### 4.3 MCP Server Support
- stdio/HTTP MCP protocol client
- List tools from MCP servers
- Call MCP tools from OmniClaw tool loop

### 4.4 HTTPS Support
- SSL/TLS termination option
- Self-signed cert for local dev
- Let's Encrypt for production

### 4.5 Workspace Identity Files
- SOUL.md, USER.md, MEMORY.md support
- Load on startup into context
- Update from chat

### 4.6 Plugin Hot-Reload
- Watch plugin directories
- Auto-reload on file change
- Graceful replacement

## ═══════════════════════════════════════════════════════════════
## PHASE 5: POLISH & PRODUCTION (Priority: 🟢 LOW)
## ═══════════════════════════════════════════════════════════════

### 5.1 Responsive Mobile Layout
- CSS media queries for < 768px
- Collapsible sidebar
- Touch-friendly chat

### 5.2 Accessibility
- ARIA labels
- Keyboard navigation
- Focus management

### 5.3 Performance
- Debounced state loading
- Virtual scrolling for long lists
- Lazy panel rendering

### 5.4 Production Hardening
- Request size limits
- Input sanitization
- CORS origin whitelist
- Rate limit per endpoint

## ═══════════════════════════════════════════════════════════════
## EXECUTION ORDER (Parallel Work)
## ═══════════════════════════════════════════════════════════════

Batch 1 (NOW - 4h): Backend Critical
  → Event bus, provider fallback, real cron, session export/search, token tracking

Batch 2 (NOW - 4h): UI Critical  
  → Sidebar nav, chat streaming wireup, event feed, loading states, error handling

Batch 3 (+4h): Real Tools
  → exec, process, web_search, message tools working end-to-end

Batch 4 (+4h): Advanced
  → Sub-agents, heartbeat, config hot-reload, workspace identity

Batch 5 (+4h): Polish
  → Mobile responsive, accessibility, performance, production hardening

Batch 6 (+4h): Testing & Final
  → Full end-to-end tests, smoke tests, bug fixes, push
