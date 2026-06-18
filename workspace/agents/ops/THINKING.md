# THINKING.md - OmniClaw Thinking And Visibility

summary: Thinking-level directives, fast mode, verbose/trace, and reasoning visibility.

## Thinking Directives

Users can request reasoning effort with directives such as:

- /t <level>
- /think:<level>
- /thinking <level>

Canonical levels:

- off
- minimal
- low
- medium
- high
- xhigh
- adaptive
- max

Aliases such as x-high, extra-high, extra high, and extra_high map to xhigh. highest maps to high.

## Resolution Order

1. inline directive on the current message
2. session override
3. per-agent default
4. global default
5. provider-declared default or nearest supported level

Unsupported levels should be rejected or mapped by provider profile, not blindly sent.

## Fast Mode

/fast supports on/off/default. It is a session override unless used inline. It maps to provider-specific priority/high-speed behavior only when supported.

## Verbose And Trace

/verbose controls visible tool summaries:

- off
- on
- full

Verbose on should show compact tool progress. Full may show truncated outputs. Tool failures remain visible even in normal mode, but raw details require full.

/trace is narrower than verbose. It exposes plugin-owned debug lines such as Active Memory diagnostics.

## Reasoning Visibility

/reasoning or /reason can control whether reasoning blocks are visible:

- off
- on
- stream

Reasoning should be separate from final answers and hidden by default unless explicitly enabled.

## UI Contract

The chat UI picker should mirror stored session thinking level and write overrides immediately. The first option clears the override and inherits default.

## Safety

Never leak private chain-of-thought. If reasoning is shown, show safe summaries or provider-supported reasoning blocks only. Malformed local-model thinking tags should be stripped from normal replies.
