---
name: browser-game-testing
description: How to test a browser game or interactive website like a human player — start it, play it with keys/clicks, READ real state between actions, and prove the result with evidence.
tags: [browser, game, testing, verification]
triggers: [game test, test the game, khel, khelo, game chal, play the game, flappy, game verify, website test, test website, game kaam]
---

# Testing a browser game / interactive site like a human

A human tester does not stare at a screenshot and guess. They **act → observe → act again**. Every action must be followed by READING real state. Never claim "game works" without evidence from steps 4–6.

## The loop

1. **Open + baseline**
   - `browser` action=open with the URL (local file or dev server).
   - `browser_console` — any errors on load? Fix those FIRST; a game with load errors is not testable.
   - `browser_snapshot` — get @e refs for buttons/canvas.

2. **Start the game like a player**
   - Click the start button by ref (`browser_click` ref=@eN), or press the start key (`browser_press` key=Space).
   - Canvas games need focus: click the canvas once before sending keys.

3. **READ state — never guess**
   Use `browser_evaluate` and END with a JSON-serializable expression. The value comes back in `result.result`:
   ```js
   ({
     startHidden: getComputedStyle(document.querySelector('#startPanel')).display === 'none',
     scoreVisible: !!document.querySelector('#scoreBoard'),
     score: document.querySelector('#score')?.textContent ?? window.score ?? null,
   })
   ```
   - Canvas games have NO DOM state — read the game's globals (`window.score`, `window.gameOver`, `game.state`). If none exist, add them in the game code (`window.__test = {score, gameOver, birdY}`) — that is a testability improvement, not a hack.
   - A DOM node return comes back as `null` with a note — return plain data, not elements.

4. **Play a few frames**
   Repeat 3–6 times: `browser_press` (Space/ArrowUp/click) → `browser_wait` ~300–500ms → `browser_evaluate` state.
   - Did the player position change after input? Did gravity move it back? Did score increase after passing an obstacle?
   - State FROZEN across presses = input handling broken. Report it with the two identical state reads as proof.

5. **Test the losing path too**
   Press nothing for a while → does game-over trigger? Read the game-over state the same way.

6. **Console + screenshot as final evidence**
   - `browser_console` — errors thrown DURING gameplay (physics/undefined vars usually appear here, not at load).
   - `browser_screenshot` — attach as proof of the final state.

## Report format

State what you did and what you measured: "Pressed Space 4x — birdY changed 210→166→190 (gravity works), score 0→2 after passing pipes, no console errors, game-over fires after 6s idle." Not: "game looks fine".

## Pitfalls

- `browser_evaluate` with no return value tells you nothing — always end with an expression.
- `setInterval`/`requestAnimationFrame` games need real `browser_wait` between input and state read.
- Keyboard events go to the focused element — click the canvas/body first if presses do nothing.
- If the game listens on `keydown` only, `browser_press` covers it; for touch games use `browser_tap` with coordinates.
