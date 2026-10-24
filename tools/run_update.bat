@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUNBUFFERED=1"
set "PYTHONIOENCODING=utf-8"
py -3 -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if not errorlevel 1 (
    goto use_py
)
python -c "import sys; sys.exit(sys.version_info < (3,9))" >nul 2>&1
if errorlevel 1 (
    echo [失败] 请安装 Python 3.9 或更新版本，并加入 PATH。
    exit /b 1
)
python update_data.py %*
exit /b %errorlevel%

:use_py
py -3 update_data.py %*
exit /b %errorlevel%
