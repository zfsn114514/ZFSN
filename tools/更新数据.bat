@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   ZFSN 网站数据更新
echo ============================================
echo.

REM ── 找 Python ──
REM 优先用正式安装的 Python（模块最全），
REM 找不到才退回 ComfyUI 自带的嵌入式版本。
set PY=
if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" set PY=%LOCALAPPDATA%\Programs\Python\Python314\python.exe
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not defined PY if exist "C:\ComfyUI\python_embeded\python.exe" set PY=C:\ComfyUI\python_embeded\python.exe
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
REM 中文输出统一按 UTF-8，避免个别环境下 UnicodeEncodeError
set PYTHONIOENCODING=utf-8

echo --------------------------------------------
echo [1/5] Steam 游戏库（自己拥有，需 API Key）
echo --------------------------------------------
echo 提示：这一步需要有效的 Steam API Key。
echo       若 Key 失效，本步骤会报错并**保留旧数据**，站点不受影响。
echo       重新申请：https://steamcommunity.com/dev/apikey
echo.
"%PY%" build_steam_owned.py
echo.

echo --------------------------------------------
echo [2/5] Steam 家庭共享游戏（需 API Key）
echo --------------------------------------------
echo 说明：读出本机 Steam 的家庭组成员，逐个查他们的完整游戏库取并集，
echo       再减去自己拥有的 = 家庭共享游戏（含**没下载过**的那些）。
echo       需要每位成员的「游戏详情」隐私设为公开。
echo       首次运行要查 300+ 个商店接口（约 10 分钟），之后有缓存很快。
echo       必须跑在 [1/5] 之后 —— 它要读 steam_games.json 做差集。
echo.
"%PY%" build_steam_family.py
echo.

echo --------------------------------------------
echo [3/5] B站 投稿 + 账号数据（含封面下载）
echo --------------------------------------------
echo 提示：B站 有风控限制，脚本内置了自动退避重试。
echo       若最终仍失败，等 5~10 分钟再运行即可，旧数据不会被覆盖。
echo       投稿较多时本步骤可能要几分钟，请耐心等待。
echo.
"%PY%" build_bili.py
echo.

echo --------------------------------------------
echo [4/5] 补全 B站 账号信息与视频互动数据
echo --------------------------------------------
echo 说明：上一步若因风控拿不到账号信息（昵称/粉丝/获赞），
echo       本步骤会用另一组限流较松的接口单独补齐。
echo.
"%PY%" build_bili_profile.py
echo.

echo --------------------------------------------
echo [5/5] 抓取 Xbox 游戏封面（微软官方商店）
echo --------------------------------------------
echo 提示：Xbox 游玩时长/成就无法通过接口获取，
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
echo 想单独重跑某一步？直接在 tools 目录执行对应的 .py 即可，
echo 各脚本互不影响。详见 tools\README.md
echo.
pause
