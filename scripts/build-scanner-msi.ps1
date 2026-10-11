param([string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Join-Path $ProjectRoot 'ignored\msi-tools') -Force | Out-Null
$statusFile = Join-Path $ProjectRoot 'ignored\msi-tools\windows-build-status.json'
$work = Join-Path $env:TEMP ('projectx-msi-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
Start-Transcript -Path (Join-Path $ProjectRoot 'ignored\msi-tools\windows-build.log') -Force
try {
    $app = Join-Path $work 'app'
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'release\win-ia32-unpacked') -Destination $app -Recurse
    $toolSource = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot '.electron-builder-cache\wix-4.0.0.5512.2') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'candle.exe') } | Select-Object -First 1
    if (!$toolSource) { throw 'WiX toolset is missing' }
    $tools = Join-Path $work 'wix'
    Copy-Item -LiteralPath $toolSource.FullName -Destination $tools -Recurse
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'release\.icon-ico\icon.ico') -Destination (Join-Path $work 'icon.ico')
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'ignored\scanner-package\msi-project.wxs') -Raw -Encoding UTF8
    $ns = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
    $ns.AddNamespace('w', $manifest.DocumentElement.NamespaceURI)
    $manifest.SelectSingleNode('//w:Icon', $ns).SetAttribute('SourceFile', (Join-Path $work 'icon.ico'))
    foreach ($file in $manifest.SelectNodes('//w:File', $ns)) { $file.SetAttribute('Source', $file.GetAttribute('Source').Replace('/', '\')) }
    $manifest.Save((Join-Path $work 'project.wxs'))
    Push-Location $work
    try {
        & (Join-Path $tools 'candle.exe') '-arch' 'x86' "-dappDir=$app" '-pedantic' '-wx' 'project.wxs'
        if ($LASTEXITCODE -ne 0) { throw "candle failed: $LASTEXITCODE" }
        & (Join-Path $tools 'light.exe') '-out' (Join-Path $work 'scanner.msi') '-spdb' '-sw1076' "-dappDir=$app" '-pedantic' '-wx' '-sval' 'project.wixobj'
        if ($LASTEXITCODE -ne 0) { throw "light failed: $LASTEXITCODE" }
    } finally { Pop-Location }
    $extract = Join-Path $work 'extracted'
    $install = Start-Process 'msiexec.exe' -ArgumentList @('/a', ('"' + (Join-Path $work 'scanner.msi') + '"'), '/qn', ('TARGETDIR="' + $extract + '"'), '/l*v', ('"' + (Join-Path $work 'extract.log') + '"')) -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "MSI administrative extraction failed: $($install.ExitCode)" }
    $nativeFiles = @('answer-card-recognizer.exe', 'scanner-bridge.exe', 'TWAINDSM.dll')
    foreach ($name in $nativeFiles) {
        $expected = (Get-FileHash -LiteralPath (Join-Path $app "resources\native\win-ia32\$name") -Algorithm SHA256).Hash
        $matches = @(Get-ChildItem -LiteralPath $extract -Recurse -File | Where-Object { $_.Name -eq $name -and $_.FullName.EndsWith("resources\native\win-ia32\$name") })
        if ($matches.Count -ne 1) { throw "MSI installation path is missing or duplicated: $name" }
        if ((Get-FileHash -LiteralPath $matches[0].FullName -Algorithm SHA256).Hash -ne $expected) { throw "MSI native hash mismatch: $name" }
    }
    $pkg = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $artifact = Join-Path $ProjectRoot ("release\" + $pkg.build.productName + '-' + $pkg.version + '-ia32.msi')
    Copy-Item -LiteralPath (Join-Path $work 'scanner.msi') -Destination $artifact -Force
    @{ success = $true; artifact = $artifact; sha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash; nativeComponents = $nativeFiles; workDirectory = $work } | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
} catch {
    @{ success = $false; error = $_.Exception.Message; workDirectory = $work } | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
    throw
} finally { Stop-Transcript }
