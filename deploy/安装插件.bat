@echo off
rem One-click DSH plugin installer (Windows). ASCII-only to avoid cmd codepage issues.
powershell -NoProfile -ExecutionPolicy Bypass -Command "node \"%~dp0install-plugin.cjs\" %*"
echo.
pause
