# OmniClaw Design System

## Product Intent
OmniClaw is a lightweight local-first assistant control plane. The interface should feel like a calm mission-control cockpit: capable, fast, technical, and trustworthy without looking heavy or corporate.

## Visual Direction
- Theme: warm tactical workspace with glass panels, soft depth, and red-orange command accents.
- Mood: focused, alive, local-first, reliable.
- Avoid: generic SaaS purple gradients, flat white admin tables, and crowded dashboards.

## Core Screens
- Gateway Overview: live runtime status, runs, approvals, provider readiness, and events.
- Chat Control: selected session, agent lane, current context, and transcript.
- Delegation Inbox: multi-agent handoffs with retry/cancel controls.
- BYOK Provider Vault: key readiness, profile selection, and safe status messaging.
- Stitch Bridge: export/import this DESIGN.md so external design tools can refine OmniClaw's UI.

## Layout Rules
- Left rail stays persistent on desktop and compresses cleanly on mobile.
- Hero should summarize the current runtime at a glance.
- Cards should be grouped by operator task, not backend module names.
- Dense technical data belongs in compact panes, never in the primary hero.

## Typography
- Display: condensed technical sans for headings.
- Body: readable humanist sans.
- Mono: command/status labels, IDs, tokens, and logs.
- Headings should be bold and slightly compressed.

## Color Tokens
- Background: #F5F0E6, #FFF9ED, #15171D.
- Surface: rgba(255,255,255,0.72), #FFFFFF, #FFF7EA.
- Accent: #E53935 and #F2693A.
- Ink: #171A1F.
- Muted: #667085.
- Success: #1F8F67.
- Warning: #B7791F.
- Danger: #C2410C.

## Component Rules
- Status pills are uppercase, compact, and color-coded.
- Primary buttons use red-orange gradients and subtle lift.
- Secondary buttons stay transparent with strong borders.
- Console/log panes are dark and monospaced.
- Delegation cards must expose action buttons inline with status.

## Motion
- Use subtle page-load reveal and hover lift only.
- Avoid distracting loops.

## Accessibility
- Keep text contrast high.
- Preserve keyboard focus rings.
- Keep dashboard usable at 1280px desktop and narrow mobile widths.

## Stitch Prompt
Design a web app dashboard for OmniClaw, a lightweight local-first AI assistant control plane. Use a warm tactical cockpit aesthetic with a persistent left rail, live gateway hero, card-based runtime sections, BYOK provider vault, multi-agent delegation inbox, and a Stitch Bridge panel. Make it feel premium, technical, and trustworthy while staying fast and readable.
