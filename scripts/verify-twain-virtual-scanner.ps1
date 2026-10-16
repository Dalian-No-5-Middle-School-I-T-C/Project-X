param(
    [ValidateSet('ia32', 'x64')][string]$Arch = 'ia32',
    [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$WorkDir = (Join-Path $env:TEMP 'projectx-twain-virtual'),
    [switch]$Extended,
    [string[]]$CaseName = @()
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
    $cases = @(
        @{ name = 'simplex'; frames = 3; sheets = 3; feed = 3; dpi = 150; color = 'color' },
        @{ name = 'duplex-rejected'; frames = 0; sheets = 2; feed = 4; dpi = 150; color = 'color'; duplex = $true; error = 'CAP_DUPLEXENABLED requested=1 set=rejected effective=0' }
    )
    if ($Extended) {
        foreach ($dpi in @(150, 200, 300, 400, 600)) {
            foreach ($color in @('color', 'gray', 'bw')) {
                $cases += @{ name = "$color-$dpi"; frames = 1; sheets = 1; feed = 1; dpi = $dpi; color = $color }
            }
        }
        $cases += @(
            @{ name = 'unlimited'; frames = 4; sheets = 0; feed = 4; dpi = 150; color = 'color' },
            @{ name = 'cutoff'; frames = 1; sheets = 1; feed = 4; dpi = 150; color = 'color'; reset = $true },
            @{ name = 'default-source'; frames = 1; sheets = 1; feed = 1; dpi = 150; color = 'color'; defaultSource = $true },
            @{ name = 'unsupported-dpi'; frames = 0; sheets = 1; feed = 1; dpi = 350; color = 'color'; error = 'DPI requested=350' },
            @{ name = 'unsupported-a4'; frames = 0; sheets = 1; feed = 1; dpi = 150; color = 'color'; size = 'A4'; error = 'ICAP_PIXELTYPE'; message = 'A4' },
            @{ name = 'unsupported-a3'; frames = 0; sheets = 1; feed = 1; dpi = 150; color = 'color'; size = 'A3'; error = 'ICAP_PIXELTYPE'; message = 'A3' }
        )
    }
    $results = @()
    foreach ($case in $cases) {
        if ($CaseName.Count -gt 0 -and $case.name -notin $CaseName) { continue }
        $name = $case.name
        $output = Join-Path $WorkDir ($Arch + '-' + $name + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $output | Out-Null
        $env:CAP_XFERCOUNT = [string]$case.feed
        $paperSize = if ($case.size) { $case.size } else { 'Letter' }
        $arguments = @('scan', '--dpi', [string]$case.dpi, '--mode', $case.color,
            '--size', $paperSize, '--output', ('"' + $output + '"'), '--prefix', 'virtual',
            '--max-pages', [string]$case.sheets, '--page-timeout-ms', '2000')
        if (-not $case.defaultSource) { $arguments += @('--source', '"TWAIN2 Software Scanner"') }
        if ($case.duplex) { $arguments += '--duplex' }
        $stdout = Join-Path $output 'result.json'
        $stderr = Join-Path $output 'bridge.log'
        $process = Start-Process (Join-Path $runtime 'scanner-bridge.exe') -WorkingDirectory $runtime `
            -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        if (-not $process.WaitForExit(45000)) {
            $process.Kill()
            throw "Virtual scanner $Arch $name exceeded 45 seconds; see $stderr"
        }
        $result = Get-Content $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
        $log = Get-Content $stderr -Raw -Encoding UTF8
        if ($case.error) {
            if ($result.status -ne 'error' -or $result.page_count -ne 0 -or @($result.pages).Count -ne 0 `
                -or $log -notmatch $case.error -or ($case.message -and $result.message -notmatch $case.message) `
                -or $log -match 'Page \d+ (front|back): capturing' `
                -or @(Get-ChildItem $output -Filter '*.jpg').Count -ne 0) {
                throw "Virtual scanner $Arch $name did not reject unsupported settings before acquisition; see $stdout"
            }
        } else {
            if ($result.status -ne 'ok' -or $result.page_count -ne $case.frames -or @($result.pages).Count -ne $case.frames) {
                Get-Content $stderr
                throw "Virtual scanner $Arch $name did not return $($case.frames) frames; see $stdout"
            }
            $pixelType = @{ color = 2; gray = 1; bw = 0 }[$case.color]
            $bits = @{ color = 24; gray = 8; bw = 1 }[$case.color]
            if ($log -notmatch "pixelType=$pixelType bitsPerPixel=$bits") {
                throw "Virtual scanner $Arch $name returned the wrong source pixel format; see $stderr"
            }
            if ($case.reset -and $log -notmatch 'reset pending transfers before disable rc=0') {
                throw "Virtual scanner $Arch $name did not reset the unfinished batch; see $stderr"
            }
            for ($i = 0; $i -lt $case.frames; $i++) {
                $page = $result.pages[$i]
                if ($page.page -ne $i + 1 -or $page.side -ne 'front') {
                    throw "Virtual scanner $Arch $name returned an incorrect sheet/side pair at frame $i"
                }
                if (-not (Test-Path $page.path) -or (Get-Item $page.path).Length -eq 0) {
                    throw "Virtual scanner $Arch $name did not save frame $i"
                }
                $image = [System.Drawing.Image]::FromFile($page.path)
                try {
                    if ($image.Width -ne $page.width -or $image.Height -ne $page.height `
                        -or $image.Width -ne [int](8.5 * $case.dpi) -or $image.Height -ne 11 * $case.dpi) {
                        throw "Virtual scanner $Arch $name saved incorrect Letter dimensions at frame $i"
                    }
                    if ([math]::Abs($image.HorizontalResolution - $case.dpi) -gt 0.1 `
                        -or [math]::Abs($image.VerticalResolution - $case.dpi) -gt 0.1 `
                        -or [math]::Abs($page.dpi_x - $case.dpi) -gt 0.01 `
                        -or [math]::Abs($page.dpi_y - $case.dpi) -gt 0.01) {
                        throw "Virtual scanner $Arch $name did not preserve the requested DPI in the image and result at frame $i"
                    }
                } finally { $image.Dispose() }
            }
        }
        $results += [pscustomobject]@{ arch = $Arch; mode = $name; frames = $case.frames; dpi = $case.dpi; output = $output; status = 'passed' }
    }
    $results | ConvertTo-Json
} finally {
    $env:QT_QPA_PLATFORM_PLUGIN_PATH = $oldPluginPath
    $env:CAP_XFERCOUNT = $oldCount
}
