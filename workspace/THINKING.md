# THINKING.md - OmniClaw Shared Thinking Controls

summary: Thinking levels, fast mode, verbose/trace, and reasoning visibility.

## Thinking

Supported canonical levels:

- off
- minimal
- low
- medium
- high
- xhigh
- adaptive
- max

Directives include `/t <level>`, `/think:<level>`, and `/thinking <level>`.

Resolution order:

1. inline directive
2. session override
3. per-agent default
4. global default
5. provider default or nearest supported level

Unsupported levels should be rejected or safely mapped by provider profile.

## Fast

`/fast on|off|default` toggles speed/priority mode when the provider supports it.

## Verbose And Trace

`/verbose off|on|full` controls visible tool summaries. Full may include truncated tool output.

`/trace on|off` exposes plugin-owned diagnostics such as Active Memory debug summaries.

## Reasoning Visibility

`/reasoning off|on|stream` controls safe visible reasoning summaries/blocks. Never leak private chain-of-thought.
