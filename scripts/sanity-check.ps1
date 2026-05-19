# Sanity check the video-knowledge pipeline.
#
# Run this after every code change. It verifies the obvious breakage modes
# WITHOUT calling Gemini/LLM (no API quota burned):
#   - source files exist and compile
#   - source <-> ~/.agents runtime copies are in sync
#   - read-only CLI commands (list-quality-issues, rebuild-index --dry-run) work
#   - the fixture video (default BV12o63B5EFd) has expected artifacts and a
#     non-failed transcript quality status
#
# Usage:
#   pnpm sanity                                                            # preferred
#   powershell -NoProfile -File ./scripts/sanity-check.ps1
#   powershell -NoProfile -File ./scripts/sanity-check.ps1 -Fixture BV12o63B5EFd
#   powershell -NoProfile -File ./scripts/sanity-check.ps1 -VideoRoot D:\path\to\video-poc
#
# Exit code 0 on pass, non-zero on any failure.

[CmdletBinding()]
param(
  [string]$Fixture = 'BV12o63B5EFd',
  [string]$VideoRoot = './data/video-poc'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $RepoRoot 'skills\video-knowledge'

# Pick the Python interpreter
$Python = if (Test-Path 'python') {
  'python'
} else {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $cmd.Source } else { $null }
}
if (-not $Python) {
  Write-Output "FAIL: no Python interpreter found"
  exit 2
}

$script:failures = @()
$script:passed = @()

function Check {
  param([string]$Name, [scriptblock]$Body)
  try {
    $result = & $Body
    if ($result -eq $false) {
      $script:failures += $Name
      Write-Output "  FAIL: $Name"
    } else {
      $script:passed += $Name
      Write-Output "  ok:   $Name"
    }
  } catch {
    $script:failures += ("{0}: {1}" -f $Name, $_.Exception.Message)
    Write-Output ("  FAIL: {0} -- {1}" -f $Name, $_.Exception.Message)
  }
}

Write-Output ("===== sanity check (fixture={0}) =====" -f $Fixture)
Write-Output ("python = {0}" -f $Python)
Write-Output ("source = {0}" -f $Source)
Write-Output ""

# 1. Source files exist
Check 'source skill files present' {
  $required = @(
    'SKILL.md',
    'scripts\video_knowledge.py',
    'scripts\transcribe_audio_gemini.py',
    'scripts\analyze_visual_gemini.py',
    'scripts\select_keyframes.py'
  )
  foreach ($rel in $required) {
    $p = Join-Path $Source $rel
    if (-not (Test-Path $p)) { throw ("missing {0}" -f $rel) }
  }
  $true
}

# 2. Source <-> .agents in sync (size match on critical scripts)
Check 'source <-> .agents in sync' {
  $files = @(
    'scripts\transcribe_audio_gemini.py',
    'scripts\analyze_visual_gemini.py',
    'scripts\video_knowledge.py',
    'scripts\select_keyframes.py'
  )
  foreach ($rel in $files) {
    $a = (Get-Item (Join-Path $Source $rel)).Length
    $tgt = Join-Path "$env:USERPROFILE\.agents\skills\video-knowledge" $rel
    if (-not (Test-Path $tgt)) { throw ("missing in .agents: {0} (run pnpm sync-skills)" -f $rel) }
    $b = (Get-Item $tgt).Length
    if ($a -ne $b) { throw ("size mismatch on {0}: source={1} agents={2} (run pnpm sync-skills)" -f $rel, $a, $b) }
  }
  $true
}

# 3. Python scripts compile
$pyScripts = @(
  'scripts\video_knowledge.py',
  'scripts\transcribe_audio_gemini.py',
  'scripts\analyze_visual_gemini.py',
  'scripts\select_keyframes.py'
)
foreach ($rel in $pyScripts) {
  $name = Split-Path $rel -Leaf
  Check ("{0} compiles" -f $name) {
    $full = Join-Path $Source $rel
    $out = & $Python -m py_compile $full 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $out.Trim() }
    $true
  }
}

# 4. list-quality-issues runs (read-only)
Check 'list-quality-issues runs' {
  $vk = Join-Path $Source 'scripts\video_knowledge.py'
  $out = & $Python $vk list-quality-issues --video-root $VideoRoot 2>&1 | Out-String
  if ($out -notmatch '"ok":\s*true') { throw "no ok=true in output" }
  $true
}

# 5. rebuild-index dry-run runs (read-only)
Check 'rebuild-index dry-run runs' {
  $vk = Join-Path $Source 'scripts\video_knowledge.py'
  $out = & $Python $vk rebuild-index --video-root $VideoRoot 2>&1 | Out-String
  if ($out -notmatch '"ok":\s*true') { throw "no ok=true in output" }
  if ($out -notmatch '"totalVideos":\s*\d+') { throw "no totalVideos field" }
  $true
}

# 6. Fixture has artifacts and acceptable quality
$fixDir = Join-Path $VideoRoot $Fixture
Check ("fixture {0} report >= 5KB" -f $Fixture) {
  $report = Join-Path $fixDir 'video-report.md'
  if (-not (Test-Path $report)) { throw "missing video-report.md" }
  $size = (Get-Item $report).Length
  if ($size -lt 5000) { throw ("too small: {0} bytes" -f $size) }
  $true
}

Check ("fixture {0} transcript-quality status not 'failed'" -f $Fixture) {
  $qf = Join-Path $fixDir 'asr\transcript-quality.json'
  if (-not (Test-Path $qf)) { throw "missing transcript-quality.json (rerun transcribe-local once on the fixture)" }
  $q = Get-Content $qf -Raw | ConvertFrom-Json
  if ($q.status -eq 'failed') { throw ("ASR status=failed (coverage={0})" -f $q.coverageRatio) }
  $true
}

Check ("fixture {0} visual summary present" -f $Fixture) {
  $vs = Join-Path $fixDir 'keyframe_steps\keyframe-steps-summary.json'
  if (-not (Test-Path $vs)) { throw "missing keyframe-steps-summary.json" }
  $true
}

# Summary
Write-Output ""
Write-Output ("===== summary: {0} pass, {1} fail =====" -f $script:passed.Count, $script:failures.Count)
if ($script:failures.Count -gt 0) {
  Write-Output ""
  Write-Output "Failures:"
  foreach ($f in $script:failures) { Write-Output ("  - {0}" -f $f) }
  exit 1
}
Write-Output "ok: all checks passed."
exit 0
