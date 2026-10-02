@echo off
rem ============================================================
rem  ZFSN site - push to GitHub
rem  After this succeeds, Cloudflare auto-rebuilds in ~1 min.
rem  ASCII-only REMs to avoid cmd parser choking on CJK under
rem  chcp 65001 (which would print lines like
rem    'CJK text' is not recognized as an internal command
rem  and confuse the user).
rem ============================================================

rem Switch to the script's own directory. Running as admin changes
rem the cwd to System32; without this git complains about not
rem being inside a repository.
cd /d "%~dp0"

rem Locate git.exe. The PATH inherited from a double-clicked .bat
rem is often incomplete, so fall back to common install paths.
set GIT=
for %%G in (git.exe) do set GIT=%%~$PATH:G
if not defined GIT if exist "C:\Program Files\Git\cmd\git.exe" set GIT=C:\Program Files\Git\cmd\git.exe
if not defined GIT if exist "C:\Program Files\Git\bin\git.exe" set GIT=C:\Program Files\Git\bin\git.exe
if not defined GIT (
  echo [X] git.exe not found. Install Git for Windows or add it to PATH.
  echo     Download: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   ZFSN 站点 - 更新到 GitHub
echo   目录: %CD%
echo   Git: %GIT%
echo ============================================
echo.

rem Verify we're inside a git repo before doing anything destructive.
"%GIT%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [X] Current directory is not a git repository.
  echo.
  pause
  exit /b 1
)

echo [1/3] Staging changes ...
"%GIT%" add .

rem diff --cached --quiet exits 1 when there ARE staged changes,
rem and exits 0 when there are none. Branch on that to skip the
rem "nothing to commit" message.
"%GIT%" diff --cached --quiet
if errorlevel 1 (
  echo [2/3] Committing ...
  rem Read the message from .commitmsg.txt to avoid CJK getting
  rem garbled when piped through the console code page.
  "%GIT%" commit -F "%~dp0.commitmsg.txt"
) else (
  echo [2/3] No new changes, skipping commit.
)

echo [3/3] Pushing to GitHub ...
rem From CN ISPs, git push to github.com occasionally hits
rem schannel / Recv failure (TLS handshake reset). It's a
rem transient network blip, not a content problem - retry.
rem Plain retry loop is enough; do NOT use start /wait here
rem (it interacted badly with chcp 65001 + CJK REMs).
set PUSH_OK=0
for /l %%R in (1,1,4) do (
  if "!PUSH_OK!"=="0" (
    echo    Attempt %%R / 4 ...
    "%GIT%" push
    if not errorlevel 1 set PUSH_OK=1
  )
)

if "!PUSH_OK!"=="0" (
  echo.
  echo [X] Push failed. Please screenshot the errors above.
  echo     If it says rejected / non-fast-forward,
  echo     it means the remote has commits you don't have locally.
  echo     Fix: run  git pull --rebase  then re-run this script.
) else (
  echo.
  echo [OK] Done. Cloudflare will auto-rebuild in ~1 minute.
)

echo.
pause
