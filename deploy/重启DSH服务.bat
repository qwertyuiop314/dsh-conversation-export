@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-dsh-web.ps1"
echo.
pause
