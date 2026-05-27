# Quality & Maintenance

After ingestion, use these read-only / dry-run-by-default commands to inspect, repair, and reclaim space. None of them call the LLM except `retry-failed-videos` (which goes through `process-full`).

## Inspect

```bash
# Scan all videos and list quality issues (failed ASR, low coverage, tiny reports, missing reports).
python {baseDir}/scripts/video_knowledge.py list-quality-issues
python {baseDir}/scripts/video_knowledge.py list-quality-issues --only asr_failed visual_partial
```

## Rebuild index

```bash
# Rebuild the _collections/processed-video-index.json from filesystem state.
# Defaults to dry-run; pass --write to overwrite with a timestamped .backup-YYYYMMDD-HHMMSS.json beside it.
python {baseDir}/scripts/video_knowledge.py rebuild-index
python {baseDir}/scripts/video_knowledge.py rebuild-index --write
```

## Verify & fix reports

```bash
# Post-process documented video-report.md files: inject a data-quality warning banner,
# neutralize unsafe inline code (`code` -> 「code」 with caveat), add chapter confidence badges,
# and patch bundle.signal_profile.primary_signal. Idempotent via HTML banner markers.
# Default dry-run; --write creates .backup-YYYYMMDD-HHMMSS files alongside the original.
python {baseDir}/scripts/video_knowledge.py verify-and-fix-reports
python {baseDir}/scripts/video_knowledge.py verify-and-fix-reports --only BV12o63B5EFd --write
```

## Retry failed

```bash
# Re-run process-full on videos flagged by list-quality-issues. Stops after a streak of consecutive
# failures (default 3). Default dry-run.
python {baseDir}/scripts/video_knowledge.py retry-failed-videos --dry-run --max-videos 3
python {baseDir}/scripts/video_knowledge.py retry-failed-videos --only asr_failed --max-videos 5 \
    --provider gemini --endpoint developer --model gemini-2.5-pro --language zh
```

## Archive / reclaim disk

```bash
# Reclaim disk space by deleting raw video.mp4, audio chunks, and frame caches for documented videos.
# Keeps PNG/JSON/Markdown report artifacts. Default dry-run.
python {baseDir}/scripts/video_knowledge.py archive-processed-videos
python {baseDir}/scripts/video_knowledge.py archive-processed-videos --keep-mp4 --write
python {baseDir}/scripts/video_knowledge.py archive-processed-videos --write
```

## Bilibili comments

```bash
# Fetch and curate Bilibili comments for ONE video. NO LLM CALLS — uses B station's
# public reply API + rule-based filtering. Safe even after the LLM quota expires.
# Cookie + author mid auto-detected from connector config + source.info.json.
# Outputs comments.raw.json (full) and comments.curated.json (filtered) into the work dir.
#
# Curation buckets:
#   author_replies / pinned / with_author_subreply       always kept (author engaged)
#   high_likes                                            value_score >= --value-threshold
#
# value_score combines: log(like) base + length tiers + has_pictures(+30)
# + rcount(+15..+20) + tech-keyword density(+5/each, cap +25) + specific-number(+10)
# + at-question(+10) - shallow-pattern(-25) - too-short/pure-emoji penalties.
# Each curated comment carries _value_score + _value_reasons for audit.
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd --main-count 50 --sub-count 20 --sort 2 --value-threshold 25  # stricter
python {baseDir}/scripts/video_knowledge.py fetch-comments BV12o63B5EFd --no-anonymize  # keep usernames (default: anonymized to author_mid only)

# Batch fetch comments for every documented video. Top-level repo-root pnpm script.
# Use after `rebuild-index --write` so processed-video-index.json is current.
# After this finishes, run `pnpm recompose-all` to embed curated comments into
# bundle.community_signals and the report's "评论区精选" section.
# (Direct powershell bypasses pnpm's `--` separator quirk on Windows.)
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -SkipExisting
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -MainCount 50 -SubCount 30
powershell -NoProfile -File ./scripts/fetch-comments-all.ps1 -DryRun
```

## Recommended unattended-loop order

1. `process-folder-missing-reports` (with `--max-consecutive-failures 3`) processes new favorites.
2. `list-quality-issues` snapshots current state.
3. `retry-failed-videos` reruns flagged failures.
4. `verify-and-fix-reports --write` injects warning banners and neutralizes unsafe quotes.
5. `rebuild-index --write` keeps the processed-video-index aligned with filesystem state.
6. `archive-processed-videos --write` reclaims space once batches are stable.
7. `fetch-comments-all` (optional) pulls Bilibili comments and curates them for documented videos; rerun `recompose-all` afterward to embed curated comments into reports.
