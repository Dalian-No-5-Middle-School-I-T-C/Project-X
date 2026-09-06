param(
  [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
  [string]$Ref = 'working',
  [string]$Distro = 'Ubuntu',
  [ValidateSet('candidate','baseline')][string]$Mode = 'candidate',
  [switch]$KeepRunning,
  [string]$AiEnv = ''
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (!(Test-Path 'node_modules/playwright/package.json')) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Benchmark dependency installation failed' }
  }
  if (!(Test-Path "${env:ProgramFiles(x86)}/Microsoft/Edge/Application/msedge.exe") -and !(Test-Path "$env:ProgramFiles/Microsoft/Edge/Application/msedge.exe")) {
    & node node_modules/playwright/cli.js install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Browser installation failed' }
  }
  $arguments = @('run.mjs','--source',$Source,'--ref',$Ref,'--distro',$Distro,'--mode',$Mode)
  if ($KeepRunning) { $arguments += '--keep-running' }
  if ($AiEnv) { $arguments += @('--ai-env',$AiEnv) }
  # Wake WSL before checking localhost ports; Windows can retain stale forwards
  # after a distribution's automatic shutdown until it is started again.
  & wsl.exe -d $Distro -- true
  if ($LASTEXITCODE -ne 0) { throw 'WSL startup failed' }
  & node @arguments
  $result = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $result = 2
} finally { Pop-Location }
exit $result
