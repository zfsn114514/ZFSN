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

REM ── 找 Node ──
REM [3/5] 的 B站 投稿列表要靠 Node 驱动无头 Chrome，没有 Node 就跳过该步。
set NODE=
if exist "%ProgramFiles%\nodejs\node.exe" set NODE=%ProgramFiles%\nodejs\node.exe
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set NODE=node
)
if defined NODE (echo 使用 Node: %NODE%) else (echo [提示] 没找到 Node.js，B站 投稿列表步骤将被跳过)
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
echo [3/5] B站 投稿列表（无头 Chrome 抓取）
echo --------------------------------------------
echo 说明：B站 的投稿列表接口 /x/space/wbi/arc/search 对本机 IP 是
echo       **IP 级风控封禁**（HTTP 412）。实测换 UA、补 dm_img_* 风控参数、
echo       刷新 buvid cookie、换旧版接口、换 APP 端接口 —— 全部无效。
echo       所以本步骤改用**真实 Chrome** 渲染空间页，再把页面自己发出的
echo       接口响应钩下来，从而拿到**全部投稿**（含翻页）。
echo.
echo       注意：风控是「概率性放行」，脚本会自动重试若干轮，通常 1~3 分钟。
echo             需要本机装了 Chrome 与 Node.js。
echo.
if not defined NODE (
  echo [跳过] 没找到 Node.js，无法抓全量投稿列表。
  echo        下一步会退回用「现有 bili_videos.json 里的列表」继续补数据，
  echo        站点不受影响，只是拿不到新投稿。
  echo        想抓全量请先安装 Node.js： https://nodejs.org/
) else (
  "%NODE%" fetch_bili_list_cdp.js
)
echo.

echo --------------------------------------------
echo [4/5] B站 详情 + 封面 + 账号信息
echo --------------------------------------------
echo 说明：读上一步的投稿列表，逐条补齐 点赞/投币/收藏/分区，
echo       并把封面下载到 assets/bili/（B站 CDN 有防盗链，必须本地化）。
echo       108 条大约 5 分钟。
echo       昵称/签名/等级走 m.bilibili.com 的 SSR 数据（acc/info 常年被风控）。
echo       上一步失败时本步骤会用现有列表兜底，旧数据不会被覆盖。
echo.
"%PY%" build_bili_full.py
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
