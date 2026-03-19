param()

$ErrorActionPreference = 'Stop'

$clientRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $clientRoot 'dev-runtime'
$releaseRoot = Join-Path $clientRoot 'release\win-unpacked'
$runtimeAppRoot = Join-Path $runtimeRoot 'resources\app'
$runtimeResourcesRoot = Join-Path $runtimeRoot 'resources'

if (-not (Test-Path (Join-Path $releaseRoot 'PCM.exe'))) {
  throw "Base runtime not found at $releaseRoot. Build the Electron app once before running desktop dev."
}

# Keep the unpacked Electron runtime in sync with the known-good packaged output.
& robocopy $releaseRoot $runtimeRoot /MIR /NFL /NDL /NJH /NJS /NC /NS /XD resources | Out-Null

New-Item -ItemType Directory -Force -Path $runtimeResourcesRoot | Out-Null
& robocopy (Join-Path $releaseRoot 'resources') $runtimeResourcesRoot /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null

$asarPath = Join-Path $runtimeRoot 'resources\app.asar'
if (Test-Path $asarPath) {
  Remove-Item $asarPath -Force
}

New-Item -ItemType Directory -Force -Path $runtimeAppRoot | Out-Null

$copyPairs = @(
  @{ Source = (Join-Path $clientRoot 'dist'); Target = (Join-Path $runtimeAppRoot 'dist') },
  @{ Source = (Join-Path $clientRoot 'dist-electron'); Target = (Join-Path $runtimeAppRoot 'dist-electron') },
  @{ Source = (Join-Path $clientRoot 'public'); Target = (Join-Path $runtimeAppRoot 'public') }
)

foreach ($pair in $copyPairs) {
  if (Test-Path $pair.Source) {
    New-Item -ItemType Directory -Force -Path $pair.Target | Out-Null
    & robocopy $pair.Source $pair.Target /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  }
}

Copy-Item (Join-Path $clientRoot 'package.json') (Join-Path $runtimeAppRoot 'package.json') -Force
