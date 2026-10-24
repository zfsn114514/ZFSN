@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  把 GitHub 上的项目拉取到本地（只拉取，不推送）
rem
rem  安全承诺：
rem    * 不 reset、不 force、不 checkout -- .，永不丢弃你的东西
rem    * 本地未提交的改动由 --autostash 临时收起，合并完自动放回
rem    * 本地自己的提交会保留，不会被覆盖
rem
rem  设计要点（踩过的坑，别改回去）：
rem    1. 不用 for /f ('...') 包住含 "-c key=value" 的 git 命令 ——
rem       cmd 会把 = 拆开，git 收到 "false" 当作子命令。
rem    2. 判"是否已最新"必须显式核对 origin/main 是否存在，
rem       否则 rev-list 失败时 BEHIND 仍是 0，会假装"已是最新"。
rem    3. merge 返回 0 不代表干净：--autostash 放回改动时也会冲突，
rem       所以合并后必须再查一次 unmerged 文件。
rem    4. 两种冲突的善后方式完全不同，必须分开提示：
rem       真合并冲突 -> 仓库停在 MERGE_HEAD，git merge --abort 有效
rem       放回暂存时冲突 -> 合并早已完成，没有 MERGE_HEAD，
rem                       此时 merge --abort 会报 "There is no merge to abort"
rem ============================================================

rem ---------- 0. 环境检查 ----------
where git >nul 2>&1
if errorlevel 1 goto nogit

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto norepo

git rev-parse -q --verify HEAD >nul 2>&1
if errorlevel 1 goto nohead

git remote get-url origin >nul 2>&1
if errorlevel 1 goto noremote

set "BR="
for /f "delims=" %%B in ('git branch --show-current') do set "BR=%%B"
if "%BR%"=="" goto detached
if /i not "%BR%"=="main" goto otherbranch

git rev-parse -q --verify MERGE_HEAD >nul 2>&1
if not errorlevel 1 goto merging

rem ---------- 1. 获取远端信息 ----------
echo [1/3] 正在获取 GitHub 上的最新信息...
call :fetch
if errorlevel 1 goto fetchfail

git rev-parse -q --verify refs/remotes/origin/main >nul 2>&1
if errorlevel 1 goto norefmain

set "BEHIND=0"
for /f "delims=" %%N in ('git rev-list --count HEAD..origin/main 2^>nul') do set "BEHIND=%%N"
set "AHEAD=0"
for /f "delims=" %%N in ('git rev-list --count origin/main..HEAD 2^>nul') do set "AHEAD=%%N"

if "%BEHIND%"=="0" (
  echo.
  echo 本地已经是 GitHub 上的最新版本，没有新提交需要拉取。
  if not "%AHEAD%"=="0" echo 提示：你本地有 %AHEAD% 个提交还没推送上去。
  goto done
)

echo.
echo GitHub 上有 %BEHIND% 个新提交，准备合并进来：
git log --oneline --no-decorate -n 12 HEAD..origin/main
if not "%AHEAD%"=="0" echo 本地另有 %AHEAD% 个自己提交的，合并后都还在。

rem 非快进合并要生成合并提交，缺身份会失败
if "%AHEAD%"=="0" goto domerge
git var GIT_COMMITTER_IDENT >nul 2>&1
if errorlevel 1 goto noident

:domerge
rem ---------- 2. 合并 ----------
echo.
echo [2/3] 开始合并...
if not "%AHEAD%"=="0" echo       你有本地提交，会自动生成一个合并提交。
git -c core.editor=true merge --autostash --no-edit origin/main
set "MRG=%errorlevel%"

rem 冲突要单独判断：merge 返回 0 也可能因为放回 autostash 而留下冲突
set "UNMERGED="
for /f "delims=" %%F in ('git diff --name-only --diff-filter=U') do set "UNMERGED=1"
if defined UNMERGED goto sortconflict
if not "%MRG%"=="0" goto mergefail

echo.
echo [3/3] 完成。
echo 当前版本：
git log --oneline --no-decorate -n 1
echo.
echo 没有推送任何东西到 GitHub。浏览器里按 Ctrl+F5 强制刷新即可看到新版。
goto done

rem ============================================================
:fetch
set /a TRY=0
:fetchloop
set /a TRY+=1
git fetch origin --prune
if not errorlevel 1 exit /b 0
if %TRY% GEQ 3 exit /b 1
echo       第 %TRY% 次失败，2 秒后重试...
ping -n 3 127.0.0.1 >nul
goto fetchloop

