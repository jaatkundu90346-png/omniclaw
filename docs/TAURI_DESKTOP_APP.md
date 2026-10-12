# OmniClaw Tauri Desktop App

## Purpose
OmniClaw's easy setup path is:

1. Start with the current no-dependency Windows launcher.
2. Wrap the local gateway in a lightweight Tauri desktop window.
3. Bundle the gateway as a sidecar.
4. Ship a signed Windows installer.

This keeps OmniClaw closer to the lightweight RAM target than an Electron shell.

## Current State
The repository now contains the minimum Tauri v2 project structure:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/build.rs`
- `src-tauri/src/main.rs`
- `src-tauri/capabilities/default.json`

The app window opens `http://localhost:3147`, which is the OmniClaw gateway dashboard.

Production builds are now wired for a gateway sidecar:

- `bundle.externalBin` includes `binaries/omniclaw-gateway`
- Rust starts the sidecar first in production
- the shell falls back to `node server.js` when the sidecar is not present

## Commands
Check whether this machine can build the desktop app:

```powershell
npm run desktop:check
```

Run the Tauri dev shell after prerequisites are installed:

```powershell
npm run desktop:dev
```

Build the native desktop app after prerequisites are installed:

```powershell
npm run desktop:build
```

Build just the gateway sidecar:

```powershell
npm run sidecar:build
```

## Prerequisites For Native Builds
Packaging requires:

- Node.js
- Rust toolchain with `cargo` and `rustc`
- Tauri CLI, installed locally by `npm install`
- Microsoft WebView2 runtime on Windows

The check script reports what is missing but intentionally does not install external toolchains.

## Next Packaging Step
The next high-value step is verifying gateway sidecar bundling on a Rust-enabled machine:

- build or package `server.js` plus required assets
- start/stop the sidecar from the desktop shell
- write gateway logs into the app data directory
- remove dependency on a manually installed Node runtime

After that, OmniClaw can move from "developer desktop shell" toward a real one-click `.exe` installer.
