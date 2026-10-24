@echo off
setlocal
cd /d "%~dp0"
git rev-parse --show-toplevel >nul 2>&1
if errorlevel 1 goto failed
git add -- bili_videos.json assets/bili
if errorlevel 1 goto failed
git diff --cached --quiet -- bili_videos.json assets/bili
if not errorlevel 1 goto unchanged
git commit --only -m "Update Bilibili data" -- bili_videos.json assets/bili
if errorlevel 1 goto failed
echo SUCCESS: Bilibili data saved locally.
echo You may now run your GitHub update BAT.
echo This script does not push to GitHub.
goto done
:unchanged
echo No Bilibili data changes to save.
goto done
:failed
echo STOP: Please check the error above. No force overwrite was used.
:done
pause
endlocal