rem ============================================================
rem  两种冲突分开处理
rem ============================================================
:sortconflict
git rev-parse -q --verify MERGE_HEAD >nul 2>&1
if errorlevel 1 goto stashconflict
goto conflict

:conflict
echo.
echo ！！合并遇到冲突：你本地的提交和 GitHub 上的改动撞在同一处。
echo.
echo 冲突文件：
git diff --name-only --diff-filter=U
echo.
echo 仓库现在停在「合并进行中」，必须二选一处理完才能继续：
echo   A. 放弃这次更新，回到合并之前：
echo        git merge --abort
echo   B. 保留这次更新，手工改掉冲突：
echo        打开上面列出的文件，搜索 ^<^<^<^<^<^< 找到冲突处，改成你要的样子
echo        再执行：git add 那个文件    然后：git commit
echo.
echo 你的东西一个都没丢。
goto fail

:stashconflict
echo.
echo ！！更新已经下载进来了，但把你本地未提交的改动放回去时撞车了。
echo.
echo 冲突文件：
git diff --name-only --diff-filter=U
echo.
echo 注意：这次不是合并冲突，仓库没有停在合并中，
echo       所以千万【不要】执行 git merge --abort（它会报 There is no merge to abort）。
echo 你的本地改动还在暂存里，用 git stash list 能看到。
echo.
echo 二选一：
echo   A. 保留这次更新，把冲突改掉：
echo        打开上面列出的文件，搜索 ^<^<^<^<^<^< 和 ^>^>^>^>^>^> 之间的内容，
echo        改成你最终想要的样子，然后：
echo          git add 那个文件
echo          git stash drop
echo   B. 不要这次更新，退回拉取之前（会先备份到暂存，之后可 git stash pop 取回）：
echo          git reset --hard ORIG_HEAD
echo          git stash pop
echo.
echo 什么都不做直接关窗口也没关系，改动不会自己消失，下次运行本脚本前先处理完。
goto fail

:mergefail
echo.
echo ！！合并没有完成。
echo 常见原因：GitHub 上新加的文件，你本地恰好也有一个同名的、还没被 git 跟踪的文件。
echo   处理：git status 里看 Untracked files，把它改名或挪走，再运行本脚本。
echo 想回到合并之前：git merge --abort
goto fail

:noident
echo.
echo ！！还没配置 git 的作者信息，无法生成合并提交。
echo   git config --global user.name  "你的名字"
echo   git config --global user.email "你的邮箱"
echo   配好后再运行本脚本。
goto fail

:fetchfail
echo.
echo ！！连接 GitHub 失败，已经自动重试 3 次。
echo   1. 先在浏览器打开 https://github.com 看能不能上。
echo   2. 如果用代理或加速器，换个节点，或者先关掉再试。
echo   这一步只是下载远端信息，没有改动你本地任何文件。
goto fail

:norefmain
echo.
echo ！！拿不到 origin/main，没法判断该合并什么。
echo   同样的操作在命令行里跑一次，看 git 怎么说：
echo     git fetch origin --prune
echo     git ls-remote --heads origin
goto fail

:nogit
echo ！！PATH 里找不到 git。
echo   先安装 Git for Windows：https://git-scm.com/download/win
echo   装完重新打开这个窗口再运行。
goto fail

:norepo
echo.
echo ！！这个文件夹不是 git 仓库，没法拉取。
echo   如果你是第一次把项目弄到本地，要做的不是「拉取」而是「克隆」：
echo     在 D 盘根目录打开命令行窗口，执行：
echo     git clone https://github.com/zfsn114514/ZFSN.git
goto fail

:nohead
echo ！！仓库里还没有任何提交，没有东西可拉取。
goto fail

:noremote
echo.
echo ！！这个仓库没有配置 origin 远程地址。
echo   先添加，再运行本脚本：
echo     git remote add origin https://github.com/zfsn114514/ZFSN.git
goto fail

:detached
echo.
echo ！！当前处于「分离头指针」状态，不在任何分支上。
echo   先切回 main：  git switch main
goto fail

:otherbranch
echo.
echo ！！当前在分支 %BR% 上，这个脚本只处理 main。
echo   切回 main 再运行：  git switch main
goto fail

:merging
echo.
echo ！！上次的合并还没结束，先处理干净再拉取：
echo   放弃那次合并：  git merge --abort
echo   或者把它做完：  git commit
goto fail

:fail
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
