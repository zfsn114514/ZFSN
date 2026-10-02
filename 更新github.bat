@echo off
chcp 65001 >nul

rem 切到本脚本所在目录 —— 右键「以管理员身份运行」时工作目录会变成 System32,
rem 不切的话 git 会报 not a git repository.
cd /d "%~dp0"

echo.
echo ============================================
echo   ZFSN 站点 - 更新到 GitHub
echo   目录: %CD%
echo ============================================
echo.

rem 不用 goto/label: 本脚本改了控制台代码页(chcp 65001),
rem 而 cmd 在代码页切换后跳转标签有已知的定位错乱问题, 所以全部用 if/else 结构.
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [X] 当前目录不是 Git 仓库, 无法继续.
  echo.
  pause
  exit /b 1
)

echo [1/3] 暂存改动 ...
git add .

rem git diff --cached --quiet 在「有改动」时返回 1.
rem 这一步是为了避开 "nothing to commit, working tree clean" ——
rem 它看起来像报错(退出码也是 1), 其实只是没东西可提交.
git diff --cached --quiet
if errorlevel 1 (
  echo [2/3] 提交改动 ...
  rem 提交信息从 .commitmsg.txt 读, 避免中文经控制台代码页时被转成乱码
  git commit -F "%~dp0.commitmsg.txt"
) else (
  echo [2/3] 没有新改动, 跳过提交.
)

echo [3/3] 推送到 GitHub ...
rem git 在国内推 GitHub 时偶发 schannel / Recv failure（握手被重置）。
rem 这是网络层抖动，不是提交内容有问题 —— 加几次重试基本都能过。
rem 之所以用 start /wait 而不是直接重跑 git push，是因为有时候它会卡住不退，
rem 必须 kill 才能继续，所以每次都给一个独立的限时窗口。
set PUSH_OK=0
setlocal enabledelayedexpansion
for /l %%R in (1,1,4) do (
  if "!PUSH_OK!"=="0" (
    echo    推送第 %%R / 4 次 ...
    start /wait /min "" git push
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
