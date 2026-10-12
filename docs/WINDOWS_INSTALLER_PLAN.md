# OmniClaw Windows Installer Plan

## Goal
The user experience should be:

1. Download OmniClaw installer.
2. Install.
3. Click desktop icon.
4. OmniClaw starts the local gateway and opens the dashboard.

## Current Phase: Launcher + Desktop Shell Scaffold
This repo now includes a no-dependency Windows launcher:

- `start-omniclaw.bat`
- `start-omniclaw.ps1`
- `scripts/windows-launcher.mjs`
- `scripts/install-windows-shortcut.mjs`

The launcher:

- checks whether `http://localhost:3147/api/health` is already running
- starts `server.js` if needed
- writes launcher logs into `logs`
- stores the last launched PID in `data/omniclaw.pid`
- opens the browser at `http://localhost:3147`

It also includes a Tauri v2 desktop-shell scaffold:

- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/build.rs`
- `src-tauri/src/main.rs`
- `src-tauri/capabilities/default.json`
- `scripts/check-desktop-prereqs.mjs`
- `sidecar/omniclaw-gateway.mjs`
- `scripts/build-gateway-sidecar.mjs`

The desktop shell is the recommended path for a lightweight `.exe` because it uses the Windows WebView2 runtime instead of bundling a full Chromium browser.

The Tauri shell is now wired for a gateway sidecar through `bundle.externalBin`. Production startup tries the bundled sidecar first, then falls back to `node server.js` for developer builds.

## Create Desktop Shortcut
Run:

```powershell
node scripts/install-windows-shortcut.mjs
```

This creates `OmniClaw.lnk` on the current user's Desktop.

## Check Desktop Build Readiness
Run:

```powershell
npm run desktop:check
```

This checks:

- Node.js
- Rust `cargo`
- Rust `rustc`
- Tauri CLI
- Tauri config files

It does not install anything. Use `-- --strict` when you want the command to fail if a native build prerequisite is missing.

## Build Desktop App
After Rust and Tauri CLI are installed, run:

```powershell
npm install
npm run desktop:build
```

`npm install` installs the project-local Tauri CLI and sidecar compiler declared in `package.json`. This is the future `.exe` build path. The sidecar pipeline is wired, but it still needs a Rust-enabled machine to verify the first real native package.

Build only the sidecar:

```powershell
npm run sidecar:build
```

## Next Packaging Options

### Option A: Tauri Installer
Best for low RAM and an installable Windows desktop app.

Pros:
- much lighter desktop shell
- uses system WebView2 on Windows
- good fit for OmniClaw's lightweight target

Cons:
- needs Rust and Tauri CLI during packaging
- sidecar binary verification still needs a Rust-enabled machine

### Option B: Electron Installer
Best for a polished `.exe` app with a real desktop window.

Pros:
- familiar installer flow
- desktop window instead of only browser
- auto-update path is mature

Cons:
- heavier RAM footprint than pure Node/browser
- adds dependencies

### Option C: Node SEA + NSIS
Best for keeping the gateway process lightweight.

Pros:
- closer to current no-dependency architecture
- can bundle server into one executable

Cons:
- frontend assets and runtime files still need installer packaging
- more custom build work

## Recommended Path
Use the launcher now, continue Phase 2 with Tauri sidecar packaging, then add app icons, app-data storage, and installer signing. Use Electron only if fast product polish matters more than RAM.
