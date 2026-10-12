# Swaps the freshly-built gateway exe into place. Run this AFTER fully quitting
# OmniClaw (the running exe is file-locked while the app is open).
# NOTE: ASCII only in this file - Windows PowerShell 5.1 reads BOM-less .ps1 as
# ANSI, so an em-dash or smart quote breaks the parser and the deploy never runs.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$staged = Join-Path $root "src-tauri\binaries\omniclaw-gateway-x86_64-pc-windows-msvc.exe"
$target = Join-Path $root "omniclaw-gateway.exe"

if (-not (Test-Path $staged)) { throw "Staged build not found. Run: npm run sidecar:build" }

# Bail out early with a clear message if the app is still running.
try {
  $fs = [System.IO.File]::Open($target, 'Open', 'ReadWrite', 'None')
  $fs.Close()
} catch {
  throw "omniclaw-gateway.exe is locked - OmniClaw is still running. Quit it fully (check the tray) and re-run this script."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $target "$target.bak-$stamp" -Force
Copy-Item $staged $target -Force
Write-Host "Deployed new gateway exe. Backup: omniclaw-gateway.exe.bak-$stamp"
Write-Host "Restart OmniClaw to load it."
