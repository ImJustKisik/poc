param()

$ErrorActionPreference = 'Stop'

$clientRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $clientRoot 'dev-runtime\desktop-dev.pid'

if (-not (Test-Path $pidFile)) {
  exit 0
}

$pid = Get-Content $pidFile | Select-Object -First 1
if ($pid) {
  Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
