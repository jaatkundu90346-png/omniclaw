# OpenClaw Vendor Import

Date: 2026-05-06

## What Was Added

OpenClaw is attached as a Git submodule at:

```text
vendor/openclaw
```

The submodule points to:

```text
https://github.com/openclaw/openclaw.git
```

This is intentionally a reference import, not a source dump. OmniClaw keeps its own runtime, UI, data model, and build pipeline intact while using OpenClaw as the architecture donor.

## Why Submodule Instead Of Copy Paste

Directly copying the whole OpenClaw repo into OmniClaw would create duplicate gateways, package managers, config systems, UI routers, state stores, and runtime entrypoints. A submodule gives us the full source for inspection and selective transplant work without breaking OmniClaw.

## License

OpenClaw is MIT licensed. Keep `THIRD_PARTY_NOTICES.md` and the upstream `vendor/openclaw/LICENSE` available whenever OpenClaw code or derived implementation details are distributed.

## Update Commands

Initialize after cloning OmniClaw:

```powershell
git submodule update --init --recursive --depth 1 vendor/openclaw
```

Update the reference later:

```powershell
git submodule update --remote --depth 1 vendor/openclaw
git add .gitmodules vendor/openclaw
git commit -m "Update OpenClaw vendor reference"
```

## Guardrails

- Do not run OpenClaw package scripts from the OmniClaw root.
- Do not merge OpenClaw `package.json`, `pnpm-lock.yaml`, `dist`, or workspace config directly into OmniClaw.
- Do not copy secrets or local OpenClaw workspace data.
- Prefer adapters around OpenClaw concepts over rewriting OmniClaw around OpenClaw internals.
- Any copied source must keep MIT attribution and be reduced to the smallest useful module.

## OmniClaw Tools Added

- `openclaw_vendor_status`: verifies that the submodule is present and reports version/license/source status.
- `openclaw_skill_scan`: scans `vendor/openclaw/skills` or `vendor/openclaw/extensions` for `SKILL.md` files.
- `openclaw_skill_import`: imports one selected OpenClaw skill into OmniClaw's local `.skill` format.

Import should stay selective. Scan first, then import only the skill that matches the current OmniClaw feature gap.
