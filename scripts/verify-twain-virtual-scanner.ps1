param(
    [ValidateSet('ia32', 'x64')][string]$Arch = 'ia32',
    [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$WorkDir = (Join-Path $env:TEMP 'projectx-twain-virtual')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sourceDir = Join-Path $env:SystemRoot $(if ($Arch -eq 'ia32') { 'twain_32\sample2' } else { 'twain_64\sample2' })
if (-not (Test-Path (Join-Path $sourceDir 'platforms\qwindows.dll'))) {
    throw 'Install the complete TWAIN sample data source v2.5.0 for this architecture first.'
}
$runtime = Join-Path $WorkDir ('runtime-' + $Arch)
New-Item -ItemType Directory -Force $runtime | Out-Null
$nativeDir = Join-Path $RepositoryRoot ('resources\native\win-' + $Arch)
Copy-Item (Join-Path $nativeDir 'scanner-bridge.exe') $runtime -Force
Get-ChildItem $nativeDir -Filter *.dll | Copy-Item -Destination $runtime -Force
Get-ChildItem $sourceDir -Filter *.dll | Copy-Item -Destination $runtime -Force
Copy-Item (Join-Path $sourceDir 'platforms') $runtime -Recurse -Force
$oldPluginPath = $env:QT_QPA_PLATFORM_PLUGIN_PATH
$oldCount = $env:CAP_XFERCOUNT
try {
    $env:QT_QPA_PLATFORM_PLUGIN_PATH = Join-Path $runtime 'platforms'
    $results = @()
    foreach ($duplex in @($false, $true)) {
        $name = if ($duplex) { 'duplex-rejected' } else { 'simplex' }
        $frames = if ($duplex) { 4 } else { 3 }
        $sheets = if ($duplex) { 2 } else { 3 }
        $output = Join-Path $WorkDir ($Arch + '-' + $name + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $output | Out-Null
        $env:CAP_XFERCOUNT = [string]$frames
        $arguments = @('scan', '--source', '"TWAIN2 Software Scanner"', '--dpi', '150', '--mode', 'color',
            '--size', 'Letter', '--output', ('"' + $output + '"'), '--prefix', 'virtual',
            '--max-pages', [string]$sheets, '--page-timeout-ms', '2000')
        if ($duplex) { $arguments += '--duplex' }
        $stdout = Join-Path $output 'result.json'
        $stderr = Join-Path $output 'bridge.log'
        $process = Start-Process (Join-Path $runtime 'scanner-bridge.exe') -WorkingDirectory $runtime `
            -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw "Virtual scanner $Arch $name exceeded 30 seconds; see $stderr"
        }
        $result = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
        # The official sample advertises TWDX_NONE. This is the real-driver negative duplex case.
        if ($duplex) {
            $log = Get-Content $stderr -Raw -Encoding UTF8
            if ($result.status -ne 'error' -or $result.page_count -ne 0 -or @($result.pages).Count -ne 0 `
                -or $log -notmatch 'CAP_DUPLEXENABLED requested=1 set=rejected effective=0' `
                -or $log -match 'Page \d+ (front|back): capturing' `
                -or @(Get-ChildItem $output -Filter '*.jpg').Count -ne 0) {
                throw "Virtual scanner $Arch did not reject unsupported duplex before acquisition; see $stdout"
            }
            $results += [pscustomobject]@{ arch = $Arch; mode = $name; frames = 0; output = $output; status = 'passed' }
            continue
        }
        if ($result.status -ne 'ok' -or $result.page_count -ne $frames -or @($result.pages).Count -ne $frames) {
            Get-Content $stderr
            throw "Virtual scanner $Arch $name did not return $frames frames; see $stdout"
        }
        for ($i = 0; $i -lt $frames; $i++) {
            $page = $result.pages[$i]
            $expectedPage = if ($duplex) { [math]::Floor($i / 2) + 1 } else { $i + 1 }
            $expectedSide = if ($duplex -and $i % 2 -eq 1) { 'back' } else { 'front' }
            if ($page.page -ne $expectedPage -or $page.side -ne $expectedSide) {
                throw "Virtual scanner $Arch $name returned an incorrect sheet/side pair at frame $i"
            }
            if (-not (Test-Path $page.path) -or (Get-Item $page.path).Length -eq 0) {
                throw "Virtual scanner $Arch $name did not save frame $i"
            }
            $image = [System.Drawing.Image]::FromFile($page.path)
            try {
                if ($image.Width -ne $page.width -or $image.Height -ne $page.height -or $image.Width -le 0) {
                    throw "Virtual scanner $Arch $name saved incorrect image dimensions at frame $i"
                }
            } finally { $image.Dispose() }
        }
        $results += [pscustomobject]@{ arch = $Arch; mode = $name; frames = $frames; output = $output; status = 'passed' }
    }
    $results | ConvertTo-Json
} finally {
    $env:QT_QPA_PLATFORM_PLUGIN_PATH = $oldPluginPath
    $env:CAP_XFERCOUNT = $oldCount
}
