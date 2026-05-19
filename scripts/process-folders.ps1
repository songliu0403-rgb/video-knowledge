# Run process-folder-missing-reports across multiple favorite folders, one
# folder at a time. Used for the "burn the gift quota" pass — each folder is
# drained until either it completes, hits the per-folder consecutive-failure
# guard, or hits the global cap. Per-folder progress is written under
# _progress/<folder-slug>.json so a resumed run can skip what's done.
#
# Usage:
#   powershell -NoProfile -File ./scripts/process-folders.ps1
#   powershell -NoProfile -File ./scripts/process-folders.ps1 -DryRun
#   powershell -NoProfile -File ./scripts/process-folders.ps1 -Folders 'ue','HLSL'
#   powershell -NoProfile -File ./scripts/process-folders.ps1 -MaxVideosPerFolder 30
#
# Defaults are P1 technical folders (~458 videos). Trim per-folder cap or
# folder list if quota is tight.

[CmdletBinding()]
param(
  [string[]]$Folders = @(
    '技术美术-材质',
    'HLSL',
    'Houdini',
    '特效教程',
    'ue',
    'Niagara/Shader VFX'
  ),
  [int]$MaxVideosPerFolder = 0,
  [int]$MaxConsecutiveFailures = 5,
  [string]$Provider = 'gemini',
  [string]$Endpoint = 'vertex-express',
  [string]$Model = 'gemini-3.1-pro-preview',
  [string]$Language = 'zh',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'

$progressDir = Join-Path $repoRoot '_progress'
New-Item -ItemType Directory -Path $progressDir -Force | Out-Null

function Slugify([string]$s) {
  $clean = $s -replace '[\\/\:\*\?"<>\|\s]+', '_'
  $clean = $clean -replace '_+', '_'
  return $clean.Trim('_')
}

if ($DryRun) {
  Write-Output "Dry-run. Would process folders:"
  foreach ($f in $Folders) {
    $slug = Slugify $f
    Write-Output ("  - {0}  (progress: _progress/{1}.json)" -f $f, $slug)
  }
  Write-Output ""
  Write-Output ("Provider={0} Endpoint={1} Model={2}" -f $Provider, $Endpoint, $Model)
  Write-Output ("MaxVideosPerFolder={0}, MaxConsecutiveFailures={1}" -f $MaxVideosPerFolder, $MaxConsecutiveFailures)
  exit 0
}

$globalStart = Get-Date
$totalProcessed = 0
$totalBlocked = 0

foreach ($folder in $Folders) {
  $slug = Slugify $folder
  $progressPath = Join-Path $progressDir "$slug.json"
  $folderStart = Get-Date

  Write-Output ""
  Write-Output ("=========================================================")
  Write-Output (" Folder: {0}  (progress: {1})" -f $folder, $progressPath)
  Write-Output ("=========================================================")

  $args = @(
    'process-folder-missing-reports', $folder,
    '--one-by-one',
    '--provider', $Provider,
    '--endpoint', $Endpoint,
    '--model', $Model,
    '--language', $Language,
    '--max-consecutive-failures', "$MaxConsecutiveFailures",
    '--progress-file', $progressPath
  )
  if ($MaxVideosPerFolder -gt 0) {
    $args += '--max-videos'
    $args += "$MaxVideosPerFolder"
  }

  $proc = Start-Process -FilePath $python -ArgumentList ($vk + ' ' + ($args -join ' ')) `
    -NoNewWindow -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $progressDir "$slug.stdout.log") `
    -RedirectStandardError (Join-Path $progressDir "$slug.stderr.log")

  $folderElapsed = (Get-Date) - $folderStart

  # Inspect progress file for stats
  if (Test-Path $progressPath) {
    try {
      $p = Get-Content $progressPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $stats = $p.stats
      Write-Output ("  done: processed={0} blocked={1} failed={2} skipped={3} elapsed={4:N1}min" -f `
        $stats.processed, $stats.blocked, $stats.failed, $stats.skipped, $folderElapsed.TotalMinutes)
      $totalProcessed += [int]$stats.processed
      $totalBlocked += [int]$stats.blocked
    } catch {
      Write-Output "  WARN: progress file parse failed"
    }
  } else {
    Write-Output "  WARN: no progress file written"
  }
}

$globalElapsed = (Get-Date) - $globalStart
Write-Output ""
Write-Output ("===== Global summary =====")
Write-Output ("  totalProcessed={0}  totalBlocked={1}  elapsed={2:N1}min" -f $totalProcessed, $totalBlocked, $globalElapsed.TotalMinutes)
Write-Output ""
Write-Output "Next: pnpm fetch-comments-all -- -SkipExisting && pnpm recompose-all && pnpm sanity"
