// Slash CONTROL commands — session-scoped runtime toggles that steer the agent
// loop, distinct from the info/runtime slash commands routed via intents
// (/doctor, /model, /skills) and the local-handler commands (/mcp, /harness).
//
// These were documented (THINKING.md / CHANNEL_DOCKING.md) but had NO handler:
// typing "/think" did nothing and the literal text was sent to the model as a
// task. This parses leading control commands, applies them to per-session
// state, and strips them so any remaining text runs as the real task.
//
// Supported:
//   /think [hard|deep|off]      -> reasoning effort (think hard = high)
//   /no-think | /nothink        -> reasoning off
//   /reasoning <level>          -> minimal|low|medium|high|off
//   /fast [on|off]              -> quick mode (lower reasoning + fewer rounds)
//   /verbose [on|off]           -> fuller tool-output visibility
//   /steer <text>               -> inject text into a running agent (terminal)

const REASONING_LEVELS = new Set(["minimal", "low", "medium", "high", "off"]);

function onOff(token, dflt = true) {
  if (token == null) return dflt;
  const t = String(token).toLowerCase();
  if (["off", "no", "false", "0", "disable"].includes(t)) return false;
  if (["on", "yes", "true", "1", "enable"].includes(t)) return true;
  return dflt;
}

/**
 * Parse leading control commands off a message.
 * @returns {{
 *   recognized: boolean,
 *   controls: { reasoningEffort?: string, fast?: boolean, verbose?: boolean },
 *   steerText: string|null,
 *   strippedMessage: string,
 *   acks: string[],
 *   pureCommand: boolean
 * }}
 */
export function parseControlCommands(message) {
  let rest = String(message == null ? "" : message);
  const controls = {};
  const acks = [];
  let steerText = null;
  let recognized = false;

  // Loop while the message starts with a recognized control command.
  for (;;) {
    const m = rest.match(/^\s*\/([a-z][a-z-]*)\b[ \t]*(.*)$/is);
    if (!m) break;
    const cmd = m[1].toLowerCase();
    const tail = m[2];

    if (cmd === "steer") {
      // /steer consumes the REST of the message as the steer payload.
      steerText = tail.trim();
      recognized = true;
      rest = "";
      acks.push(steerText ? "Steering the running agent with your note." : "Usage: /steer <text>");
      break;
    }

    if (cmd === "think" || cmd === "thinking") {
      const arg = tail.match(/^(hard|deep|high|on|off|no|none)\b\s*([\s\S]*)$/i);
      if (arg) {
        const a = arg[1].toLowerCase();
        controls.reasoningEffort = (a === "off" || a === "no" || a === "none") ? "off" : "high";
        rest = arg[2];
      } else {
        controls.reasoningEffort = "high";
        rest = tail;
      }
      acks.push(controls.reasoningEffort === "off" ? "Thinking off." : "Thinking hard (high reasoning effort).");
      recognized = true;
      continue;
    }

    if (cmd === "no-think" || cmd === "nothink") {
      controls.reasoningEffort = "off";
      acks.push("Thinking off.");
      recognized = true;
      rest = tail;
      continue;
    }

    if (cmd === "reasoning") {
      const arg = tail.match(/^(\S+)\s*([\s\S]*)$/);
      const level = arg ? arg[1].toLowerCase() : "";
      if (REASONING_LEVELS.has(level)) {
        controls.reasoningEffort = level;
        acks.push(`Reasoning effort: ${level}.`);
        recognized = true;
        rest = arg[2];
        continue;
      }
      // Unknown level — don't consume; let it fall through as normal text.
      break;
    }

    if (cmd === "fast") {
      const arg = tail.match(/^(on|off|yes|no|enable|disable|true|false|1|0)\b\s*([\s\S]*)$/i);
      controls.fast = onOff(arg ? arg[1] : undefined, true);
      rest = arg ? arg[2] : tail;
      acks.push(controls.fast ? "Fast mode on (quicker, lighter reasoning)." : "Fast mode off.");
      recognized = true;
      continue;
    }

    if (cmd === "verbose") {
      const arg = tail.match(/^(on|off|yes|no|enable|disable|true|false|1|0)\b\s*([\s\S]*)$/i);
      controls.verbose = onOff(arg ? arg[1] : undefined, true);
      rest = arg ? arg[2] : tail;
      acks.push(controls.verbose ? "Verbose tool output on." : "Verbose tool output off.");
      recognized = true;
      continue;
    }

    // Not a control command — stop (leave it for info-intent / model handling).
    break;
  }

  const strippedMessage = rest.trim();
  const pureCommand = recognized && !steerText && strippedMessage === "";
  return { recognized, controls, steerText, strippedMessage, acks, pureCommand };
}

/** Apply parsed controls onto a session control state object (mutates + returns). */
export function applySessionControls(state = {}, controls = {}) {
  const next = { ...state };
  if (controls.reasoningEffort !== undefined) next.reasoningEffort = controls.reasoningEffort;
  if (controls.fast !== undefined) next.fast = controls.fast;
  if (controls.verbose !== undefined) next.verbose = controls.verbose;
  return next;
}

/** Translate a session control state into a provider `reasoning` request option. */
export function reasoningOptionFor(state = {}) {
  // Fast mode implies minimal thinking unless an explicit effort was set.
  const effort = state.reasoningEffort || (state.fast ? "minimal" : undefined);
  if (!effort) return undefined;       // leave provider/config default in place
  if (effort === "off") return false;  // explicit disable (sentinel)
  return { effort };
}
