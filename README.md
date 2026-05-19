# Video Knowledge

Local-first pipeline that turns Bilibili 收藏夹 and Douyin 收藏/喜欢 into structured, agent-readable video reports. Designed for an agent to drive: search a personal video library, score it, run batched LLM ingestion with hard budget caps, and answer questions like "这个视频怎么样?" / "我想学 X，推荐什么?" — always from evidence with citable timestamps, never from titles alone.

## What it does

```
┌─────────────────┐    ┌────────────────────────┐    ┌──────────────────────┐
│ Source          │ →  │ Pipeline               │ →  │ What the agent can do │
└─────────────────┘    └────────────────────────┘    └──────────────────────┘

  B站 收藏夹       ─▶ prescore (score + tier)
  抖音 收藏/喜欢   ─▶ │
                     ▼
                process-full  /  process_douyin
                   ├── capture (yt-dlp + cookie / f2)
                   ├── ASR (local Whisper, $0)
                   ├── visual (Gemini 2.5 Pro on AI Studio)
                   ├── compose bundle + report
                   └── verify-and-fix
                     │
                     ▼
              video-report.md  +  video-evidence.md
              + video_value (score / tier / recommendation)
              + signal_profile (visual / audio / both)
                     │
                     ▼
                answer-context  (search → ranked by matches + video_value)
                   ├── "BV1xx 怎么样?"   → tier + recommendation + reasons
                   └── "我想学 X"        → top + alternates (each w/ evidence)
```

## Core ideas

- **No claim without evidence.** Every report carries a `video_value` block (score / tier / recommendation) and a `signal_profile` (which modality the video actually relies on). The agent answers "is this worth watching?" by quoting these fields, never by paraphrasing the title.
- **No batch ingestion without an explicit budget.** The batch runner takes a hard `-BudgetUsd` cap and stops before it would cross it.
- **Local-first.** ASR uses `faster-whisper` locally and costs nothing. The only paid surface is visual analysis (Gemini 2.5 Pro). LM Studio + Qwen2.5-VL is kept as an offline standby; its OCR quality on professional UI is verified lower than Gemini, so it's a fallback only.
- **Agent reports, user decides.** When a stage errors out, the pipeline surfaces the exact code/message and stops. No silent provider switching, no autonomous "repairs". The `SKILL.md` triage matrix documents the right first response for every error class.
- **Honest about silent videos.** BGM/no-speech videos get a `no_speech` ASR status (rather than `failed`), so they don't pollute the "needs fixing" list.

## Pipeline stages

1. **Collect** — `bilibili.favorites.sync` (capability) or `fetch_douyin_collections.py` (script) pulls the user's saved lists into `data/video-poc/_collections/`.
2. **Score** — `prescore_favorites.py` / `prescore_douyin.py` write a unified `score / tier / reasons` JSON. Bilibili uses folder + B-API stats; Douyin uses content-source + duration + hashtag + top-author signals.
3. **Process** — `process-full` (Bilibili) or `process_douyin.py` (Douyin) runs capture → ASR → visual → compose-bundle → compose-document → verify-and-fix as one command. Short-video params auto-tune from ffprobe duration.
4. **Verify** — `verify-and-fix-reports` injects data-quality banners (low ASR coverage, no_speech, chapter-boundary disclaimers), neutralizes unsafe-to-quote OCR code, and patches signal-profile mismatches.
5. **Query** — `answer-context` returns `videoValue` + `signalProfile` + ranked `alternates[]` each with 2 evidence anchors, so the agent answers with citations in one round trip.

## Requirements

- Node.js 20+ and `pnpm`
- Python 3.14 (main pipeline) **and** Python 3.11 (only for Douyin; `f2-douyin` has no 3.14 wheels yet)
- `ffmpeg` / `ffprobe` on PATH
- Gemini API key (AI Studio paid tier) if you want visual analysis
- Browser logged in to Bilibili (cookie auto-refresh helper included) and/or Douyin (cookie exported via Cookie-Editor extension)

