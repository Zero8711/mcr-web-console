@echo off
cd /d "%~dp0"
echo Filling office-dist with the files a lab PC needs.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-office.ps1"
if errorlevel 1 (
  echo Pack failed.
  exit /b 1
)
echo.
echo Copy the office-dist folder to the lab PC.
echo Do not copy only mcr_console.bat.
