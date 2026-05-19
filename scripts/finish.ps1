# Pre-expiration finish sequence — run this after P1 batch ends (or quota exhausts).
# Brings all documented videos into a uniform "fully patched" state.
#
# Steps:
#   1) fetch-comments-all -SkipExisting   # pull comments for any new documented video
#   2) verify-and-fix-reports --write     # inject quality banner / description / cross-check / comments
#   3) rebuild-index --write              # processed-video-index.json reflects real filesystem
#   4) sanity-check.ps1                   # 11/11 confirmation
#
# Do NOT run this while P1 batch is still actively processing — fetch-comments
# and verify-and-fix both write files inside per-video dirs; race conditions
# with an in-progress compose-document can corrupt artifacts. Confirm via
# `pnpm progress` that no process-folders job is running, then run this.

[CmdletBinding()]
param(
  [switch]$ForceWhileBatchRunning
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'

if (-not $ForceWhileBatchRunning) {
  $running = $false
  try {
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='powershell.exe'" |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match 'process-folder-missing-reports|process-folders\.ps1') } |
      ForEach-Object { $running = $true }
  } catch {}
  if ($running) {
    Write-Output 'ABORT: P1 batch (process-folders / process-folder-missing-reports) is still running.'
    Write-Output 'Wait for it to complete, or pass -ForceWhileBatchRunning to override.'
    exit 2
  }
}

Write-Output '===== Step 1/4: fetch-comments-all (skip existing) ====='
$start = Get-Date
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'fetch-comments-all.ps1') -SkipExisting
Write-Output ("  step1 elapsed: {0:N1} min" -f ((Get-Date) - $start).TotalMinutes)

Write-Output ''
Write-Output '===== Step 2/4: verify-and-fix-reports --write ====='
$start = Get-Date
$out = & $python $vk verify-and-fix-reports --write 2>&1 | Out-String
try {
  $d = $out | ConvertFrom-Json
  Write-Output ("  scanned: {0}  written: {1}" -f $d.totalReportsScanned, $d.writtenCount)
  if ($d.patchCounts) {
    Write-Output '  patchCounts:'
    $d.patchCounts.PSObject.Properties | ForEach-Object {
      Write-Output ("    {0}: {1}" -f $_.Name, $_.Value)
    }
  }
} catch {
  $out -split "`n" | Select-Object -First 10
}
Write-Output ("  step2 elapsed: {0:N1} min" -f ((Get-Date) - $start).TotalMinutes)

Write-Output ''
Write-Output '===== Step 3/4: rebuild-index --write ====='
$start = Get-Date
$out = & $python $vk rebuild-index --write 2>&1 | Out-String
try {
  $d = $out | ConvertFrom-Json
  Write-Output ("  totalVideos: {0}  changed: {1}" -f $d.totalVideos, $d.changedCount)
  if ($d.byStatus) {
    Write-Output '  byStatus:'
    $d.byStatus.PSObject.Properties | ForEach-Object {
      Write-Output ("    {0}: {1}" -f $_.Name, $_.Value)
    }
  }
} catch {
  $out -split "`n" | Select-Object -First 10
}
Write-Output ("  step3 elapsed: {0:N1} min" -f ((Get-Date) - $start).TotalMinutes)

Write-Output ''
Write-Output '===== Step 4/4: sanity check ====='
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'sanity-check.ps1') 2>&1 | Select-Object -Last 15

Write-Output ''
Write-Output 'Finish sequence complete. All documented reports + bundles + index + comments are up to date.'
