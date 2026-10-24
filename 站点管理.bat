@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
py -3 -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if not errorlevel 1 goto py
python -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if errorlevel 1 goto missing
python tools/site_manager.py
goto result
:py
py -3 tools/site_manager.py
:result
if errorlevel 1 pause
exit /b
:missing
echo Please install Python 3.9 or newer and Git for Windows.
pause
exit /b 1
