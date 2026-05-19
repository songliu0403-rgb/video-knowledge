# Run process-full on every queued video that is not yet documented.
#
# Use this to drain the existing ingestion queue (videos that were enqueued
# manually but haven't completed all stages yet). For new videos to enqueue,
# use bilibili.favorites.list / enqueue-video instead.
#
# Usage:
#   powershell -NoProfile -File ./scripts/process-pending.ps1
#   powershell -NoProfile -File ./scripts/process-pending.ps1 -DryRun
#   powershell -NoProfile -File ./scripts/process-pending.ps1 -MaxConsecutiveFailures 3

[CmdletBinding()]
param(
  [string]$VideoRoot = './data/video-poc',
  [int]$MaxConsecutiveFailures = 10,
  [int]$MinMp4SizeBytes = 1048576,   # 1 MB; below this is almost certainly corrupted
  [string]$Provider = 'gemini',
  [string]$Endpoint = 'vertex-express',
  [string]$Model = 'gemini-3.1-pro-preview',
  [string]$Language = 'zh',
  [switch]$DryRun,
  [switch]$IncludeBroken           # If set, do NOT skip videos with tiny / missing mp4
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'

$qPath = Join-Path $VideoRoot '_queues\video-ingest.json'
if (-not (Test-Path $qPath)) {
  Write-Output "ERROR: queue not found: $qPath"
  exit 2
}

$q = Get-Content $qPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pending = @($q.jobs | Where-Object { $_.status -ne 'done' } | ForEach-Object { $_.videoId })
$totalPending = $pending.Count
Write-Output ("Pending videos in queue (status != done): {0}" -f $totalPending)

# Mp4 health filter — broken/tiny mp4s are guaranteed to fail in ffmpeg, no point burning quota.
$skippedBroken = @()
$candidates = @()
foreach ($bv in $pending) {
  $mp4 = Join-Path $VideoRoot "$bv\video.mp4"
  if (-not (Test-Path $mp4)) {
    if ($IncludeBroken) { $candidates += $bv } else { $skippedBroken += @{ bv=$bv; reason='no mp4' } }
    continue
  }
  $size = (Get-Item $mp4).Length
  if ($size -lt $MinMp4SizeBytes -and -not $IncludeBroken) {
    $skippedBroken += @{ bv=$bv; reason="mp4 too small ($size bytes)" }
    continue
  }
  $candidates += $bv
}
$total = $candidates.Count

Write-Output ("  candidates after mp4 health filter: {0}" -f $total)
if ($skippedBroken.Count -gt 0) {
  Write-Output ("  skipped (broken mp4): {0}" -f $skippedBroken.Count)
  foreach ($s in $skippedBroken) {
    Write-Output ("    - {0}: {1}" -f $s.bv, $s.reason)
  }
}

if ($DryRun) {
  Write-Output ""
  Write-Output "Would process:"
  $candidates | ForEach-Object { Write-Output ("  - {0}" -f $_) }
  exit 0
}

$pending = $candidates

$ok = 0
$fail = 0
$failedIds = @()
$consec = 0
$start = Get-Date

foreach ($bv in $pending) {
  $i = $ok + $fail + 1
  $stamp = Get-Date -Format 'HH:mm:ss'
  Write-Output ("[{0} {1}/{2}] {3}" -f $stamp, $i, $total, $bv)

  $out = & $python $vk process-full $bv `
    --provider $Provider --endpoint $Endpoint `
    --model $Model --language $Language 2>&1 | Out-String

  if ($out -match '"outcome":\s*"processed"' -and $out -match '"finalCheck"') {
    $ok++
    $consec = 0
  } else {
    $fail++
    $failedIds += $bv
    $consec++
    $tailLine = ($out.Trim() -split "`n")[-1]
    Write-Output ("    FAIL: {0}" -f $tailLine.Substring(0, [Math]::Min(180, $tailLine.Length)))
    if ($MaxConsecutiveFailures -gt 0 -and $consec -ge $MaxConsecutiveFailures) {
      Write-Output ("Stopping: {0} consecutive failures" -f $consec)
      break
    }
  }
}

$elapsed = (Get-Date) - $start
Write-Output ""
Write-Output ("===== Summary: ok={0} fail={1} elapsed={2:N1} min =====" -f $ok, $fail, $elapsed.TotalMinutes)
if ($failedIds.Count -gt 0) {
  Write-Output ("Failed: {0}" -f ($failedIds -join ', '))
}
Write-Output ""
Write-Output "Next: pnpm fetch-comments-all (or just for new videos), then pnpm recompose-all."
