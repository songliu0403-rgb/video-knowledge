# Process videos in descending score order, using the pre-scored list.
# High-value videos run first so the LLM quota is spent on the best
# material.
#
# Two platforms supported (-Platform bilibili|douyin):
#
#   bilibili (default): reads _collections/videos-prescored.json, calls
#                       `video_knowledge.py process-full <BV>`.
#   douyin             : reads _collections/douyin-prescored.json, calls
#                       `process_douyin.py <aweme_id>`.
#
# Both share the same scoring schema (score / tier / reasons / penalties)
# so the budget cap and progress tracking are platform-agnostic.
#
# BUDGET CAP (hard stop on $$$):
#   -BudgetUsd 30           Estimated spend ceiling. Stops before next video
#                            when estimated cumulative cost would exceed it.
#   -CostPerVideoUsd 0.5    Per-fresh-video estimate. Defaults to a
#                            conservative Gemini 3.1 Pro number; tune after
#                            you've seen a few real bills. Skipped/already-
#                            documented videos count $0.
#
# Usage:
#   pnpm process-by-score                                # all bilibili score>=50, descending
#   pnpm process-by-score:dry                            # show top 20 candidates
#   powershell ./scripts/process-by-score.ps1 -Platform douyin -BudgetUsd 5 -DryRun
#   powershell ./scripts/process-by-score.ps1 -Tier high -BudgetUsd 30
#
# Per-platform progress in _progress/by-score-{platform}.json.

