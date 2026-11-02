@echo off
setlocal
title Preparar panel de combustible - Resiter
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\lanzar.ps1" -Accion instalar
pause
endlocal
