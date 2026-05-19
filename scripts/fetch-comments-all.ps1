# Fetch Bilibili comments for every documented video, applying rule-based
# curation. No LLM calls — purely B station public reply API + local rule
# filtering. After this finishes, run `pnpm recompose-all` to push the
# curated comments into bundle.community_signals and the report's
# "评论区精选" section.
#
# Usage:
#   pnpm fetch-comments-all                                    # default
#   pnpm fetch-comments-all -- -SkipExisting                   # only fetch missing
#   pnpm fetch-comments-all -- -MainCount 50 -SubCount 30      # bigger window
#   pnpm fetch-comments-all -- -DryRun                         # show targets
#
# B station applies 412 throttling on aggressive scraping, so default delay
# is 1500ms between calls. The script stops after MaxConsecutiveFailures
# consecutive 412/network failures rather than burning the whole list.

[CmdletBinding()]
param(
  [string]$VideoRoot = './data/video-poc',
  [int]$MainCount = 30,
  [int]$SubCount = 20,
  [int]$DelayMs = 1500,
  [int]$MinLikes = 5,
  [int]$MaxConsecutiveFailures = 5,
  [switch]$DryRun,
  [switch]$SkipExisting
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'

if (-not (Test-Path $vk)) {
  Write-Output "ERROR: video_knowledge.py not found at $vk"
  exit 2
}

$indexPath = Join-Path $VideoRoot '_collections\processed-video-index.json'
if (-not (Test-Path $indexPath)) {
  Write-Output "ERROR: processed-video-index.json not found ($indexPath). Run pnpm rebuild-index --write first."
  exit 2
}

$index = Get-Content $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bvids = @($index.videos | Where-Object {
  $_.processingStatus -eq 'documented' -or $_.processingStatus -eq 'documented_variant'
} | ForEach-Object { $_.videoId })

$total = $bvids.Count
Write-Output "Documented videos: $total"

if ($DryRun) {
  Write-Output ""
  Write-Output "(dry-run) Would fetch comments for:"
  $bvids | Select-Object -First 10 | ForEach-Object { Write-Output "  - $_" }
  if ($total -gt 10) { Write-Output "  ... and $($total - 10) more" }
  exit 0
}

$ok = 0
$skipped = 0
$fail = 0
$consec = 0
$start = Get-Date
$failedIds = @()

foreach ($bv in $bvids) {
  $existing = Join-Path $VideoRoot "$bv\comments.curated.json"
  if ($SkipExisting -and (Test-Path $existing)) {
    $skipped++
    continue
  }

  $i = $ok + $skipped + $fail + 1
  $stamp = Get-Date -Format 'HH:mm:ss'
  Write-Output ("[{0} {1}/{2}] {3}" -f $stamp, $i, $total, $bv)

  $out = & $python $vk fetch-comments $bv `
    --main-count $MainCount --sub-count $SubCount `
    --min-likes $MinLikes --delay-ms $DelayMs 2>&1 | Out-String

  if ($out -match '"curatedPath"') {
    $ok++
    $consec = 0
  } else {
    $fail++
    $consec++
    $failedIds += $bv
    $tail = ($out.Trim() -split "`n")[-1]
    Write-Output ("    FAIL: {0}" -f $tail.Substring(0, [Math]::Min(180, $tail.Length)))
    if ($MaxConsecutiveFailures -gt 0 -and $consec -ge $MaxConsecutiveFailures) {
      Write-Output ("Stopping: {0} consecutive failures (likely B-station throttling)" -f $consec)
      break
    }
  }
}

$elapsed = (Get-Date) - $start
Write-Output ""
Write-Output ("===== Summary =====")
Write-Output ("  ok={0}  skipped={1}  fail={2}  elapsed={3:N1} min" -f $ok, $skipped, $fail, $elapsed.TotalMinutes)
if ($failedIds.Count -gt 0) {
  Write-Output ("  failed BVs: {0}" -f ($failedIds -join ', '))
}
Write-Output ""
Write-Output "Next: pnpm recompose-all  (to embed curated comments into reports)"