See **[docs/SETUP.md](docs/SETUP.md)** for first-time setup.

## Quick start

```bash
pnpm install
pnpm dev                                  # capability server on http://localhost:4317
pnpm sanity                               # 11 sanity checks
```

Ask about a video already in your library:

```bash
python skills/video-knowledge/scripts/video_knowledge.py answer-context "BV1xxxx 怎么样?" --video-id BV1xxxx
```

Ingest one Bilibili video:

```bash
python skills/video-knowledge/scripts/video_knowledge.py process-full "https://www.bilibili.com/video/BV1xxxx/"
```

Ingest one Douyin video (Python 3.11 needed for `f2`):

```bash
python3.11 skills/video-knowledge/scripts/process_douyin.py 7641173377796902170
```

Batch with a budget cap (Bilibili):

```bash
pnpm process-by-score:dry                                            # preview cost
powershell -File scripts/process-by-score.ps1 -Tier high -BudgetUsd 30 -MaxVideos 50
```

Batch (Douyin):

```bash
pnpm process-by-score:douyin:dry
powershell -File scripts/process-by-score.ps1 -Platform douyin -MinScore 85 -BudgetUsd 5 -MaxVideos 10
```

The full agent-facing guide is **[skills/video-knowledge/SKILL.md](skills/video-knowledge/SKILL.md)** — ~700 lines covering every command, failure mode, and scenario.

## Project layout

| Path | Role |
|---|---|
| `src/plugins/plugin-video-knowledge/` | TypeScript plugin: search, ingest queue, bundle composition, report rendering, OpenClaw HTTP adapter |
| `src/` (rest) | Capability server: registry, executor, connectors, runtimes, control plane, HTTP routes |
| `skills/video-knowledge/SKILL.md` | Agent-facing skill instructions — start here when wiring up an agent |
| `skills/video-knowledge/scripts/` | Python pipeline (`video_knowledge.py`, `capture_douyin.py`, `process_douyin.py`, Whisper/Gemini helpers, prescore scripts) |
| `scripts/` | PowerShell batch runners (`process-by-score.ps1`, `sanity-check.ps1`, `recompose-all-documented.ps1`, etc.) |
| `data/` | **gitignored runtime state.** Cookies, API keys, queues, collections, per-video work directories. Use `data/connectors.json.example` as a template. |
| `tests/` | TypeScript + Python test suites for the video-knowledge surface |

## Cost model

| Stage | Cost | Notes |
|---|---|---|
| Bilibili / Douyin cookie | $0 | One-time browser export |
| Whisper ASR | $0 | Local CPU or GPU |
| Gemini visual analysis | ~$0.30 per 10-min video | `gemini-2.5-pro` on AI Studio paid tier |
| Whisper alternative: Gemini ASR | ~$0.10 per 10-min video | Only if you opt in via connector config |

A typical 10-minute Bilibili tutorial costs about $0.30 end-to-end. A 30-second Douyin clip costs about $0.10. Set a monthly cap on the AI Studio billing page as a backstop; the batch runner enforces a per-run `-BudgetUsd` cap on top of that.

## HTTP surface

```
GET  /                              control console
GET  /api/health
GET  /api/capabilities              list all capabilities + their schemas
POST /api/execute                   invoke any capability by id
GET  /adapter/openclaw/tools        OpenClaw-compatible tool list
POST /adapter/openclaw/tools/:name  invoke a tool by name

# control plane
GET  /api/packages
POST /api/packages/:id/{install,enable,disable,uninstall}
GET  /api/connectors
POST /api/connectors, PATCH /api/connectors/:id, POST /api/connectors/:id/test
GET  /api/runtimes
POST /api/runtimes/:id/{detect,install,uninstall,relink}
GET  /api/control-plane             blocked/manual paths + remediation hints
```

## License

[MIT](LICENSE) — provided as-is. The video processing pipeline downloads content from third-party platforms; please respect their terms of service and the original creators' rights when using this software.
