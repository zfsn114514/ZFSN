@echo off
setlocal
cd /d "%~dp0"

git add -- bili_videos.json assets/bili
if errorlevel 1 goto failed

git commit --only -m "Update Bilibili data" -- bili_videos.json assets/bili
if errorlevel 1 goto failed

echo SUCCESS: Bilibili data saved locally.
echo Now run your GitHub update BAT.
goto done

:failed
echo STOP: Please check the message above.

:done
pause
endlocal