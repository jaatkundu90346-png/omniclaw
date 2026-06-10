# OmniClaw Ultra Build Plan

**Target: Make OmniClaw the most powerful local agent platform by combining best of:**
- OmniClaw (local gateway + Codex bridge)
- OpenClaw (channels + plugins + control UI)
- Hermes Agent (prompt assembly + tool naming + skills)
- Mavis (session lifecycle + cron + memory + IM routing)

**Version:** Ultra 1.0  
**Date:** 2026-05-19  
**Status:** Phase 1 & Phase 3.1-3.4 Complete ✓

---

## 📊 Source System Analysis

### OmniClaw - Current Strengths
| Feature | Status | Source |
|---------|--------|--------|
| Gateway HTTP/WebSocket | ✅ Working | `server.js`, `ws-gateway.js` |
| Local file tools | ✅ Working | `src/core/file-store.js`, `shell-executor.js` |
| Browser automation | ✅ Working | `browser-playwright.js`, `visual-browser-operator.js` |
| Sandbox execution | ✅ Working | `sandbox-runner.js` |
| Provider BYOK | ✅ Working | `openai-api.js`, `provider-factory.js` |
| Shell governance | ✅ Working | `shell-policy.js`, `shell-audit-store.js` |
| V2 feature health | ✅ Working | `v2-feature-health.js` |
| Multi-agent delegation | ⚠️ Basic | `sub-agent-spawner.js` |

### OmniClaw - Gaps
| Feature | Missing | Priority |
|---------|---------|----------|
| Session rotation with handoff | ✅ DONE | HIGH |
| Auth middleware | ✅ DONE | HIGH |
| Natural cron intervals | ✅ DONE | HIGH |
| Skill install from git | ✅ DONE | HIGH |
| 3-layer memory | ✅ DONE | MEDIUM |
| IM routing layer | ❌ | MEDIUM |
| Hook system | ❌ | MEDIUM |
| Semantic memory search | ❌ | MEDIUM |
| Event bus pub/sub | ❌ | MEDIUM |
| Tool examples | ✅ DONE | HIGH |

### OpenClaw - Transplant Candidates
| Feature | Location | Transplant To |
|---------|----------|---------------|
| Typed gateway protocol | `src/gateway/protocol/` | OmniClaw WS protocol |
| Plugin manifest system | `src/plugins/contracts/` | OmniClaw plugin-registry |
| Channel adapter contracts | `extensions/*/src/index.ts` | OmniClaw channels |
| Skill precedence | `src/skills/` | OmniClaw skill-registry |
| Memory SQLite backend | `packages/memory-core/` | OmniClaw memory |
| Control UI (Vite+Lit) | `ui/` | OmniClaw public/ |
| Cron job management | `src/cron/` | OmniClaw scheduler |
| Node pairing | `src/pairing/` | OmniClaw trust system |
| ACP protocol | `src/acp/` | OmniClaw protocol layer |

### Hermes Agent - Transplant Candidates
| Feature | Location | Transplant To |
|---------|----------|---------------|
| Tool naming aliases | `vendor/hermes-agent/skills/` | OmniClaw TOOLS.md |
| Prompt assembly | `vendor/hermes-agent/agent/prompt/` | OmniClaw system-prompt.js |
| Tool catalog with status | `toolsets/` | OmniClaw capability_demo |
| Context compression | `context/` | OmniClaw summarization-engine |
| Session search (FTS) | `memory/` | OmniClaw session-lifecycle |

### Mavis - Transplant Candidates
| Feature | Source | Transplant To |
|---------|--------|---------------|
| Session rotation with handoff | CLI | OmniClaw session-lifecycle.js |
| Natural cron intervals | `cron.md` | OmniClaw scheduler.js |
| 3-layer memory model | `memory.md` | OmniClaw memory-store.js |
| Skill install/delete | CLI | OmniClaw skill-registry.js |
| Hook system | `hook.md` | OmniClaw plugin-system.js |
| Agent-private skills | `skill-management.md` | OmniClaw skill-registry.js |
| IM routing | `im.md` | OmniClaw channels.js |
| Report-back pattern | `session.md` | OmniClaw sub-agent-spawner.js |

