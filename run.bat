@echo off
cd /d "%~dp0"
echo Starting VeganSurge on http://localhost:8520 ...
start "" http://localhost:8520
py -m uvicorn server.main:app --port 8520
