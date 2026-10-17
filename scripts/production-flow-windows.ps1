$ErrorActionPreference='Stop'
$source=if($env:PROJECTX_FLOW_SOURCE_ROOT) {$env:PROJECTX_FLOW_SOURCE_ROOT} else {'\\Mac\Home\Documents\project\dl5z\Project-X'}
$work=if($env:PROJECTX_FLOW_WORKDIR) {$env:PROJECTX_FLOW_WORKDIR} else {'C:\projectx-flow-20261015'}
$stage=if($env:PROJECTX_FLOW_STAGE) {$env:PROJECTX_FLOW_STAGE} else {(Get-Content -LiteralPath (Join-Path $source 'ignored\production-flow\ui-stage.txt') -Raw).Trim()}
$env:PROJECTX_FLOW_SHARED_ROOT=Join-Path $source 'ignored\production-flow'
Copy-Item -LiteralPath (Join-Path $source 'scripts\production-flow-browser.cjs') -Destination $work -Force
Copy-Item -LiteralPath (Join-Path $source 'ignored\production-flow\state.json') -Destination $work -Force
if(Test-Path -LiteralPath (Join-Path $source 'ignored\production-flow\manifest.json')) {
    Copy-Item -LiteralPath (Join-Path $source 'ignored\production-flow\manifest.json') -Destination $work -Force
}
$exe=Get-ChildItem -LiteralPath (Join-Path $work 'runtime') -Filter *.exe | Select-Object -First 1
$env:ELECTRON_RUN_AS_NODE='1'
$ErrorActionPreference='Continue'
& $exe.FullName (Join-Path $work 'production-flow-browser.cjs') $stage 2>&1 | Tee-Object -FilePath (Join-Path $work ($stage.Replace(':','-')+'.log'))
$result=$LASTEXITCODE
$ErrorActionPreference='Stop'
Copy-Item -Path (Join-Path $work 'evidence\*') -Destination (Join-Path $source 'ignored\production-flow\evidence') -Force
Copy-Item -LiteralPath (Join-Path $work ($stage.Replace(':','-')+'.log')) -Destination (Join-Path $source 'ignored\production-flow\evidence') -Force
exit $result
