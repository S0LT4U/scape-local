@echo off
rem Launch Scape Local without leaving a console window open.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