[CmdletBinding()]
param(
  [ValidateSet('bilibili','douyin')]
  [string]$Platform = 'bilibili',
  [string]$VideoRoot = './data/video-poc',
  [int]$MinScore = 50,
  [string]$Tier = '',
  [int]$MaxVideos = 0,
  [int]$MaxConsecutiveFailures = 5,
  [string]$Provider = 'gemini',
  [string]$Endpoint = 'developer',
  [string]$Model = 'gemini-2.5-pro',
  [string]$Language = 'zh',
  [int]$MinMp4SizeBytes = 0,
  [decimal]$BudgetUsd = 0,
  [decimal]$CostPerVideoUsd = 0.5,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$python = 'python'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vk = Join-Path $repoRoot 'skills\video-knowledge\scripts\video_knowledge.py'
$dyProcess = Join-Path $repoRoot 'skills\video-knowledge\scripts\process_douyin.py'

if ($Platform -eq 'douyin') {
  $prescoredPath = Join-Path $VideoRoot '_collections\douyin-prescored.json'
  $idField = 'aweme_id'
  $titleField = 'title'
  $contextField = 'source'    # 'collection' or 'likes'
  $progressName = 'by-score-douyin.json'
} else {
  $prescoredPath = Join-Path $VideoRoot '_collections\videos-prescored.json'
  $idField = 'bvid'
  $titleField = 'title'
  $contextField = 'folder'
  $progressName = 'by-score-bilibili.json'
}

if (-not (Test-Path $prescoredPath)) {
  Write-Output ("ERROR: {0} not found. Run prescore first ({1})." -f $prescoredPath, $(if ($Platform -eq 'douyin') {'pnpm prescore:douyin'} else {'pnpm prescore'}))
  exit 2
}

$pre = Get-Content $prescoredPath -Raw -Encoding UTF8 | ConvertFrom-Json
$candidates = $pre.videos | Where-Object { [int]$_.score -ge $MinScore }
if ($Tier) { $candidates = $candidates | Where-Object { $_.tier -eq $Tier } }
$candidates = $candidates | Sort-Object @{Expression='score';Descending=$true}, @{Expression='duration';Descending=$false}
if ($MaxVideos -gt 0) { $candidates = $candidates | Select-Object -First $MaxVideos }

$total = $candidates.Count
Write-Output ("Candidates: {0} (score>=$MinScore{1})" -f $total, $(if ($Tier) {', tier=' + $Tier} else {''}))

if ($DryRun) {
  $candidates | Select-Object -First 20 | ForEach-Object {
    $title = $_.$titleField; if ($title -and $title.Length -gt 50) { $title = $title.Substring(0, 50) + '...' }
    $id = $_.$idField
    $context = $_.$contextField
    Write-Output ("  {0,3} [{1,-6}] {2,-22} ({3,-12}, {4,5}s) {5}" -f $_.score, $_.tier, $id, $context, ($_.duration | ForEach-Object { if ($_) {$_} else {0} }), $title)
  }
  if ($total -gt 20) { Write-Output ("  ... and {0} more" -f ($total - 20)) }
  Write-Output ''
  if ($BudgetUsd -gt 0) {
    $maxFresh = [int][math]::Floor($BudgetUsd / $CostPerVideoUsd)
    $worstCaseSpend = [math]::Min($total, $maxFresh) * $CostPerVideoUsd
    Write-Output ('Budget cap: ${0:N2} @ ${1:N2}/video => up to {2} fresh videos.' -f $BudgetUsd, $CostPerVideoUsd, $maxFresh)
    Write-Output ('Worst-case spend if all {0} candidates are fresh: ${1:N2}' -f $total, ($total * $CostPerVideoUsd))
    Write-Output ('Worst-case spend with budget cap: ${0:N2}' -f $worstCaseSpend)
  } else {
    $worstCaseSpend = $total * $CostPerVideoUsd
    Write-Output ('No budget cap. Worst-case spend (all {0} candidates fresh @ ${1:N2}/video): ${2:N2}' -f $total, $CostPerVideoUsd, $worstCaseSpend)
    Write-Output 'Add -BudgetUsd <amount> to cap.'
  }
  exit 0
}

$progressDir = Join-Path $repoRoot '_progress'
New-Item -ItemType Directory -Path $progressDir -Force | Out-Null
$progressPath = Join-Path $progressDir $progressName

$state = [PSCustomObject]@{
  startedAt = (Get-Date).ToString('o')
  total = $total
  budgetUsd = $BudgetUsd
  costPerVideoUsd = $CostPerVideoUsd
  stats = @{ processed = 0; skipped = 0; failed = 0; spentUsd = 0 }
  items = @()
}

if ($BudgetUsd -gt 0) {
  $maxFresh = [int][math]::Floor($BudgetUsd / $CostPerVideoUsd)
  Write-Output ('Budget: ${0:N2} @ ${1:N2}/video => up to {2} fresh videos before hard stop' -f $BudgetUsd, $CostPerVideoUsd, $maxFresh)
} else {
  Write-Output 'Budget: unlimited (set -BudgetUsd to cap spend)'
}
Write-Output ""

$ok = 0; $skipped = 0; $fail = 0; $consec = 0
$spent = [decimal]0
$start = Get-Date
$budgetHit = $false

foreach ($v in $candidates) {
  # Hard-stop before starting next fresh video if we'd cross the budget.
  if ($BudgetUsd -gt 0 -and ($spent + $CostPerVideoUsd) -gt $BudgetUsd) {
    Write-Output ('Stopping: budget cap reached (spent ${0:N2} / ${1:N2}; next video would exceed)' -f $spent, $BudgetUsd)
    $budgetHit = $true
    break
  }

  $i = $ok + $skipped + $fail + 1
  $stamp = Get-Date -Format 'HH:mm:ss'
  $vId = $v.$idField
  $vContext = $v.$contextField
  $titleShort = $v.$titleField; if ($titleShort -and $titleShort.Length -gt 40) { $titleShort = $titleShort.Substring(0, 40) + '...' }
  $budgetLabel = if ($BudgetUsd -gt 0) { (' spent=${0:N2}/${1:N2}' -f $spent, $BudgetUsd) } else { '' }
  # Note: single-quoted format string above so ${0:N2} is treated literally by -f operator.
  Write-Output ("[{0} {1}/{2}] {3} score={4} {5} | {6}{7}" -f $stamp, $i, $total, $vId, $v.score, $vContext, $titleShort, $budgetLabel)

  if ($Platform -eq 'douyin') {
    $out = & $python $dyProcess $vId `
      --endpoint $Endpoint `
      --model $Model --language $Language 2>&1 | Out-String
  } else {
    $out = & $python $vk process-full $vId `
      --provider $Provider --endpoint $Endpoint `
      --model $Model --language $Language 2>&1 | Out-String
  }

  $outcome = 'failed'
  $reason = ''
  $videoCost = [decimal]0
  $successPattern = if ($Platform -eq 'douyin') { 'Done\.\s+\S+\s+processed' } else { '"outcome":\s*"processed"' }
  if ($out -match $successPattern) {
    $outcome = 'processed'
    # Distinguish "real" vs "already-documented skip" — already-documented have steps:0 or minimal
    $hasFreshWork = if ($Platform -eq 'douyin') {
      ($out -match '\[capture\]') -or ($out -match '\[transcribe-local\] starting') -or ($out -match '\[analyze-visual\] starting')
    } else {
      ($out -match '"captureLocal"') -or ($out -match '"transcribeLocal"') -or ($out -match '"analyzeVisual"')
    }
    if (-not $hasFreshWork) {
      $outcome = 'skipped'
      $skipped++
      Write-Output '    skipped (already documented, no $ spent)'
    } else {
      $ok++
      $consec = 0
      $videoCost = $CostPerVideoUsd
      $spent += $videoCost
    }
  } else {
    $fail++; $consec++
    $tail = ($out.Trim() -split "`n")[-1]
    if ($tail.Length -gt 140) { $tail = $tail.Substring(0, 140) }
    Write-Output ("    FAIL: {0}" -f $tail)
    $reason = $tail
    # Conservative: count failure as a partial spend (model may have run before crashing).
    $videoCost = $CostPerVideoUsd * 0.5
    $spent += $videoCost
  }

  $state.stats.processed = $ok
  $state.stats.skipped = $skipped
  $state.stats.failed = $fail
  $state.stats.spentUsd = [math]::Round($spent, 2)
  $state.items += [PSCustomObject]@{
    platform = $Platform
    id = $vId
    score = $v.score
    tier = $v.tier
    context = $vContext
    outcome = $outcome
    reason = $reason
    costUsd = $videoCost
    finishedAt = (Get-Date).ToString('HH:mm:ss')
  }
  $state | ConvertTo-Json -Depth 6 | Set-Content $progressPath -Encoding UTF8

  if ($MaxConsecutiveFailures -gt 0 -and $consec -ge $MaxConsecutiveFailures) {
    Write-Output ("Stopping: {0} consecutive failures" -f $consec)
    break
  }
}

$elapsed = (Get-Date) - $start
Write-Output ""
$summarySuffix = if ($budgetHit) { ' (BUDGET HIT)' } else { '' }
Write-Output ('===== Summary: processed={0} skipped={1} failed={2} spent=${3:N2} elapsed={4:N1} min{5} =====' -f $ok, $skipped, $fail, $spent, $elapsed.TotalMinutes, $summarySuffix)
Write-Output ""
Write-Output "Next: pnpm finish  (run after batch completes for full report sync)"
