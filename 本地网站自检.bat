@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
py -3 -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if not errorlevel 1 goto py
python -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if errorlevel 1 goto missing
python tools/check_local_site.py
goto result
:py
py -3 tools/check_local_site.py
:result
pause
exit /b
:missing
echo Please install Python 3.9 or newer and Git for Windows.
pause
exit /b 1