---

## 🎯 ULTRA BUILD PHASES

### Phase 1: Core Foundation (Week 1)
**Goal: Make OmniClaw production-stable like Mavis daemon**

#### 1.1 Auth Middleware (OpenClaw Pattern)
```
src/core/auth-middleware.js (NEW)
├── token validation on all /api/* routes
├── scope checking (read/write/admin/approvals)
├── rate limiting per token
└── audit logging
```

**Transplant:** OpenClaw `src/gateway/` auth patterns + Mavis daemon auth

#### 1.2 Session Rotation with Handoff (Mavis Pattern)
```
src/core/session-lifecycle.js (UPGRADE)
├── add rotate(sessionId, handoffFile) method
├── handoff file format: markdown with Goal/Progress/Files/Decisions/Questions
├── archive old session automatically
└── new session starts with handoff context
```

**Transplant:** Mavis `session rotate --handoff-file` pattern

#### 1.3 Provider Retry + Fallback Chain (OpenClaw Pattern)
```
src/core/multi-provider-fallback.js (UPGRADE)
├── automatic retry on 429/5xx
├── fallback to backup provider on failure
├── rate-limit tracking per provider
└── token usage storage
```

**Transplant:** OpenClaw provider runtime retry patterns

#### 1.4 Shell Governance Enhancement
```
src/core/shell-executor.js (UPGRADE)
├── add hook system for pre-execution checks
├── add policy cache with hot-reload
├── add output truncation with full log access
└── add background process support
```

**Transplant:** Mavis hook system concept

---

### Phase 2: Memory System (Week 2)
**Goal: Make memory production-grade like Mavis**

#### 2.1 Three-Layer Memory (Mavis Pattern)
```
src/core/memory-store.js (UPGRADE)
├── Layer 1: User memory (~/.mavis/memory/user.md)
│   └── User preferences, identity, communication style
├── Layer 2: Agent memory (~/.mavis/agents/<agent>/memory/)
│   ├── MEMORY.md (hot rules, always injected)
│   └── memory/<topic>.md (on-demand topics)
└── Layer 3: Project memory (workspace/AGENTS.md, topic files)
```

**Transplant:** Mavis 3-layer memory model

#### 2.2 Automatic Memory Cleanup (Mavis Pattern)
```
src/core/memory-cleanup.js (NEW)
├── daily cleanup at 05:00 UTC
├── dedup entries
├── rebalance MEMORY.md vs topics
├── archive old entries to memory/archive/<date>/
└── size constraints: MEMORY.md ≤ 15KB, topics ≤ 30KB
```

**Transplant:** Mavis cleanup curator

#### 2.3 Semantic Memory Search (OpenClaw Pattern)
```
src/core/semantic-memory.js (UPGRADE)
├── SQLite FTS5 full-text search
├── search across: notes, long-term, conversations, attachments
├── relevance scoring
└── highlight matching terms
```

**Transplant:** OpenClaw memory SQLite + Hermes Agent session search

#### 2.4 Memory Importance Scoring
```
src/core/memory-importance.js (NEW)
├── track access frequency
├── track user positive feedback
├── auto-promote high-importance items
└── dream sweep for interesting patterns
```

**Transplant:** OmniClaw existing dream system enhanced

---

### Phase 3: Tool & Skills System (Week 3)
**Goal: Make skills first-class like OpenClaw + Mavis**

#### 3.1 Skill Lifecycle CLI (Mavis Pattern)
```
src/core/skill-registry.js (UPGRADE)
├── mavis skill list [--scope agent|global]
├── mavis skill install <git-url> [-a <agent>]
├── mavis skill create <name> --file ./SKILL.md
├── mavis skill update/delete/copy
└── skill scopes: global (all agents) + agent-private
```

**Transplant:** Mavis skill management CLI

