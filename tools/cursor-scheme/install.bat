@echo off
chcp 936 >nul
setlocal

set SRC=%~dp0zfsn
set DST=%LOCALAPPDATA%\ZFSN-Cursors
set THEMES=%LOCALAPPDATA%\Microsoft\Windows\Themes
set THEME=%THEMES%\ZFSN.theme

if /i "%~1"=="/restore" goto restore

echo ============================================
echo   ZFSN Red Glow  -  install cursor scheme
echo ============================================
echo.
if not exist "%SRC%\Normal.cur" (
  echo [X] cursor files not found:
  echo     %SRC%
  echo     Keep the zfsn folder next to this script.
  echo.
  pause
  exit /b 1
)
if not exist "%THEMES%" mkdir "%THEMES%"

echo [1/3] Copying cursor files to:
echo       %DST%
if not exist "%DST%" mkdir "%DST%"
copy /Y "%SRC%\*.cur" "%DST%\" >nul
copy /Y "%SRC%\*.ani" "%DST%\" >nul
if errorlevel 1 (
  echo [X] copy failed.
  pause
  exit /b 1
)

echo [2/3] Writing theme file:
echo       %THEME%
> "%THEME%" echo [Theme]
>>"%THEME%" echo DisplayName=ZFSN Red Glow
>>"%THEME%" echo.
>>"%THEME%" echo [Control Panel\Cursors]
>>"%THEME%" echo Arrow=%DST%\Normal.cur
>>"%THEME%" echo Help=%DST%\Help.cur
>>"%THEME%" echo AppStarting=%DST%\Working.ani
>>"%THEME%" echo Wait=%DST%\Busy.ani
>>"%THEME%" echo NWPen=%DST%\Handwriting.cur
>>"%THEME%" echo No=%DST%\Unavailable.cur
>>"%THEME%" echo SizeAll=%DST%\Move.cur
>>"%THEME%" echo SizeNESW=%DST%\SizeNESW.cur
>>"%THEME%" echo SizeNS=%DST%\SizeNS.cur
>>"%THEME%" echo SizeNWSE=%DST%\SizeNWSE.cur
>>"%THEME%" echo SizeWE=%DST%\SizeWE.cur
>>"%THEME%" echo UpArrow=%DST%\Up.cur
>>"%THEME%" echo Crosshair=%DST%\Precision.cur
>>"%THEME%" echo IBeam=%DST%\Text.cur
>>"%THEME%" echo Hand=%DST%\Link.cur

echo [3/3] Applying ...
reg add "HKCU\Control Panel\Cursors" /v Arrow       /t REG_SZ /d "%DST%\Normal.cur"      /f >nul
reg add "HKCU\Control Panel\Cursors" /v Help        /t REG_SZ /d "%DST%\Help.cur"        /f >nul
reg add "HKCU\Control Panel\Cursors" /v AppStarting /t REG_SZ /d "%DST%\Working.ani"     /f >nul
reg add "HKCU\Control Panel\Cursors" /v Wait        /t REG_SZ /d "%DST%\Busy.ani"        /f >nul
reg add "HKCU\Control Panel\Cursors" /v NWPen       /t REG_SZ /d "%DST%\Handwriting.cur" /f >nul
reg add "HKCU\Control Panel\Cursors" /v No          /t REG_SZ /d "%DST%\Unavailable.cur" /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeAll     /t REG_SZ /d "%DST%\Move.cur"        /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNESW    /t REG_SZ /d "%DST%\SizeNESW.cur"    /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNS      /t REG_SZ /d "%DST%\SizeNS.cur"      /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNWSE    /t REG_SZ /d "%DST%\SizeNWSE.cur"    /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeWE      /t REG_SZ /d "%DST%\SizeWE.cur"      /f >nul
reg add "HKCU\Control Panel\Cursors" /v UpArrow     /t REG_SZ /d "%DST%\Up.cur"          /f >nul
reg add "HKCU\Control Panel\Cursors" /v Crosshair   /t REG_SZ /d "%DST%\Precision.cur"   /f >nul
reg add "HKCU\Control Panel\Cursors" /v IBeam       /t REG_SZ /d "%DST%\Text.cur"        /f >nul
reg add "HKCU\Control Panel\Cursors" /v Hand        /t REG_SZ /d "%DST%\Link.cur"        /f >nul

powershell -NoProfile -Command "$s='[DllImport(\"user32.dll\")] public static extern bool SystemParametersInfo(uint a,uint b,System.IntPtr c,uint d)'; $t=Add-Type -MemberDefinition $s -Name ZFSNSPI -Namespace W -PassThru; $t::SystemParametersInfo(0x57,0,[System.IntPtr]::Zero,0x3)"

echo.
echo ============================================
echo   Done. 15 cursor roles installed.
echo ============================================
echo.
echo If some cursors still look like the old ones,
echo sign out and back in, or reboot once.
echo.
echo Restore Windows default cursors later:
echo   install.bat /restore
echo.
pause
exit /b 0

:restore
echo ============================================
echo   Restore default Windows cursors
echo ============================================
echo.
set W=%SystemRoot%\cursors
reg add "HKCU\Control Panel\Cursors" /v Arrow       /t REG_SZ /d "%W%\aero_arrow.cur"    /f >nul
reg add "HKCU\Control Panel\Cursors" /v Help        /t REG_SZ /d "%W%\aero_helpsel.cur"  /f >nul
reg add "HKCU\Control Panel\Cursors" /v AppStarting /t REG_SZ /d "%W%\aero_working.ani"  /f >nul
reg add "HKCU\Control Panel\Cursors" /v Wait        /t REG_SZ /d "%W%\aero_busy.ani"     /f >nul
reg add "HKCU\Control Panel\Cursors" /v NWPen       /t REG_SZ /d "%W%\aero_pen.cur"      /f >nul
reg add "HKCU\Control Panel\Cursors" /v No          /t REG_SZ /d "%W%\aero_unavail.cur"  /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeAll     /t REG_SZ /d "%W%\aero_move.cur"     /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNESW    /t REG_SZ /d "%W%\aero_nesw.cur"     /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNS      /t REG_SZ /d "%W%\aero_ns.cur"       /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeNWSE    /t REG_SZ /d "%W%\aero_nwse.cur"     /f >nul
reg add "HKCU\Control Panel\Cursors" /v SizeWE      /t REG_SZ /d "%W%\aero_ew.cur"       /f >nul
reg add "HKCU\Control Panel\Cursors" /v UpArrow     /t REG_SZ /d "%W%\aero_up.cur"       /f >nul
reg add "HKCU\Control Panel\Cursors" /v Crosshair   /t REG_SZ /d ""                       /f >nul
reg add "HKCU\Control Panel\Cursors" /v IBeam       /t REG_SZ /d ""                       /f >nul
reg add "HKCU\Control Panel\Cursors" /v Hand        /t REG_SZ /d "%W%\aero_link.cur"     /f >nul

powershell -NoProfile -Command "$s='[DllImport(\"user32.dll\")] public static extern bool SystemParametersInfo(uint a,uint b,System.IntPtr c,uint d)'; $t=Add-Type -MemberDefinition $s -Name ZFSNSPI2 -Namespace W -PassThru; $t::SystemParametersInfo(0x57,0,[System.IntPtr]::Zero,0x3)"

echo Done. Default cursors restored.
echo.
pause
exit /b 0
