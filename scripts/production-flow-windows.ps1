$ErrorActionPreference='Stop'
$source = $env:PROJECTX_FLOW_SOURCE_ROOT
if (-not $source) {
    if (-not $PSScriptRoot) { throw 'Supply --source-root or PROJECTX_FLOW_SOURCE_ROOT with the repository path in Windows.' }
    $source = Split-Path $PSScriptRoot -Parent
}
$work = if ($env:PROJECTX_FLOW_WORKDIR) { $env:PROJECTX_FLOW_WORKDIR } else { Join-Path $env:LOCALAPPDATA 'ProjectX-Flow' }
$shared = if ($env:PROJECTX_FLOW_SHARED_ROOT) { $env:PROJECTX_FLOW_SHARED_ROOT } else { Join-Path $source 'ignored\production-flow' }
$env:PROJECTX_FLOW_SHARED_ROOT = $shared
$stage = if ($env:PROJECTX_FLOW_STAGE) { $env:PROJECTX_FLOW_STAGE } else { (Get-Content -LiteralPath (Join-Path $shared 'ui-stage.txt') -Raw).Trim() }
New-Item -ItemType Directory -Force $work, (Join-Path $shared 'evidence') | Out-Null
foreach ($script in @('production-flow-browser.cjs','production-flow-target.cjs','production-flow-electron.cjs','production-flow-draft-fixture.cjs','production-flow-postprocess-fixture.cjs','production-flow-viewports.cjs')) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $source 'scripts') $script) -Destination $work -Force
}
$exe = if ($env:PROJECTX_FLOW_NODE) { Get-Item -LiteralPath $env:PROJECTX_FLOW_NODE } elseif (Get-Command node.exe -ErrorAction SilentlyContinue) { Get-Item (Get-Command node.exe).Source } else {
    $env:ELECTRON_RUN_AS_NODE='1'
    Get-ChildItem -LiteralPath (Join-Path $work 'runtime') -Filter *.exe | Select-Object -First 1
}
if (-not $exe) { throw 'Install Node in Windows or set PROJECTX_FLOW_NODE to node.exe.' }
$log = $stage.Replace(':','-') + '.log'
Set-Content -LiteralPath (Join-Path $work $log) -Value ''
$ErrorActionPreference='Continue'
$driver='production-flow-browser.cjs'
$action=$stage
if ($stage.StartsWith('electron:')) { $driver='production-flow-electron.cjs'; $action=$stage.Substring(9) }
& $exe.FullName (Join-Path $work $driver) $action 2>&1 | Tee-Object -FilePath (Join-Path $work $log)
$result=$LASTEXITCODE
$ErrorActionPreference='Stop'
Copy-Item -LiteralPath (Join-Path $work $log) -Destination (Join-Path $shared 'evidence') -Force
exit $result
