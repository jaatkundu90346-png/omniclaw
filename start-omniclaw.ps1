$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
node .\scripts\windows-launcher.mjs --pause