#### 3.2 OpenClaw Skill Import (OpenClaw Pattern)
```
src/core/openclaw-skill-importer.js (NEW) ✅ DONE
├── scan vendor/openclaw/skills/*/SKILL.md
├── selective import with preview
├── convert to OmniClaw format
├── handle dependencies
└── track imported vs original
```

**Transplant:** OpenClaw skill system

#### 3.3 Hermes Skill Import (Hermes Pattern)
```
src/core/hermes-skill-importer.js (NEW) ✅ DONE
├── scan vendor/hermes-agent/skills/*/SKILL.md
├── compatibility check
├── alias Hermes tools to OmniClaw equivalents
└── mark Python-only as partial/placeholder
```

**Transplant:** Hermes Agent skill catalog

#### 3.4 Tool Descriptor Enhancement (OpenClaw Pattern)
```
src/core/tool-registry.js (UPGRADE) ✅ DONE (examples added)
├── add metadata: group, risk, examples, required permission
├── add output shape documentation
├── add OpenClaw-compatible aliases
└── add Hermes-compatible aliases
```

**Transplant:** OpenClaw tool descriptors + Hermes tool naming

#### 3.5 Skill Self-Improvement (Hermes Pattern)
```
src/core/skill-optimizer.js (NEW)
├── track successful workflows
├── promote to skill candidate
├── review workflow before skill creation
└── update skill with improvements
```

**Transplant:** Hermes Agent closed learning loop concept

---

### Phase 4: Cron & Scheduling (Week 4)
**Goal: Make scheduling production-grade like Mavis**

#### 4.1 Natural Cron Intervals (Mavis Pattern)
```
src/core/scheduler.js (UPGRADE)
├── parse "5m", "1h", "2d", "1h30m"
├── convert to cron expression
├── support raw cron expressions
├── active-hours gating
└── timezone support
```

**Transplant:** Mavis cron interval parsing

#### 4.2 Self-Reminder Shorthand (Mavis Pattern)
```
src/core/cron-self.js (NEW)
├── mavis cron self <name> --every <interval> --prompt "<text>"
├── auto-inject session context
├── auto-cleanup after TTL (default 14d)
├── quiet-on-skip (don't bother user if nothing to do)
└── poll CI/batch without blocking
```

**Transplant:** Mavis `cron self` shorthand

#### 4.3 Full Cron CLI (Mavis Pattern)
```
src/core/cron-commands.js (NEW)
├── create/list/info/trigger/enable/disable/delete/update
├── --deliver-channel for IM delivery
├── --active-hours for business hours
├── session-mode: new (fresh) / sessionId (continue) / root (main)
└── trigger now for testing
```

**Transplant:** Mavis full cron CLI

#### 4.4 Background Job System (OpenClaw Pattern)
```
src/core/background-worker.js (UPGRADE)
├── isolated worker processes
├── job queue with priority
├── job lifecycle (pending/running/done/failed)
├── retry with backoff
└── job status tools
```

**Transplant:** OpenClaw cron job management

---

### Phase 5: Multi-Agent Orchestration (Week 5)
**Goal: Make multi-agent production-grade like Mavis**

#### 5.1 Agent Registry (Mavis Pattern)
```
src/core/agent-registry.js (UPGRADE)
├── mavis agent list [--project <path>]
├── mavis agent info <name>
├── mavis agent update <name> [--workspace] [--persona]
├── agent identity: display_name, avatar
└── per-agent workspace + skills
```

**Transplant:** Mavis agent CLI

#### 5.2 Session Lifecycle (Mavis Pattern)
```
src/core/session-lifecycle.js (UPGRADE)
├── 5-state model: started/finished/interrupted/aborted/error
├── send accepted to finished sessions
├── session rotate with handoff
├── session abort (interrupt request)
└── session messages with cursor pagination
```

**Transplant:** Mavis session state machine

#### 5.3 Inter-Agent Communication (Mavis Pattern)
```
src/core/inter-agent-communication.js (NEW)
├── mavis communication send --to <session> --command prompt --content "..."
├── peers discovery
├── message audit trail
├── large payload handling (>8KB → scratchpad)
└── proactive report-back pattern
```

