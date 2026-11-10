# Sprint Contract
**Block:** Claude-Code-inspired OmniClaw Code workspace (Phase 1)
**Agreed:** 2026-10-18

## Scope (will do)
- Add a dedicated Code workspace mode to the existing `/next` UI.
- Reuse existing workspace/session, files/editor, review, chat, and agent-run surfaces where possible.
- Make the coding layout usable on narrow screens as well as desktop.
- Be honest about capabilities: the current Terminal tab is an agent-output log, not an interactive terminal.
- Add focused browser coverage for entering/leaving Code mode and the workspace layout.

## Files to change
- `SPRINT.md`
- `web-next/js/main.js`
- `web-next/js/ui/shell.js`
- `web-next/js/ui/sidebar.js`
- `web-next/js/icons.js`
- `web-next/js/store.js`
- `web-next/js/ui/panel.js`
- `web-next/css/layout.css`
- `web-next/css/sidebar.css`
- `web-next/css/panel.css` (only if needed for reuse)
- `scripts/code-workspace-ui-smoke.mjs`
- `PROGRESS.md`
- `DECISIONS.md`

## Do NOT touch
- `src/core/**`, `server.js`, provider/config/session data, and user workspaces
- The unrelated tracked feature list for the game project
- Existing dirty/untracked user files reported by `git status`
- Claude Desktop binaries, installation, or settings

## Pass criteria (verifiable)
- Code mode is reachable from the existing UI and uses the selected workspace/session.
- Returning to chat does not lose or cancel server-side work.
- Existing file/editor/review flows remain capability-gated and usable.
- The terminal is never presented as interactive while `caps.terminal` is false.
- Focused browser smoke and `npm run build` pass.

## Exclusions (out of scope)
- Copying Claude's proprietary source, assets, or exact branded UI.
- Building a PTY backend or claiming interactive terminal support.
- Changes to agent-loop, memory, skills, MCP, or backend security in this UI slice.
- Rebuilding the packaged executable; this slice is frontend-only.
