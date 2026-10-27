@echo off
REM Scientia In Situ for this Windows user (V3.928). Run it from the extracted folder (right-click the zip, Extract All).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Something went wrong - see the message above.
  pause
) else (
  timeout /t 6 >nul
)
