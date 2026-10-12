# OmniClaw Gateway Sidecar Packaging

## Goal
The installed desktop app should start OmniClaw without asking the user to open a terminal or install Node.js manually.

The packaging path is:

1. Compile the Node.js gateway entry into a self-contained binary.
2. Rename it with Tauri's target triple suffix.
3. Stage it in `src-tauri/binaries`.
4. Let Tauri bundle it through `bundle.externalBin`.
5. Start the sidecar from the Rust desktop shell in production builds.

## Current Files
- `sidecar/omniclaw-gateway.mjs` starts `server.js` with desktop sidecar defaults.
- `scripts/build-gateway-sidecar.mjs` compiles and stages the binary.
- `src-tauri/binaries/.gitkeep` reserves the sidecar output folder.
- `src-tauri/tauri.conf.json` registers `binaries/omniclaw-gateway` as an external binary.
- `src-tauri/src/main.rs` tries the bundled sidecar first, then falls back to `node server.js`.

## Commands
Install project-local packaging tools:

```powershell
npm install
```

Check sidecar staging:

```powershell
npm run sidecar:check
```

Build and stage the gateway sidecar:

```powershell
npm run sidecar:build
```

Build the full desktop app:

```powershell
npm run desktop:build
```

## Notes
The sidecar filename must include the Rust target triple, for example:

```text
src-tauri/binaries/omniclaw-gateway-x86_64-pc-windows-msvc.exe
```

The build script gets this from `rustc --print host-tuple`, with a fallback to `rustc -Vv`.

## Remaining Packaging Work
- Verify `@yao-pkg/pkg` can bundle OmniClaw's ESM module graph cleanly.
- Move writable runtime state to a user data directory for installed builds.
- Add app icon assets.
- Run the first real Tauri build once Rust is installed.
- Sign the installer for Windows SmartScreen trust.
