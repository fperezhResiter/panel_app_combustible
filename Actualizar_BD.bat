@echo off
setlocal
title Actualizar combustible - Resiter
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\lanzar.ps1" -Accion actualizar
pause
endlocal