**Transplant:** Mavis communication system

#### 5.4 Team Plan Orchestration (Mavis Pattern)
```
src/core/team-planner.js (NEW)
├── parallel track execution
├── verifier judge per deliverable
├── accept/retry decision
├── cross-session coordination
└── CycleReports for decisions
```

**Transplant:** Mavis team plan

#### 5.5 Sub-Agent Isolation (OpenClaw Pattern)
```
src/core/sub-agent-spawner.js (UPGRADE)
├── isolated child sessions
├── shared iteration budget (optional)
├── blocked tools for children
├── execute-code isolation
└── child lifecycle management
```

**Transplant:** OpenClaw subagent isolation

---

### Phase 6: Channels & IM Routing (Week 6)
**Goal: Make channels production-grade like OpenClaw**

#### 6.1 Channel Adapter System (OpenClaw Pattern)
```
src/core/channel-adapter.js (NEW)
├── manifest-based channel discovery
├── adapter interface: connect/disconnect/send/receive
├── auth isolation per channel (secrets.json)
├── inbound processing pipeline
└── outbound delivery queue
```

**Transplant:** OpenClaw channel plugin architecture

#### 6.2 IM Routing Layer (Mavis Pattern)
```
src/core/im-router.js (NEW)
├── route rules: priority, chat-id, agent mapping
├── route simulation for testing
├── channel status tracking
├── DM allowlist/gate
└── message deduplication
```

**Transplant:** Mavis IM routing

#### 6.3 Connector Upgrades
```
src/core/telegram-polling-worker.js (UPGRADE)
├── add webhook support
├── add inline keyboard handling
├── add message threading
└── add media handling

src/core/discord-gateway-worker.js (UPGRADE)
├── add slash commands
├── add button interactions
├── add modal forms
└── add thread management
```

**Transplant:** OpenClaw Telegram/Discord extensions

#### 6.4 Webhook System (OpenClaw Pattern)
```
src/core/webhook-handler.js (NEW)
├── webhook endpoint: /api/webhook/<channel>
├── token validation
├── payload parsing
├── agent routing from payload
└── retry with exponential backoff
```

**Transplant:** OpenClaw webhook system

---

### Phase 7: Plugin System (Week 7)
**Goal: Make plugins production-grade like OpenClaw**

#### 7.1 Plugin Manifest System (OpenClaw Pattern)
```
src/core/plugin-manifest.js (NEW)
├── manifest.json validation
├── capability registration
├── runtime loading with hot-reload
├── plugin lifecycle: install/enable/disable/uninstall
└── plugin security sandboxing
```

**Transplant:** OpenClaw plugin manifest + lifecycle

#### 7.2 Provider Plugin System (OpenClaw Pattern)
```
src/core/provider-registry.js (NEW)
├── provider manifest: id, name, auth, models, tools
├── auth handler per provider
├── model discovery
├── tool schema mapping
└── fallback chain configuration
```

**Transplant:** OpenClaw provider plugins

#### 7.3 MCP Server Integration (Mavis Pattern)
```
src/core/mcp-client.js (UPGRADE)
├── MCP server discovery
├── tool resolution
├── server health monitoring
├── reconnect on failure
└── expose OmniClaw as MCP server
```

**Transplant:** OpenClaw MCP client + Mavis MCP integration

#### 7.4 Plugin SDK (OpenClaw Pattern)
```
src/core/plugin-sdk/ (NEW)
├── openclaw/plugin-sdk compatible interface
├── tool registration
├── channel hooks
├── event subscription
└── secret resolution
```

**Transplant:** OpenClaw plugin-sdk

---

### Phase 8: Control UI (Week 8)
**Goal: Make UI production-grade like OpenClaw**

#### 8.1 WebSocket Protocol (OpenClaw Pattern)
```
src/core/ws-gateway-protocol.js (NEW)
├── typed protocol: req/res/event
├── scopes: operator.read/write/admin/approvals
├── idempotency keys
├── roles: operator vs node
└── device pairing flow
```

