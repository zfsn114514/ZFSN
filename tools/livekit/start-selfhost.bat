@echo off
REM =====================================================================
REM  ZF Voice - self-hosted backend one-click launcher
REM  Starts LiveKit SFU + Cloudflare quick tunnel, then AUTO-SYNCS the
REM  new tunnel domain back into the Cloudflare D1 server record, so you
REM  can just open the website and join the self-hosted channel
REM  (voice chat + screen share).
REM
REM  Keep this window OPEN while you use voice chat. Closing it (or
REM  Ctrl+C) stops both LiveKit and the tunnel.
REM
REM  Note: account/login/channel data stays on the Cloudflare Worker.
REM        This computer only relays audio/screen media.
REM =====================================================================
chcp 65001 >nul
cd /d "%~dp0..\.."

set ZF_SYNC_D1=1
set ZF_D1_ID=srv-846b43f492b89b8e
set ZF_D1_DB=zfsn-db

echo.
echo   ZF Voice - starting self-hosted backend (LiveKit + Tunnel)...
echo   Voice + screen share will be available on the website.
echo   Keep this window open; close it to stop the backend.
echo.

node --no-warnings tools/livekit/voice-media-server.mjs run

echo.
echo   Backend stopped. Press any key to close this window.
pause >nul
