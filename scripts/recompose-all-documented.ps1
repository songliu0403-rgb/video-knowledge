# Recompose every documented video so they pick up the latest TS bundle/document logic.
#
# Why:
#   When ingest-queue.ts (bundle / report markdown) is updated, existing documented
#   videos still hold artifacts from older code. This script re-runs:
#     1) compose-bundle   (rebuilds bundle JSON — picks up new fields like asr_text, topic_evidence)
#     2) compose-document (rebuilds video-report.md — picks up new chapter rendering)
#     3) verify-and-fix-reports --write (re-applies quality banner + neutralizers)
#   It does NOT call any LLM; compose stages are pure text assembly.
#
# Usage:
#   pnpm recompose-all
#   powershell -NoProfile -File ./scripts/recompose-all-documented.ps1
#   powershell -NoProfile -File ./scripts/recompose-all-documented.ps1 -DryRun
#
# Pre-req:
#   - capability server running on port 4317
#   - rebuild-index --write was run recently (so processed-video-index.json is current)

[CmdletBinding()]
param(
  [string]$VideoRoot = './data/video-poc',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'

if (-not (Test-Path $vk)) {
  Write-Output ("video_knowledge.py not found: {0}" -f $vk)
  exit 2
}

$indexPath = Join-Path $VideoRoot '_collections\processed-video-index.json'
if (-not (Test-Path $indexPath)) {
  Write-Output ("processed-video-index.json not found: {0} (run rebuild-index --write first)" -f $indexPath)
  exit 2
}

$index = Get-Content $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bvids = @($index.videos | Where-Object {
  $_.processingStatus -eq 'documented' -or $_.processingStatus -eq 'documented_variant'
} | ForEach-Object { $_.videoId })

$total = $bvids.Count
Write-Output ("Found {0} documented videos to recompose" -f $total)

if ($DryRun) {
  Write-Output ""
  Write-Output "(dry-run) Would recompose:"
  $bvids | Select-Object -First 10 | ForEach-Object { Write-Output ("  - {0}" -f $_) }
  if ($total -gt 10) { Write-Output ("  ... and {0} more" -f ($total - 10)) }
  exit 0
}

$bundleFail = @()
$docFail = @()
$start = Get-Date
$i = 0
foreach ($bv in $bvids) {
  $i++
  $stamp = (Get-Date -Format 'HH:mm:ss')
  Write-Output ("[{0} {1}/{2}] {3}" -f $stamp, $i, $total, $bv)

  # compose-bundle
  $b = & $python $vk compose-bundle $bv 2>&1 | Out-String
  if ($b -notmatch '"composedAt"' -and $b -notmatch '"composed"\s*:\s*true' -and $b -notmatch '"bundlePath"') {
    $bundleFail += $bv
    Write-Output "    bundle FAIL"
    continue
  }

  # compose-document
  $d = & $python $vk compose-document $bv 2>&1 | Out-String
  if ($d -notmatch '"documentedAt"' -and $d -notmatch '"reportPath"') {
    $docFail += $bv
    Write-Output "    document FAIL"
    continue
  }
}

$elapsed = (Get-Date) - $start
Write-Output ""
Write-Output ("===== Recompose pass: {0} ok / {1} bundle-fail / {2} doc-fail (elapsed {3:N1}s) =====" -f ($total - $bundleFail.Count - $docFail.Count), $bundleFail.Count, $docFail.Count, $elapsed.TotalSeconds)

if ($bundleFail.Count -gt 0) {
  Write-Output "Bundle failures:"
  $bundleFail | ForEach-Object { Write-Output ("  - {0}" -f $_) }
}
if ($docFail.Count -gt 0) {
  Write-Output "Document failures:"
  $docFail | ForEach-Object { Write-Output ("  - {0}" -f $_) }
}

Write-Output ""
Write-Output "===== verify-and-fix-reports --write (apply quality banner / disclaimers) ====="
$verifyOut = & $python $vk verify-and-fix-reports --write 2>&1 | Out-String
# Print the patchCounts and stats summary, skip per-video details which can be huge
$lines = $verifyOut -split "`r?`n"
$summary = @()
$inVideos = $false
foreach ($line in $lines) {
  if ($line -match '"videos":') { $inVideos = $true; $summary += '  "videos": [...]'; continue }
  if ($inVideos -and $line -match '^\s*[\]\}]') { $inVideos = $false }
  if (-not $inVideos) { $summary += $line }
}
($summary -join "`n").Substring(0, [Math]::Min(3000, ($summary -join "`n").Length))

Write-Output ""
Write-Output "Done. Run pnpm sanity to confirm pipeline still healthy."