**Transplant:** OpenClaw gateway protocol

#### 8.2 UI Streamlining
```
public/app.js (REFACTOR)
├── split into modules (chat, sessions, tools, settings)
├── add state management
├── add error boundaries
├── add loading spinners
├── add real-time event feed
└── add responsive layout
```

**From:** OpenClaw Vite+Lit UI patterns

#### 8.3 Markdown Rendering (OmniClaw Pattern Enhanced)
```
public/markdown.js (NEW or UPGRADE)
├── render markdown in chat bubbles
├── syntax highlighting for code
├── LaTeX math rendering
├── mermaid diagrams
└── sanitize HTML
```

**Enhancement:** Existing markdown renderer

#### 8.4 Sidebar Navigation (OpenClaw Pattern)
```
public/sidebar.js (NEW)
├── persistent left rail
├── sections: Chat/Sessions/Tools/Memory/Settings
├── collapse on mobile
└── keyboard navigation
```

**Transplant:** OpenClaw control UI layout

#### 8.5 Session Management UI
```
public/sessions-panel.js (NEW)
├── session list with search
├── session export/import
├── session merge
├── session compaction trigger
└── session rotation button
```

**Enhancement:** Existing session tools

---

### Phase 9: Security & Trust (Week 9)
**Goal: Make security production-grade like OpenClaw**

#### 9.1 Hook System (Mavis Pattern)
```
src/core/hook-registry.js (NEW)
├── hook types: tool-guard, session-start, session-end, pre-exec
├── matchers for conditional execution
├── dry-run testing
├── hook logs
└── hook file locations: ~/.mavis/agents/<agent>/hooks/
```

**Transplant:** Mavis hook system

#### 9.2 Approval Queue Enhancement (OpenClaw Pattern)
```
src/core/approval-queue.js (UPGRADE)
├── approval families (group related approvals)
├── approval expiry with notification
├── approval delegation
├── approval history
└── approval statistics
```

**Transplant:** OpenClaw approval system

#### 9.3 Device Pairing (OpenClaw Pattern)
```
src/core/pairing.js (UPGRADE)
├── pairing request flow
├── pairing approve/deny
├── pairing status tracking
├── pairing revocation
└── multi-device support
```

**Transplant:** OpenClaw pairing system

#### 9.4 Secret Management (OpenClaw Pattern)
```
src/core/secret-store.js (UPGRADE)
├── secret rotation
├── secret audit trail
├── channel-specific secrets
├── provider credentials
└── secret reference resolution
```

**Transplant:** OpenClaw secret management

---

### Phase 10: Advanced Features (Week 10)
**Goal: Add cutting-edge features**

#### 10.1 Trajectory & Learning Loop (Hermes Pattern)
```
src/core/trajectory-collector.js (NEW)
├── log gateway runs
├── log tool/provider events
├── log shell audits
├── redact private data
└── export for RL training
```

**Transplant:** Hermes Agent trajectory system

#### 10.2 Event Bus (OpenClaw Pattern)
```
src/core/event-bus.js (UPGRADE)
├── pub/sub architecture
├── event types with typed payloads
├── event subscriptions
├── event persistence
└── event replay
```

**Transplant:** OpenClaw event bus

#### 10.3 ACP Protocol (OpenClaw Pattern)
```
src/core/acp-protocol.js (NEW)
├── agent communication protocol
├── cross-gateway communication
├── capability negotiation
└── trust establishment
```

**Transplant:** OpenClaw ACP protocol

#### 10.4 Node System (OpenClaw Pattern)
```
src/core/node-system.js (NEW)
├── node discovery
├── node capability registration
├── node status monitoring
├── canvas/camera/screen nodes
└── node pairing
```

**Transplant:** OpenClaw node system

---

## 📋 Implementation Order

### Sprint 1: Foundation (Days 1-5)
1. Auth middleware
2. Session rotation with handoff
3. Provider retry chain

### Sprint 2: Memory (Days 6-10)
1. 3-layer memory model
2. Memory cleanup curator
3. Semantic search upgrade

