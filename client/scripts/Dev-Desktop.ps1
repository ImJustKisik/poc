param()

$ErrorActionPreference = 'Stop'

$clientRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$syncScript = Join-Path $PSScriptRoot 'Sync-DevRuntime.ps1'
$runtimeExe = Join-Path $clientRoot 'dev-runtime\PCM.exe'
$pidFile = Join-Path $clientRoot 'dev-runtime\desktop-dev.pid'

function Get-BuildStamp {
  $paths = @(
    (Join-Path $clientRoot 'dist'),
    (Join-Path $clientRoot 'dist-electron')
  ) | Where-Object { Test-Path $_ }

  if ($paths.Count -eq 0) {
    return ''
  }

  $latest = Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $latest) {
    return ''
  }

  return "$($latest.FullName)|$($latest.LastWriteTimeUtc.Ticks)|$($latest.Length)"
}

function Start-Desktop {
  if (-not (Test-Path $runtimeExe)) {
    return $null
  }

  return Start-Process -FilePath $runtimeExe -WorkingDirectory (Split-Path $runtimeExe) -PassThru
}

function Stop-DesktopProcess([System.Diagnostics.Process]$proc) {
  if ($proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}

$renderer = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev:web' -WorkingDirectory $clientRoot -PassThru -NoNewWindow
$builder = Start-Process -FilePath 'npx.cmd' -ArgumentList 'vite', 'build', '--watch' -WorkingDirectory $clientRoot -PassThru -NoNewWindow
$desktop = $null
$lastStamp = ''

try {
  while (-not $builder.HasExited) {
    if ($renderer.HasExited) {
      throw "Renderer dev server exited with code $($renderer.ExitCode)."
    }

    $currentStamp = Get-BuildStamp
    if ($currentStamp -and $currentStamp -ne $lastStamp) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $syncScript
      $lastStamp = $currentStamp
      Stop-DesktopProcess $desktop
      $desktop = $null

      $desktop = Start-Desktop
      if ($desktop) {
        Set-Content -Path $pidFile -Value $desktop.Id
      }
    }

    Start-Sleep -Seconds 2
  }

  throw "Electron build watcher exited with code $($builder.ExitCode)."
}
finally {
  foreach ($proc in @($renderer, $builder, $desktop)) {
    if ($proc -and -not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force
    }
  }
  if (Test-Path $pidFile) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}
