@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
:menu
cls
echo ==================================================
echo   ZFSN 数据更新中心
echo ==================================================
echo.
echo   1. Steam 自有游戏与时长（快速）
echo   2. Steam 家庭共享（首次较慢）
echo   3. B站快速更新（抓新投稿，复用旧互动数据）
echo   4. B站完整更新（刷新全部赞、币、收藏）
echo   5. Xbox 补充缺失封面
echo   6. Xbox 重新抓取全部封面
echo   7. 全部更新
echo   0. 退出
echo.
echo   更新只写入本地，线上仍需提交并推送到 GitHub。
choice /c 12345670 /n /m "请选择: "
if errorlevel 8 exit /b 0
if errorlevel 7 goto all
if errorlevel 6 goto xbox_full
if errorlevel 5 goto xbox
if errorlevel 4 goto bili_full
if errorlevel 3 goto bili
if errorlevel 2 goto family
if errorlevel 1 goto steam
goto menu
:steam
call run_update.bat steam
goto result
:family
call run_update.bat steam-family
goto result
:bili
call run_update.bat bili
goto result
:bili_full
call run_update.bat bili-full
goto result
:xbox
call run_update.bat xbox
goto result
:xbox_full
call run_update.bat xbox-full
goto result
:all
call run_update.bat all
:result
if errorlevel 1 echo [失败] 本次更新未全部完成，请查看错误信息。
pause
goto menu
