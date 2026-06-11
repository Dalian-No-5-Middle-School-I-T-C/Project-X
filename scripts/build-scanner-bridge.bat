@echo off
setlocal enabledelayedexpansion

echo ============================================
echo  Project-X Scanner Bridge Build Script
echo ============================================
echo.

set "MSBUILD="

:: ── Method 1: vswhere.exe ──────────────────────────
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2^>nul`) do (
        if exist "%%i" (
            set "MSBUILD=%%i"
            echo [vswhere] Found: %%i
        )
    )
    if defined MSBUILD goto :found
)

:: ── Method 2: Check common VS2022 paths ─────────────
for %%d in (
    "Community"
    "Professional"
    "Enterprise"
    "BuildTools"
) do (
    set "TEST=%ProgramFiles%\Microsoft Visual Studio\2022\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan  ] Found: !TEST!
        goto :found
    )
    
    set "TEST=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan  ] Found: !TEST!
        goto :found
    )
)

:: ── Method 3: Check VS2019 as fallback ─────────────
for %%d in (
    "Community"
    "Professional"
    "Enterprise"
    "BuildTools"
) do (
    set "TEST=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan  ] Found (VS2019): !TEST!
        goto :found
    )
)

:: ── Not found ───────────────────────────────────────
echo.
echo [ERROR] MSBuild.exe not found!
echo.
echo Tried these locations:
echo   1. vswhere.exe in Visual Studio Installer
echo   2. C:\Program Files\Microsoft Visual Studio\2022\[edition]\MSBuild\...
echo   3. C:\Program Files (x86)\Microsoft Visual Studio\2022\[edition]\MSBuild\...
echo   4. VS2019 fallback paths
echo.
echo Do you have Visual Studio 2022 Build Tools installed?
echo Download: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
echo (Select "Desktop development with C++" workload during install)
echo.
pause
exit /b 1

:found
echo.

:: ── Locate vcvars64.bat and set up environment ──────
for /f "delims=" %%i in ("%MSBUILD%") do set "MSBUILD_DIR=%%~dpi"
set "VS_INSTALL=%MSBUILD_DIR%..\..\..\.."

:: Try to find vcvars64.bat
set "VCVARS="
for %%f in (
    "%VS_INSTALL%\VC\Auxiliary\Build\vcvars64.bat"
    "%VS_INSTALL%\Common7\Tools\VsDevCmd.bat"
) do (
    if exist "%%f" (
        set "VCVARS=%%f"
    )
)

if defined VCVARS (
    echo Setting up VS environment...
    call "%VCVARS%" >nul 2>&1
)

:: ── Build ───────────────────────────────────────────
set "PROJECT_DIR=%~dp0"
set "PROJ=%PROJECT_DIR%..\..\native\ScannerBridge\scanner-bridge\scanner-bridge.vcxproj"

if not exist "%PROJ%" (
    echo [ERROR] Project file not found: %PROJ%
    pause
    exit /b 1
)

echo Target: scanner-bridge.vcxproj
echo Configuration: Release ^| x64 ^| Static CRT
echo.

echo Building...
call "%MSBUILD%" "%PROJ%" /p:Configuration=Release /p:Platform=x64 /v:m /nologo

set "BUILD_RESULT=%ERRORLEVEL%"

echo.

if %BUILD_RESULT% NEQ 0 (
    echo ============================================
    echo  BUILD FAILED ^(exit code: %BUILD_RESULT%^)
    echo ============================================
    echo.
    echo Common fixes:
    echo   - Windows 10 SDK is required for "twain.h"
    echo     Install via Visual Studio Installer ^> Modify ^> Individual Components
    echo     Search for "Windows 10 SDK" and install latest version
    echo   - Make sure "Desktop development with C++" workload is installed
    echo.
    pause
    exit /b %BUILD_RESULT%
)

:: ── Success ─────────────────────────────────────────
echo ============================================
echo  BUILD SUCCEEDED
echo ============================================
echo.

set "SLN_DIR=%PROJECT_DIR%..\..\native\ScannerBridge"
set "OUTPUT=%SLN_DIR%\scanner-bridge\x64\Release\scanner-bridge.exe"
set "DEST=%PROJECT_DIR%..\..\resources\native\win-x64"

if exist "%OUTPUT%" (
    echo Output: %OUTPUT%
    echo.

    if not exist "%DEST%" mkdir "%DEST%"
    copy /Y "%OUTPUT%" "%DEST%\scanner-bridge.exe" >nul
    if !ERRORLEVEL! EQU 0 (
        echo Copied to: %DEST%\scanner-bridge.exe
        echo.
        echo [OK] Ready for packaging.
    ) else (
        echo [WARNING] Failed to copy. Please copy manually:
        echo   From: %OUTPUT%
        echo   To:   %DEST%
    )
) else (
    echo [WARNING] Output exe not found at expected path:
    echo   %OUTPUT%
    echo.
    echo The build may have placed it elsewhere. Check the MSBuild output above.
)

echo.
pause
exit /b 0
