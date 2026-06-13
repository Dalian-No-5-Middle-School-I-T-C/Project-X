@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  Project-X Scanner Bridge Build Script
echo ============================================
echo.

set "MSBUILD=D:\apps\vs-s-c\MSBuild\Current\Bin\MSBuild.exe"
set "VCVARS=D:\apps\vs-s-c\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%MSBUILD%" (
    echo [ERROR] MSBuild.exe not found at: %MSBUILD%
    pause
    exit /b 1
)

if not exist "%VCVARS%" (
    echo [ERROR] vcvars64.bat not found at: %VCVARS%
    echo Install "Desktop development with C++" workload.
    pause
    exit /b 1
)

echo MSBuild: %MSBUILD%
echo Setting up VS environment...
call "%VCVARS%"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] vcvars64.bat failed (exit %ERRORLEVEL%)
    pause
    exit /b 1
)
echo Environment ready.
echo.

set "PROJ=%~dp0..\..\native\ScannerBridge\scanner-bridge\scanner-bridge.vcxproj"
if not exist "%PROJ%" (
    echo [ERROR] Project file not found: %PROJ%
    pause
    exit /b 1
)

echo Target: scanner-bridge.vcxproj
echo Configuration: Release ^| x64
echo.

echo Building...
"%MSBUILD%" "%PROJ%" /p:Configuration=Release /p:Platform=x64 /v:m /nologo

set "BUILD_RESULT=%ERRORLEVEL%"
echo.

if %BUILD_RESULT% NEQ 0 (
    echo ============================================
    echo  BUILD FAILED ^(exit code: %BUILD_RESULT%^)
    echo ============================================
    pause
    exit /b %BUILD_RESULT%
)

echo ============================================
echo  BUILD SUCCEEDED
echo ============================================
echo.

set "OUTPUT=%~dp0..\..\native\ScannerBridge\scanner-bridge\x64\Release\scanner-bridge.exe"
set "DEST=%~dp0..\..\resources\native\win-x64"

if exist "%OUTPUT%" (
    echo Output: %OUTPUT%
    echo.
    if not exist "%DEST%" mkdir "%DEST%"
    copy /Y "%OUTPUT%" "%DEST%\scanner-bridge.exe" >nul
    if !ERRORLEVEL! EQU 0 (
        echo Copied to: %DEST%\scanner-bridge.exe
        echo.
        echo [OK] Ready.
    ) else (
        echo [WARNING] Copy failed. Manual copy:
        echo   From: %OUTPUT%
        echo   To:   %DEST%
    )
) else (
    echo [WARNING] Output not found: %OUTPUT%
    echo Check MSBuild log above for actual location.
)

echo.
pause
exit /b 0
