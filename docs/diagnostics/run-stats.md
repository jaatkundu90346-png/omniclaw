# run stats (last 50 runs)

## stoppedReason
- model-final-ready: 12 (24%)
- cancelled: 7 (14%)
- provider-rate-limited: 6 (12%)
- provider-error: 6 (12%)
- provider-auth-error: 5 (10%)
- stuck-no-progress: 4 (8%)
- NONE: 3 (6%)
- max_rounds: 2 (4%)
- model-final-from-reasoning: 1 (2%)
- budget-exhausted: 1 (2%)
- provider-billing: 1 (2%)
- provider-model-not-found: 1 (2%)
- finish-tool: 1 (2%)

## rounds/toolcalls/failed (median/p90/avg)
- rounds: 2/16/5.4
- toolCalls: 1/26/6.8
- failed: 0/8/2.2

## top failing tools
- read_file: 39 ("❌ TOOL ERROR: File not found: PROGRESS.md (attempted absolute path: C:\Users\PATEL COMPUTERS\Desktop\new window\PROGRESS" x4)
- load_toolset: 7 ("❌ TOOL ERROR: Unknown toolset: popular-web-designs. Call list_toolsets for names. {"error":true,"message":"Unknown tools" x4)
- apply_patch: 4 ("❌ TOOL ERROR: Patch must include *** Begin Patch and *** End Patch. {"error":true,"message":"Patch must include *** Begi" x4)
- update_plan: 4 ("⛔ TOOL BLOCKED: Missing required argument(s): steps (array). update_plan was called with EMPTY/incomplete arguments — th" x4)
- write_file: 2 ("⛔ TOOL BLOCKED: "C:\Users\PATEL COMPUTERS\Desktop\new window\index.html" already exists. Read it with read_file first (s" x1)
- edit: 1 ("❌ TOOL ERROR: Find text not found in file (tried exact + fuzzy matching). Re-read the file (read_file shows line numbers" x1)

## compaction
- runs w/ truncate-compaction: 0
- runs w/ LLM summary: 0
- runs w/ digest: 15
- runs w/ overflow-recovery: 0
- followups (round,status -> next 2):
  - (none)

## finish
- runs ending via real finish call: 0 (calls: 0)
- finish-tool stopReasons in gateway: 1

## nudges (totals across 47 embedded reports; 9 runs nudged)
- spinNudges: 0
- diagnoseNudges: 0
- actionNudges: 1
- verificationNudges: 0
- reverifyNudges: 0
- actNowNudges: 1
- observationNudges: 1
- buildVerifyNudges: 1
- degenerateNudges: 0
- regressionNudges: 0
- budgetWarned: 3
- lengthCutBlocks: 0
- reasoningLengthCuts: 5
- readBeforeEditBlocks: 1
- staleFileBlocks: 0
- editStrategySwitches: 0

## providers/models
- openai-compatible:inclusionai/ling-3.0-flash-sante:free: 12
- openai-compatible:inclusionai/ling-3.0-flash-vl:free: 10
- openai-compatible:nex-agi/nex-n2.5-pro:free: 9
- openai-compatible:nvidia/nemotron-3-ultra-550b-a55b: 7
- ?:?: 3
- openai-compatible:glm-5.3-flash: 2
- openai-compatible:nex-agi/nex-n2.5-mini:free: 1
- openai-compatible:thinkingmachines/inkling-small:free: 1
- openai-compatible:z-ai/glm-5.3: 1
- openai-compatible:z-ai/glm-5.3-flashx: 1
- openai-compatible:mercury-2.5: 1
- openai-compatible:claude-fable-5.1[1m]: 1
- openai-compatible:nvidia/nemotron-3.5-lightning:free: 1

## recovery/reasoning
- text-mode recovered tool calls: 1
- tool-arg repairs: 0
- runs w/ reasoning tokens: 31, total reasoning tokens: 97767
