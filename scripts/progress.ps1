# Show progress of all running batch jobs (P1 folders, retries, etc.).
# Reads _progress/*.json files written by process-folder-missing-reports.
#
# Usage:
#   pnpm progress
#   powershell -NoProfile -File ./scripts/progress.ps1

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$progressDir = Join-Path $repoRoot '_progress'

if (-not (Test-Path $progressDir)) {
  Write-Output "(no _progress directory yet)"
  exit 0
}

$files = Get-ChildItem $progressDir -Filter '*.json' |
  Where-Object { $_.BaseName -notmatch '^retry-batch' -and $_.BaseName -notmatch 'backup' } |
  Sort-Object LastWriteTime -Descending
if ($files.Count -eq 0) {
  Write-Output "(no progress files)"
  exit 0
}

$grand = @{ totalInFolder = 0; alreadyProcessed = 0; processed = 0; blocked = 0; failed = 0; skipped = 0 }

Write-Output "===== Batch progress ($((Get-Date).ToString('HH:mm:ss'))) ====="
Write-Output ""
Write-Output ("{0,-26} {1,5} {2,5} {3,5} {4,5} {5,5} {6,5}  {7}" -f 'Folder', 'Total', 'Done', 'New', 'Block', 'Fail', 'Skip', 'Updated')
Write-Output ("{0,-26} {1,5} {2,5} {3,5} {4,5} {5,5} {6,5}  {7}" -f '------', '-----', '----', '---', '-----', '----', '----', '-------')

foreach ($f in $files) {
  try {
    $d = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $stats = $d.stats
    $folderName = if ($d.folder.name) { $d.folder.name } else { $f.BaseName }
    Write-Output ("{0,-26} {1,5} {2,5} {3,5} {4,5} {5,5} {6,5}  {7}" -f `
      $folderName, `
      $stats.totalInFolder, `
      $stats.alreadyProcessed, `
      $stats.processed, `
      $stats.blocked, `
      $stats.failed, `
      $stats.skipped, `
      $f.LastWriteTime.ToString('HH:mm:ss'))
    $grand.totalInFolder += [int]$stats.totalInFolder
    $grand.alreadyProcessed += [int]$stats.alreadyProcessed
    $grand.processed += [int]$stats.processed
    $grand.blocked += [int]$stats.blocked
    $grand.failed += [int]$stats.failed
    $grand.skipped += [int]$stats.skipped
  } catch {
    Write-Output ("  WARN parse {0}: {1}" -f $f.Name, $_.Exception.Message)
  }
}

Write-Output ""
Write-Output ("Grand total: {0} videos in scope, {1} already done before this batch, {2} newly processed, {3} blocked, {4} failed, {5} skipped" -f `
  $grand.totalInFolder, $grand.alreadyProcessed, $grand.processed, $grand.blocked, $grand.failed, $grand.skipped)
$grandNew = [int]$grand.processed
Write-Output ("New videos through Gemini API this batch: {0}" -f $grandNew)

# Estimation block: use earliest progress file modification time as batch start
$starts = $files | ForEach-Object {
  try {
    $d = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($d.startedAt) { Get-Date $d.startedAt }
    elseif ($d.queuedAt) { Get-Date $d.queuedAt }
    else { $_.CreationTime }
  } catch { $_.CreationTime }
}
$earliestStart = ($starts | Sort-Object | Select-Object -First 1)
if ($earliestStart -and $grandNew -gt 0) {
  $elapsedHours = ((Get-Date) - $earliestStart).TotalHours
  if ($elapsedHours -gt 0.1) {
    $rate = $grandNew / $elapsedHours
    $remaining = $grand.totalInFolder - $grand.alreadyProcessed - $grand.processed - $grand.blocked - $grand.failed - $grand.skipped
    Write-Output ""
    Write-Output ("Speed: {0:N1} videos/hour (batch elapsed {1:N1} hours)" -f $rate, $elapsedHours)
    if ($remaining -gt 0 -and $rate -gt 0) {
      $hoursLeft = $remaining / $rate
      $eta = (Get-Date).AddHours($hoursLeft)
      Write-Output ("Remaining: {0} videos, est. {1:N1} hours, ETA {2}" -f $remaining, $hoursLeft, $eta.ToString('MM-dd HH:mm'))
    }
    # Rough Gemini API call estimate: ~12 LLM calls per video (6 ASR chunks + 5-10 visual segments)
    $callsUsed = $grandNew * 12
    Write-Output ("Est. Gemini calls burned this batch: ~{0}" -f $callsUsed)
  }
}
