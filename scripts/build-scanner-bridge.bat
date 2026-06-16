@echo off
setlocal enabledelayedexpansion

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=x64"

if /I "%ARCH%"=="x64" (
    set "PLATFORM=x64"
    set "OUT_ARCH=win-x64"
    set "VC_ARCH=x64"
    set "TWAIN_DSM_DLL_DEFAULT=D:\twain-dsm-2.5.1\twain-dsm-2.5.1\Releases\dsm_020403\windows\64\TWAINDSM.dll"
) else if /I "%ARCH%"=="ia32" (
    set "PLATFORM=Win32"
    set "OUT_ARCH=win-ia32"
    set "VC_ARCH=x86"
    set "TWAIN_DSM_DLL_DEFAULT=D:\twain-dsm-2.5.1\twain-dsm-2.5.1\Releases\dsm_020403\windows\32\TWAINDSM.dll"
) else (
    echo Usage: build-scanner-bridge.bat [x64^|ia32]
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fi"

echo ============================================
echo  Project-X Scanner Bridge Build Script
echo ============================================
echo Architecture: %ARCH% ^(%PLATFORM%^)
echo.

set "MSBUILD="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2^>nul`) do (
        if exist "%%i" (
            set "MSBUILD=%%i"
            echo [vswhere] Found MSBuild: %%i
        )
    )
    if defined MSBUILD goto :found_msbuild
)

for %%d in ("Community" "Professional" "Enterprise" "BuildTools") do (
    set "TEST=%ProgramFiles%\Microsoft Visual Studio\2022\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan] Found MSBuild: !TEST!
        goto :found_msbuild
    )
    set "TEST=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan] Found MSBuild: !TEST!
        goto :found_msbuild
    )
    set "TEST=%ProgramFiles%\Microsoft Visual Studio\18\%%~d\MSBuild\Current\Bin\MSBuild.exe"
    if exist "!TEST!" (
        set "MSBUILD=!TEST!"
        echo [scan] Found MSBuild: !TEST!
        goto :found_msbuild
    )
)

echo [ERROR] MSBuild.exe not found.
exit /b 1

:found_msbuild
for /f "delims=" %%i in ("%MSBUILD%") do set "MSBUILD_DIR=%%~dpi"
set "VS_INSTALL=%MSBUILD_DIR%..\..\..\.."

set "VCVARS="
for %%f in (
    "%VS_INSTALL%\Common7\Tools\VsDevCmd.bat"
    "%VS_INSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
) do (
    if exist "%%~f" set "VCVARS=%%~f"
)

if defined VCVARS (
    echo Setting up VS environment for %VC_ARCH%...
    echo !VCVARS! | find /I "VsDevCmd.bat" >nul
    if !ERRORLEVEL! EQU 0 (
        call "!VCVARS!" -arch=%VC_ARCH% >nul 2>&1
    ) else (
        call "!VCVARS!" %VC_ARCH% >nul 2>&1
    )
)

set "PROJ=%ROOT_DIR%\native\ScannerBridge\scanner-bridge\scanner-bridge.vcxproj"
if not exist "%PROJ%" (
    echo [ERROR] Project file not found: %PROJ%
    exit /b 1
)

echo Target: scanner-bridge.vcxproj
echo Configuration: Release ^| %PLATFORM% ^| Static CRT
echo.

call "%MSBUILD%" "%PROJ%" /p:Configuration=Release /p:Platform=%PLATFORM% /v:m /nologo
set "BUILD_RESULT=%ERRORLEVEL%"

if %BUILD_RESULT% NEQ 0 (
    echo.
    echo ============================================
    echo  BUILD FAILED ^(exit code: %BUILD_RESULT%^)
    echo ============================================
    exit /b %BUILD_RESULT%
)

set "OUTPUT=%ROOT_DIR%\native\ScannerBridge\scanner-bridge\%PLATFORM%\Release\scanner-bridge.exe"
if not exist "%OUTPUT%" (
    set "OUTPUT=%ROOT_DIR%\native\ScannerBridge\scanner-bridge\Release\scanner-bridge.exe"
)
set "DEST=%ROOT_DIR%\resources\native\%OUT_ARCH%"
set "TWAIN_DSM_DLL=%TWAIN_DSM_DLL%"
if not defined TWAIN_DSM_DLL set "TWAIN_DSM_DLL=%TWAIN_DSM_DLL_DEFAULT%"

if not exist "%OUTPUT%" (
    echo [ERROR] Output exe not found: %OUTPUT%
    exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%OUTPUT%" "%DEST%\scanner-bridge.exe" >nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to copy scanner-bridge.exe to %DEST%.
    exit /b 1
)

if exist "%TWAIN_DSM_DLL%" (
    copy /Y "%TWAIN_DSM_DLL%" "%DEST%\TWAINDSM.dll" >nul
    if !ERRORLEVEL! NEQ 0 (
        echo [ERROR] Failed to copy TWAINDSM.dll from: %TWAIN_DSM_DLL%
        exit /b 1
    )
) else (
    echo [ERROR] TWAINDSM.dll not found: %TWAIN_DSM_DLL%
    exit /b 1
)

echo.
echo ============================================
echo  BUILD SUCCEEDED
echo ============================================
echo Output: %OUTPUT%
echo Staged: %DEST%
exit /b 0
