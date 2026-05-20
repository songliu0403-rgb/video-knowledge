# Commands Reference

Full inventory of commands grouped by purpose. For each group, the top-level SKILL.md or one of the other references explains *when* to use them; this file is the lookup table.

## Capability listing + health

```bash
# List local video knowledge capabilities
python {baseDir}/scripts/video_knowledge.py tools

# Check local runtime prerequisites before unattended ingestion
python {baseDir}/scripts/video_knowledge.py check-environment --scope full --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope capture --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope transcribe --provider gemini --strict
python {baseDir}/scripts/video_knowledge.py check-environment --scope visual --strict
```

## Search / get / answer

```bash
python {baseDir}/scripts/video_knowledge.py search "float length" --video-id BV1EXDMB2EGm
python {baseDir}/scripts/video_knowledge.py get BV1EXDMB2EGm
python {baseDir}/scripts/video_knowledge.py check-video BV1EXDMB2EGm
python {baseDir}/scripts/video_knowledge.py answer-context "这个视频里 length 和 float3 是怎么讲的？" --video-id BV1EXDMB2EGm
```

`check-video` also returns structured transcript status and keyframe strategy metadata when available. See `references/answer-context.md` for response rules.

## Bilibili cookie + favorites

```bash
python {baseDir}/scripts/video_knowledge.py check-bilibili-cookie
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --timeout 180
python {baseDir}/scripts/video_knowledge.py refresh-bilibili-cookie --dry-run
python {baseDir}/scripts/video_knowledge.py login-bilibili --timeout 180  # alias of refresh-bilibili-cookie

python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 5000 --delay-ms 1200
python {baseDir}/scripts/video_knowledge.py sync-bilibili-favorites --limit 5000 --delay-ms 1500 --force-refresh

python {baseDir}/scripts/video_knowledge.py list-bilibili-favorite-folders
python {baseDir}/scripts/video_knowledge.py list-bilibili-favorites --status pending --limit 20
python {baseDir}/scripts/video_knowledge.py search-bilibili-favorites "HLSL length" --status pending
python {baseDir}/scripts/video_knowledge.py list-bilibili-orphans --status processed --limit 20
```

See `references/bilibili.md` for cookie + sync rules.

## Enqueue + Bilibili pipeline

```bash
python {baseDir}/scripts/video_knowledge.py enqueue-video BV1NcSfBhEYe --priority high --reason "HLSL FlowMap"

python {baseDir}/scripts/video_knowledge.py process-next
python {baseDir}/scripts/video_knowledge.py process-next BV1NcSfBhEYe

python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe
python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe --provider gemini --endpoint developer --model gemini-2.5-pro --language zh
python {baseDir}/scripts/video_knowledge.py process-full BV1NcSfBhEYe --provider gemini --endpoint developer --model gemini-2.5-pro --language zh --force

# Safe one-by-one folder runner
python {baseDir}/scripts/video_knowledge.py process-folder-missing-reports "技术美术-材质" --one-by-one \
    --provider gemini --endpoint developer --model gemini-2.5-pro --language zh \
    --progress-file <video-root>/_batch/技术美术-材质.progress.json
```

## Stage-by-stage (Bilibili)

```bash
python {baseDir}/scripts/video_knowledge.py capture-local BV1NcSfBhEYe --frame-interval-seconds 30 --max-frames 48

python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --language zh
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --endpoint developer --model gemini-2.5-pro --language zh --chunk-seconds 300 --force
python {baseDir}/scripts/video_knowledge.py transcribe-local BV1NcSfBhEYe --provider gemini --api-key-env GEMINI_API_KEY --max-chunks 1 --force

python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --mode keyframes --endpoint developer --model gemini-2.5-pro
python {baseDir}/scripts/video_knowledge.py analyze-visual BV1NcSfBhEYe --dry-run --max-segments 1

python {baseDir}/scripts/video_knowledge.py compose-bundle BV1NcSfBhEYe

python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --keyframe-preset balanced
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --auto-keyframe-selection false
python {baseDir}/scripts/video_knowledge.py compose-document BV1NcSfBhEYe --document-variant hybrid-keyframes --keyframe-manifest-path /path/to/hybrid-030.manifest.json
```

## Keyframe selection

See `references/keyframes.md` for the full command set + selection rules.

## Douyin pipeline

```bash
# Pull the user's Douyin collection + likes lists into _collections/. Cookie must already be at secrets/douyin.cookie.txt.
pnpm fetch:douyin
pnpm fetch:douyin -- --enrich-stats         # adds per-video stats (slow, ~10s/video)

# Score Douyin candidates (Python 3.14 OK; no f2 dep here)
pnpm prescore:douyin

# Process one Douyin video end-to-end (capture + ASR + visual + bundle + document + verify)
python3.11 {baseDir}/scripts/process_douyin.py <aweme_id_or_url>
python3.11 {baseDir}/scripts/process_douyin.py 7641173377796902170 --skip-capture
python3.11 {baseDir}/scripts/process_douyin.py https://v.douyin.com/mQvv4NV8y6I/ --force
```

See `references/douyin.md` for cookie + pipeline details.

## Batch pipeline (both platforms)

```bash
pnpm process-by-score:dry                                  # Bilibili dry-run (top 20 + cost preview)
pnpm process-by-score:douyin:dry                           # Douyin dry-run
powershell -NoProfile -File scripts/process-by-score.ps1 -Platform douyin -MinScore 85 -BudgetUsd 5
powershell -NoProfile -File scripts/process-by-score.ps1 -Tier high -BudgetUsd 30 -MaxVideos 25
```

See `references/batch.md` for the decision tree + scenarios + flag reference.

## Quality & maintenance

See `references/quality-maintenance.md`. Includes `list-quality-issues`, `rebuild-index`, `verify-and-fix-reports`, `retry-failed-videos`, `archive-processed-videos`, `fetch-comments` and the recommended unattended-loop order.
