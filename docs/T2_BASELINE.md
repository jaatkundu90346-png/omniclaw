# T2_BASELINE — last 5 real turns, live data read-only (2026-09-05)

> Source: `data/gateway.json` runs + `data/sessions/transcripts/*.jsonl`.
> All 5 are session `session_1788609848683_g4bw85`, 12:04–12:19 UTC.
> Live config: model `glm-5.3-flash`, `maxTools 64`, `compactAtPercent 0.8`,
> `maxToolResultChars 10000` (all defaults).
> Menu per turn: 211 tools available → **64 sent** (~21.2k chars ≈ 5.3k tok).

| run (time) | trace total | workspace | mcp | loopContract | memory kept (active/notes/lt/recent) | stop | rounds/tools/failed | transcript blk/fail | compactions |
|---|---|---|---|---|---|---|---|---|---|
| …cxy340 (12:19) | 64629 | 45358 | 8983 | 6241 | 0/0/0/0 | cancelled | 13/12/6 | 4/2 | 0 |
| …xb6yu6 (12:11) | 63919 | 45358 | 8983 | 6249 | 0 +notes205/0/0 | final-ready | 1/0/0 | 0/0 | 0 |
| …gcyrjn (12:07) | 63926 | 45358 | 8983 | 6261 | 0/0/0/0 | cancelled | 3/3/1 | 1/0 | 0 |
| …qb8jot (12:06) | 64000 | 45358 | 8983 | 6265 | 0/0/0/0 | rate-limited | 1/0/0 | 0/0 | 0 |
| …83stt2 (12:04) | 67053 | 45358 | 8983 | 6265 | 0 +notes205/0/0 (+plan 3166, skills 320) | final-ready | 2/1/0 | 0/0 | 0 |

Reading: every turn is ~64–67k chars with workspace fixed at 45358 (68%);
memory sections keep 0 (activeMemory ~2k flows as its own section, notes
occasionally 179–205); longTerm/recent/research always fully omitted;
no compactions fired in these 5 (short runs; 2 cancelled, 1 rate-limited).
Checkpoint compare: same 5 prompts → total ≤28000, memory ≥6000 kept,
menu complete (no silent cuts), compactions only when genuinely full.
