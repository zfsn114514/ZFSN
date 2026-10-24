@echo off
cd /d "%~dp0"
if not exist ZFSN.Cursor.exe goto missing
start /wait "" "%~dp0ZFSN.Cursor.exe" --restore
if errorlevel 1 goto failed
echo Original Windows cursor scheme reloaded.
goto done
:missing
echo Put this script next to ZFSN.Cursor.exe.
goto done
:failed
echo Restore failed. Open Windows Mouse settings and reapply your cursor scheme.
:done
pause