### Sprint 3: Tools & Skills (Days 11-15)
1. Skill lifecycle CLI
2. OpenClaw skill importer
3. Hermes skill importer
4. Tool descriptor enhancement

### Sprint 4: Cron (Days 16-20)
1. Natural cron intervals
2. Self-reminder shorthand
3. Full cron CLI
4. Background jobs

### Sprint 5: Multi-Agent (Days 21-25)
1. Agent registry CLI
2. Session lifecycle upgrade
3. Inter-agent communication
4. Team planner

### Sprint 6: Channels (Days 26-30)
1. Channel adapter system
2. IM routing layer
3. Webhook handler
4. Connector upgrades

### Sprint 7: Plugins (Days 31-35)
1. Plugin manifest system
2. Provider registry
3. MCP integration
4. Plugin SDK

### Sprint 8: UI (Days 36-40)
1. WebSocket protocol
2. UI refactoring
3. Sidebar navigation
4. Session management UI

### Sprint 9: Security (Days 41-45)
1. Hook system
2. Approval queue
3. Device pairing
4. Secret management

### Sprint 10: Advanced (Days 46-50)
1. Trajectory collector
2. Event bus
3. ACP protocol
4. Node system

---

## 🎯 Success Metrics

| Metric | Target |
|--------|--------|
| V2 Score | 95/100 (from 86/100) |
| Auth middleware | 100% API routes protected |
| Session rotation | Working with handoff |
| Memory cleanup | Daily automatic |
| Skill install | Git URL support |
| Cron intervals | Natural language support |
| Agent registry | Full CLI + per-agent workspaces |
| Channel adapters | 5+ production-ready |
| Plugin system | 10+ plugins installable |
| Control UI | Sidebar + streaming + markdown |
| Security | Hook system + approval queue |
| Advanced | Trajectory + event bus + ACP + nodes |

---

## 🚀 Quick Wins (This Week)

If you want immediate results while building the full plan:

### Quick Win 1: Auth Middleware (2 hours)
```javascript
// Add to server.js after rate limiting
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const validToken = agent.config.getConfig().gatewayToken;
  if (!token || token !== validToken) {
    return res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
  }
  next();
}
```

### Quick Win 2: Natural Cron Intervals (3 hours)
```javascript
// Add to scheduler.js
function parseInterval(str) {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  const [_, num, unit] = match;
  const map = { s: 1, m: 60, h: 3600, d: 86400 };
  return Date.now() + num * map[unit] * 1000;
}
```

### Quick Win 3: Session Handoff (2 hours)
```javascript
// Add to session-lifecycle.js
async function rotateSession(sessionId, handoffFile) {
  const handoff = await fs.readFile(handoffFile, 'utf-8');
  await archiveSession(sessionId);
  const newSession = await createSession({ context: handoff });
  return newSession;
}
```

---

## 📞 Team Setup Recommendation

For building this plan efficiently:

| Agent | Focus | Tasks |
|-------|-------|-------|
| **builder-main** | Core foundation | Auth, session rotation, provider retry |
| **builder-memory** | Memory system | 3-layer memory, cleanup, semantic search |
| **builder-skills** | Tools & skills | Skill CLI, importers, tool descriptors |
| **builder-cron** | Scheduling | Natural intervals, cron CLI, background jobs |
| **builder-agents** | Multi-agent | Registry, communication, team planner |
| **builder-channels** | Channels & routing | Adapters, IM routing, webhooks |
| **builder-ui** | UI/UX | Protocol, sidebar, markdown, sessions |
| **research** | Deep dive | OpenClaw source study, Hermes patterns |
| **ops** | Testing & verification | Build, test, smoke tests |

---

## 🏁 Next Steps

1. **Approve this plan** → I'll set up the agent team
2. **Choose starting point** → Foundation vs Quick Wins
3. **Allocate time** → Full-time vs part-time building
4. **Set milestones** → Weekly targets

Kya yeh plan good lagti hai? Approval do aur main team setup kar deta hoon! 🚀