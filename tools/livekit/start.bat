@echo off
REM ZFVoice local media backend - one click launcher (Windows CMD).
REM Keep this file ASCII-only: batch files are read with the OEM codepage.
REM Chinese output and instructions come from voice-media-server.mjs / README.md.
chcp 65001 >nul
cd /d "%~dp0..\.."
echo.
echo   ZF Voice - local media backend
echo   Account / login / channel data stays on Cloudflare Worker.
echo   Keep this window open. Ctrl+C or close it to stop both services.
echo.
node --no-warnings tools/livekit/voice-media-server.mjs run
echo.
pause
