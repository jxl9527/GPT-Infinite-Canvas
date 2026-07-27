@echo off
setlocal
set "INSTALLER=%~dp0Install-GPTInfiniteCanvas-DesktopLauncher.ps1"
set "POWERSHELL_EXE="

if not exist "%INSTALLER%" (
  echo [ERROR] Desktop launcher installer is missing:
  echo %INSTALLER%
  pause
  exit /b 1
)

where.exe pwsh.exe >nul 2>&1
if not errorlevel 1 set "POWERSHELL_EXE=pwsh.exe"

if not defined POWERSHELL_EXE (
  if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  )
)

if not defined POWERSHELL_EXE (
  echo [ERROR] PowerShell was not found.
  pause
  exit /b 2
)

"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%"
if errorlevel 1 (
  echo.
  echo [ERROR] GPT Infinite Canvas desktop launcher installation failed.
  pause
  exit /b 3
)

echo.
echo GPT Infinite Canvas desktop launcher is ready.
echo You can now double-click "GPT Infinite Canvas" on the desktop.
pause
exit /b 0
