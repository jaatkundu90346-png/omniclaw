@echo off
setlocal
cd /d "%~dp0"
node scripts\windows-launcher.mjs --pause
