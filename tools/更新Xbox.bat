@echo off
call "%~dp0run_update.bat" xbox
set "UPDATE_RESULT=%errorlevel%"
if errorlevel 1 echo [失败] 更新未完成，请查看上面的错误信息。
pause
exit /b %UPDATE_RESULT%
