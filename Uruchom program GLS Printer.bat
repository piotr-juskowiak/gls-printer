@echo off
title GLS Printer Backend
echo ===================================================
echo Uruchamianie GLS Printer... 
echo Zeby wylaczyc serwer zamknij to okienko.
echo ===================================================

cd /d "%~dp0"
node diagnose.js
node server.js

pause
