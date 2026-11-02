@echo off
setlocal
title Panel de combustible - Resiter
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\lanzar.ps1" -Accion iniciar
if errorlevel 1 pause
endlocal
