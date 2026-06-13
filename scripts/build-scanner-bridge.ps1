$ErrorActionPreference = "Stop"

Write-Host "============================================"
Write-Host " Project-X Scanner Bridge Build Script"
Write-Host "============================================"
Write-Host ""

$msbuild = "D:\apps\vs-s-c\MSBuild\Current\Bin\MSBuild.exe"
$vcvars  = "D:\apps\vs-s-c\VC\Auxiliary\Build\vcvars64.bat"
$proj    = "E:\git\Project-X\native\ScannerBridge\scanner-bridge\scanner-bridge.vcxproj"
$output  = "E:\git\Project-X\native\ScannerBridge\scanner-bridge\x64\Release\scanner-bridge.exe"
$destDir = "E:\git\Project-X\resources\native\win-x64"

if (-not (Test-Path $msbuild)) {
    Write-Host "[ERROR] MSBuild.exe not found: $msbuild"
    Read-Host "Press Enter to exit"
    exit 1
}
if (-not (Test-Path $vcvars)) {
    Write-Host "[ERROR] vcvars64.bat not found: $vcvars"
    Read-Host "Press Enter to exit"
    exit 1
}
if (-not (Test-Path $proj)) {
    Write-Host "[ERROR] Project not found: $proj"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "MSBuild: $msbuild"
Write-Host "Setting up VS environment..."
Write-Host "Target: scanner-bridge.vcxproj"
Write-Host "Config: Release | x64"
Write-Host ""

Write-Host "Building..."
$tempBat = [System.IO.Path]::GetTempFileName() + ".bat"
@"
@echo off
call "$vcvars"
"$msbuild" "$proj" /p:Configuration=Release /p:Platform=x64 /v:m /nologo
"@ | Out-File -FilePath $tempBat -Encoding ASCII

cmd /c $tempBat
$exitCode = $LASTEXITCODE
Remove-Item $tempBat -Force -ErrorAction SilentlyContinue

Write-Host ""

if ($exitCode -ne 0) {
    Write-Host "============================================"
    Write-Host " BUILD FAILED (exit code: $exitCode)"
    Write-Host "============================================"
    Read-Host "Press Enter to exit"
    exit $exitCode
}

if (Test-Path $output) {
    Write-Host "============================================"
    Write-Host " BUILD SUCCEEDED"
    Write-Host "============================================"
    Write-Host ""
    Write-Host "Output: $output"

    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    Copy-Item -Path $output -Destination "$destDir\scanner-bridge.exe" -Force
    Write-Host "Copied to: $destDir\scanner-bridge.exe"
    Write-Host ""
    Write-Host "[OK] Ready."
} else {
    Write-Host "[WARNING] Output not found at expected path:"
    Write-Host "  $output"
    Write-Host "Check MSBuild output above for actual location."
}

Write-Host ""
Read-Host "Press Enter to exit"
exit 0
