@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>&1
if errorlevel 1 goto failed
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto failed
for /f "delims=" %%B in ('git branch --show-current') do set "CURRENT_BRANCH=%%B"
if not "%CURRENT_BRANCH%"=="main" (
  echo STOP: Please switch to main first. Current branch: %CURRENT_BRANCH%
  goto failed
)
git diff --quiet
if errorlevel 1 goto dirty
git diff --cached --quiet
if errorlevel 1 goto dirty
git rev-parse -q --verify MERGE_HEAD >nul 2>&1
if not errorlevel 1 (
  echo STOP: An earlier merge is unfinished. Resolve it first.
  goto failed
)
echo [1/2] Fetching GitHub updates...
git fetch origin
if errorlevel 1 goto failed
echo [2/2] Merging origin/main and preserving local commits...
git -c core.editor=true merge --no-edit origin/main
if errorlevel 1 goto failed
echo.
echo SUCCESS: Updated. Local commits were preserved. Nothing was pushed.
echo Refresh your browser with Ctrl+F5.
goto done
:dirty
echo STOP: Tracked files have local changes. Save them before updating.
git status --short
echo No files were discarded.
goto failed
:failed
echo.
echo STOP: Check the error above. No reset or force overwrite was used.
pause
exit /b 1
:done
pause
exit /b 0
