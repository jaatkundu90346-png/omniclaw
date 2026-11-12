# OmniClaw social ad (Remotion)

The product ad used for social media (Reels / Shorts / TikTok / feed posts).

Built with the [Remotion agent skills](https://www.remotion.dev/docs/ai/skills)
(`remotion-best-practices` → `remotion-markup`), which are also installed into
this repo's `skills/` folder so the agent itself can use them.

## Compositions

| id                 | size       | for                              |
| ------------------ | ---------- | -------------------------------- |
| `OmniClawAd`       | 1080×1920  | Reels / Shorts / TikTok / Stories |
| `OmniClawAdSquare` | 1080×1080  | feed posts                       |

40 s at 30 fps (1200 frames).

## Scenes

1. **Hook** — "Your AI agent shouldn't live in someone else's cloud"
2. **Problem** — your code / your keys / your memory, and "that's a tab"
3. **Product** — the real workspace (`home.png`)
4. **Features** — live browser view, diff review, skills & tools (real captures)
5. **CTA** — download, GitHub, proof chips

Brand colours come from the app's own tokens (`web-next/css/tokens.css`), so the
video looks like the product instead of a stock template.

## Assets

`public/` holds real screenshots of the product:

| file               | what it shows                                     |
| ------------------ | -------------------------------------------------- |
| `home.png`         | the chat workspace                                 |
| `browser-live.png` | the Browser panel mirroring a live page             |
| `changes.png`      | every edit reviewed as a diff                       |
| `tools.png`        | skills & tools                                      |

`browser-live.png` is captured from the USER'S REAL CHROME by
`npm run video:assets` (`scripts/capture-ad-assets.mjs`): it talks raw CDP to
the Chrome that OmniClaw launched, opens OmniClaw in a real tab, opens the
Browser panel, waits for a LIVE frame to arrive in the panel, and screenshots
that tab. Headless copies are not used — the ad claims a live browser view, so
the shot has to be the real thing.

## Render

```bash
npm run video:render          # vertical  -> marketing/video/out/omniclaw-ad-vertical.mp4
npm run video:render:square   # square   -> marketing/video/out/omniclaw-ad-square.mp4
npm run video:studio          # interactive preview
```

`out/` is build output and is git-ignored; this project source is tracked.

## Notes

- Every animation is driven by `useCurrentFrame()` + `interpolate()` (Remotion
  does not render CSS transitions/animations), and transforms use the
  `scale`/`translate`/`rotate` shorthands so Studio can edit them.
- Font: the system UI stack (`Segoe UI`/Inter) — no webfont fetch at render
  time, so the render never depends on the network.
