@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   ZFSN 网站数据更新
echo ============================================
echo.

REM 找 Python：优先用 ComfyUI 自带的（一定有），否则用系统 Python
set PY=
if exist "C:\ComfyUI\python_embeded\python.exe" set PY=C:\ComfyUI\python_embeded\python.exe
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" set PY=%LOCALAPPDATA%\Programs\Python\Python314\python.exe
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY (
  echo [错误] 找不到 Python。请先安装 Python 3。
  echo.
  pause
  exit /b 1
)
echo 使用 Python: %PY%
echo.

REM 关掉 Python 的 stdout 缓冲，否则日志要等脚本跑完才一次性出现
set PYTHONUNBUFFERED=1

echo --------------------------------------------
echo [1/4] 更新 Steam 游戏库（官方 API，含真实时长）
echo --------------------------------------------
"%PY%" build_steam_api.py
echo.

echo --------------------------------------------
echo [2/4] 更新 B站 投稿 + 账号数据（含封面下载）
echo --------------------------------------------
echo 提示：B站 有风控限制，脚本内置了自动退避重试。
echo       若最终仍失败，等 5~10 分钟再运行即可，旧数据不会被覆盖。
echo       投稿较多时本步骤可能要几分钟，请耐心等待。
echo.
"%PY%" build_bili.py
echo.

echo --------------------------------------------
echo [3/4] 补全 B站 账号信息与视频互动数据
echo --------------------------------------------
echo 说明：上一步若因风控拿不到账号信息（昵称/粉丝/获赞），
echo       本步骤会用另一组限流较松的接口单独补齐。
echo.
"%PY%" build_bili_profile.py
echo.

echo --------------------------------------------
echo [4/4] 抓取 Xbox 游戏封面（微软官方商店）
echo --------------------------------------------
echo 提示：Xbox 游玩时长/成就需从 Xbox 应用导出，
echo       请手动更新 xbox_games.json 后运行本步骤补封面。
echo.
"%PY%" build_xbox_covers.py
echo.

echo ============================================
echo   全部完成
echo ============================================
echo.
echo 网站会立刻生效，刷新浏览器即可看到新数据。
echo.
pause
