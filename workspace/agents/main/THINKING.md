# THINKING.md - OmniClaw Main Agent Thinking Controls

summary: Thinking levels, fast mode, verbose/trace, and reasoning visibility.

Use thinking directives to tune effort, not to expose private chain-of-thought.

## Levels

- off
- minimal
- low
- medium
- high
- xhigh
- adaptive
- max

Aliases: x-high, x_high, extra-high, extra high, extra_high -> xhigh; highest -> high.

## Directives

- `/t <level>`
- `/think:<level>`
- `/thinking <level>`
- `/fast on|off|default`
- `/verbose off|on|full`
- `/trace on|off`
- `/reasoning off|on|stream`

## Rule

Provider profiles decide which levels are valid. Reject unsupported typed levels or map stale stored levels safely. Never leak private reasoning.
