# Sync source skills/ to all known runtime copies (~/.agents, ~/.hermes).
#
# Why this exists:
#   capability-repository's capability server doesn't read source skills directly.
#   It reads from runtime skill directories (e.g. ~/.agents/skills/video-knowledge/).
#   Editing source files alone has no effect until they are copied over.
#
# Usage (any of these works):
#   pnpm sync-skills                                                       # preferred
#   powershell -NoProfile -File ./scripts/sync-skills.ps1                   # equivalent
#   powershell -NoProfile -File ./scripts/sync-skills.ps1 -DryRun           # preview only, no copy
#   powershell -NoProfile -File ./scripts/sync-skills.ps1 -ShowDetails      # print every file changed
#
# Run this whenever you change anything under skills/.
# After sync, the next transcribe-local / analyze-visual / etc. picks up the new code.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$ShowDetails
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $RepoRoot 'skills\video-knowledge'

if (-not (Test-Path $Source)) {
  Write-Error "Source not found: $Source"
  exit 1
}

# Every runtime copy we know capability/hermes servers might read from
$Targets = @(
  "$env:USERPROFILE\.agents\skills\video-knowledge",
  "$env:USERPROFILE\.hermes\skills\video-knowledge",
  "$env:USERPROFILE\.hermes\skills\media\video-knowledge"
)

$ExitMessages = @{
  0 = 'no changes'
  1 = 'files copied'
  2 = 'extras removed'
  3 = 'files copied + extras removed'
  4 = 'mismatched files (warning)'
  5 = 'mismatched + copied'
  6 = 'mismatched + extras'
  7 = 'mismatched + copied + extras'
}

$AnySynced = $false
$Skipped = @()

foreach ($t in $Targets) {
  $parent = Split-Path $t -Parent
  if (-not (Test-Path $parent)) {
    $Skipped += $t
    continue
  }

  Write-Output ""
  Write-Output "Sync -> $t"

  $rcArgs = @(
    "$Source", "$t",
    '/MIR',
    '/XD', '__pycache__', '.pytest_cache',
    '/XF', '*.pyc',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'
  )
  if ($DryRun) { $rcArgs += '/L' }

  $output = & robocopy @rcArgs 2>&1
  $code = $LASTEXITCODE
  $msg = if ($ExitMessages.ContainsKey($code)) { $ExitMessages[$code] } else { "exit code $code" }

  if ($code -le 7) {
    Write-Output "  $msg"
    if ($code -gt 0) { $AnySynced = $true }
    if ($ShowDetails) {
      $output | Where-Object { $_ -ne '' } | ForEach-Object { Write-Output "    $_" }
    }
  } else {
    Write-Output "  ERROR robocopy exit=$code"
    $output | ForEach-Object { Write-Output "    $_" }
    exit $code
  }
}

if ($Skipped.Count -gt 0) {
  Write-Output ""
  Write-Output "Skipped (runtime not installed):"
  $Skipped | ForEach-Object { Write-Output "  $_" }
}

Write-Output ""
if ($DryRun) {
  Write-Output 'DRY RUN — nothing copied. Re-run without -DryRun to apply.'
} elseif ($AnySynced) {
  Write-Output 'Sync complete. Capability server will pick up new code on next invocation.'
} else {
  Write-Output 'All targets already up-to-date.'
}
