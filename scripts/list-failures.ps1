# Aggregate all failed / blocked videos from _progress/*.json files.
# Shows which videos got stuck and at which stage / why.
#
# Use this between P1 batches to decide which failures are worth retrying.
#
# Usage:
#   pnpm list-failures
#   powershell -NoProfile -File ./scripts/list-failures.ps1
#   powershell -NoProfile -File ./scripts/list-failures.ps1 -ByReason

[CmdletBinding()]
param(
  [switch]$ByReason
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$progressDir = Join-Path $repoRoot '_progress'
if (-not (Test-Path $progressDir)) {
  Write-Output '(no _progress directory)'
  exit 0
}

$allFails = @()
$progressFiles = Get-ChildItem $progressDir -Filter '*.json' |
  Where-Object { $_.BaseName -notmatch '^retry-batch' -and $_.BaseName -notmatch 'backup' }
foreach ($f in $progressFiles) {
  try {
    $d = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    continue
  }
  $folderName = if ($d.folder -and $d.folder.name) { $d.folder.name } else { $f.BaseName }
  foreach ($item in $d.items) {
    if ($item.outcome -in @('failed', 'blocked')) {
      $reason = if ($item.reason) { "$($item.reason)" }
                elseif ($item.error) { ($item.error -split "`n")[0].Substring(0, [Math]::Min(120, ($item.error -split "`n")[0].Length)) }
                else { '?' }
      $allFails += [PSCustomObject]@{
        Folder = $folderName
        VideoId = $item.videoId
        Outcome = $item.outcome
        Reason = $reason
      }
    }
  }
}

Write-Output ("===== Failed / blocked videos: {0} =====" -f $allFails.Count)
Write-Output ''

if ($allFails.Count -eq 0) {
  Write-Output 'No failures recorded.'
  exit 0
}

if ($ByReason) {
  Write-Output 'Group by reason:'
  $allFails | Group-Object Reason | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ("  [{0}] {1}" -f $_.Count, $_.Name)
    $_.Group | ForEach-Object { Write-Output ("       - {0}  ({1})" -f $_.VideoId, $_.Folder) }
  }
} else {
  $allFails | Sort-Object Folder, VideoId | Format-Table -AutoSize Folder, VideoId, Outcome, Reason
  Write-Output ''
  Write-Output 'Group counts by reason:'
  $allFails | Group-Object Reason | Sort-Object Count -Descending | ForEach-Object {
    Write-Output ("  {0,3}: {1}" -f $_.Count, $_.Name)
  }
}

Write-Output ''
Write-Output 'Hint: rerun specific stages with:'
Write-Output '  - pnpm rerun-failed                         (ASR/visual stage retries, drives Gemini API)'
Write-Output '  - python video_knowledge.py process-full BV<id>  (full pipeline retry)'
