@echo off
setlocal
cd /d "%~dp0"
where dotnet >nul 2>&1
if errorlevel 1 goto missing
dotnet publish ZFSN.Cursor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o dist/win-x64
if errorlevel 1 goto failed
copy /y restore.bat dist\win-x64\restore.bat >nul
copy /y README.md dist\win-x64\README.md >nul
echo SUCCESS: dist\win-x64\ZFSN.Cursor.exe
goto done
:missing
echo Install .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0
goto done
:failed
echo BUILD FAILED. See the error above.
:done
pause
