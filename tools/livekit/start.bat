@echo off
REM LiveKit Server launcher for ZFVoice OPTIONAL self-hosted mode (Windows CMD).
REM Keep this file ASCII-only: Windows batch files are read with the OEM codepage
REM and non-ASCII characters get garbled. Chinese instructions are in README.md.
setlocal
cd /d "%~dp0"

if not exist "%~dp0livekit.yaml" (
  echo [ERROR] livekit.yaml not found.
  echo         Copy livekit.example.yaml to livekit.yaml and fill in your API keys.
  exit /b 1
)

if exist "%~dp0.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0.env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
)

if "%LIVEKIT_BIN%"=="" set "LIVEKIT_BIN=%~dp0livekit-server.exe"
if not exist "%LIVEKIT_BIN%" (
  echo [ERROR] livekit-server.exe not found: %LIVEKIT_BIN%
  echo         Put the exe next to this script or set LIVEKIT_BIN in .env
  exit /b 1
)

echo Starting LiveKit Server on port 7880 (Ctrl+C to stop) ...
echo Config: %~dp0livekit.yaml
"%LIVEKIT_BIN%" --config "%~dp0livekit.yaml"
endlocal
