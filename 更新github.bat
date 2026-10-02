@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem ZFSN 站点 - 更新到 GitHub
rem ============================================================
rem 切到本脚本所在目录 —— 右键「以管理员身份运行」时工作目录会变成 System32,
rem 不切的话 git 会报 not a git repository.
cd /d "%~dp0"

rem 定位 git.exe：先看 PATH，再试常见安装位置。
rem 双击脚本启动时 cmd 的 PATH 经常不全，必须手动兜底。
set GIT=
for %%G in (git.exe) do set GIT=%%~$PATH:G
if not defined GIT if exist "C:\Program Files\Git\cmd\git.exe" set GIT=C:\Program Files\Git\cmd\git.exe
if not defined GIT if exist "C:\Program Files\Git\bin\git.exe" set GIT=C:\Program Files\Git\bin\git.exe
if not defined GIT (
  echo [X] 找不到 git.exe. 请先安装 Git for Windows 或将其加入 PATH.
  echo     下载: https://git-scm.com/download/win
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

rem 不用 goto/label: 本脚本改了控制台代码页(chcp 65001),
rem 而 cmd 在代码页切换后跳转标签有已知的定位错乱问题, 所以全部用 if/else 结构.
"%GIT%" rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [X] 当前目录不是 Git 仓库, 无法继续.
  echo.
  pause
  exit /b 1
)

echo [1/3] 暂存改动 ...
"%GIT%" add .

rem git diff --cached --quiet 在「有改动」时返回 1.
rem 这一步是为了避开 "nothing to commit, working tree clean" ——
rem 它看起来像报错(退出码也是 1), 其实只是没东西可提交.
"%GIT%" diff --cached --quiet
if errorlevel 1 (
  echo [2/3] 提交改动 ...
  rem 提交信息从 .commitmsg.txt 读, 避免中文经控制台代码页时被转成乱码
  "%GIT%" commit -F "%~dp0.commitmsg.txt"
) else (
  echo [2/3] 没有新改动, 跳过提交.
)

echo [3/3] 推送到 GitHub ...
rem git 在国内推 GitHub 时偶发 schannel / Recv failure (握手被重置).
rem 这是网络层抖动, 不是提交内容有问题 —— 重试几次基本都能过.
rem 直接重跑 git push 即可, 不需要 start /wait (后者在 chcp 65001 下
rem 会被中文 rem 注释干扰 cmd 解析, 错误信息会乱).
set PUSH_OK=0
for /l %%R in (1,1,4) do (
  if "!PUSH_OK!"=="0" (
    echo    推送第 %%R / 4 次 ...
    "%GIT%" push
    if not errorlevel 1 set PUSH_OK=1
  )
)

if "!PUSH_OK!"=="0" (
  echo.
  echo [X] 推送失败! 请把上面的报错信息截图给我.
  echo     如果提示 rejected / non-fast-forward,
  echo     说明远程有别的提交, 先执行  git pull --rebase  再重跑本脚本.
) else (
  echo.
  echo [OK] 全部完成. Cloudflare 大约 1 分钟后会自动重新部署.
)

echo.
pause
