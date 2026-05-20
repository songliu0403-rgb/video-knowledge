---
name: video-knowledge
description: Use when a user asks about Bilibili/B站 videos, B站收藏夹列表/数量, Bilibili favorites/collections, YouTube, Douyin, local videos, BV IDs, hard subtitles, ASR transcripts, keyframes, screenshots, LLM visual judgment, or wants video reports or timestamped evidence documents with images.
metadata: {"clawdbot":{"emoji":"🎞️","requires":{"bins":["python","ffmpeg"]}},"videoKnowledge":{"emoji":"🎞️","requires":{"bins":["python","ffmpeg"]}}}
---

# Video Knowledge

Local-first pipeline that turns Bilibili 收藏夹 and Douyin 收藏/喜欢 into structured, agent-readable video reports. The skill stops at `video-report.md` + `video-evidence.md`; it does not write to a knowledge base. Knowledge-base curation, dedupe, llmwiki import are separate projects.

The agent drives this skill to: search a personal video library, score it, run batched LLM ingestion with hard budget caps, and answer "this video worth my time?" / "recommend videos about X" — always from evidence with citable timestamps, never from titles alone.

## Critical rules (apply to every interaction)

1. **No answer without evidence.** Every specific claim ("第 12 分钟讲了 X", "用了 Dot 节点") must cite a `matches[].evidenceRanges` or `operationNotes[].time`. No anchor → don't say it.
2. **No batch ingestion without explicit `-BudgetUsd`.** When the user says "跑批 / process all / top N" without naming dollars, dry-run first and ask for budget.
3. **Report errors, don't auto-fix.** Stop on errors, surface the exact code/message, let the user decide. Only HTTP 503/timeout transient retries are autonomous.
4. **Honor artifact contract.** A "completed report" means all four of `video-report.md` + `video-evidence.md` + `video-document-manifest.json` + `document-assets/` are present per `check-video`. Never invent paths from convention.
5. **Quote value verdicts verbatim.** Treat `videoValue.recommendation`, `signalProfile.primary_signal`, `safeToQuoteExactCode` as data, not opinion. Don't paraphrase.

## Decision tree: what the user wants → what to read

| User says / asks | First action | Read for details |
|---|---|---|
| "BV1xxx 怎么样?" / "这视频值不值得看?" | `answer-context --video-id <BV>` | [references/answer-context.md](references/answer-context.md) |
| "我想学 X" / "推荐学 X 的视频" | `answer-context "X"` | [references/answer-context.md](references/answer-context.md) |
| "处理这个视频" + BV/URL | `process-full <BV/URL>` | [references/bilibili.md](references/bilibili.md) |
| "处理这个抖音视频" + aweme_id/URL | `process_douyin.py <id>` (Python 3.11) | [references/douyin.md](references/douyin.md) |
| "跑批 / process all / top N" | dry-run first, ask for budget | [references/batch.md](references/batch.md) |
| "B 站收藏夹同步" / "list folders" | `sync-bilibili-favorites` / `list-bilibili-favorite-folders` | [references/bilibili.md](references/bilibili.md) |
| "抖音收藏" / "Douyin collection" | `pnpm fetch:douyin` | [references/douyin.md](references/douyin.md) |
| 报错 / 卡住 / 失败码 | report exact error, stop | [references/failure-recovery.md](references/failure-recovery.md) |
| "哪些视频要修" / 维护 | `list-quality-issues` then `verify-and-fix-reports` | [references/quality-maintenance.md](references/quality-maintenance.md) |
| 关键帧策略 / 截图细节 | `select_keyframes.py` | [references/keyframes.md](references/keyframes.md) |
| "完整命令列表" / "怎么调用 X" | grep command name | [references/commands.md](references/commands.md) |
| "这个项目做什么 / 不做什么" / 边界 | — | [references/architecture.md](references/architecture.md) |
| 工作流详细架构 / evidence-store 形状 | — | [references/workflow.md](references/workflow.md) |

## Quick start

```bash
python {baseDir}/scripts/video_knowledge.py check-environment --scope full --strict   # before any batch
python {baseDir}/scripts/video_knowledge.py answer-context "BV1xxx 怎么样?" --video-id BV1xxx
python {baseDir}/scripts/video_knowledge.py process-full "https://www.bilibili.com/video/BV1xxx/"
```

Common preflight: if `check-environment` returns `ok=false`, stop and return the raw JSON. Do not run `pip install`, `conda install`, `wget ffmpeg`, `sudo ln`, or any other ad-hoc dependency repair inside the video-processing run. A complete deployment must provide durable `yt-dlp`, `ffmpeg`, `ffprobe`, Python, API scripts, and configured model credentials before ingestion starts. Transient executables under temp directories such as `/tmp/ffmpeg` are not acceptable for batch runs.

## Skill layout

```text
SKILL.md                              # this file: rules + decision tree (start here)
references/
  answer-context.md                   # Q&A: "this video worth it?" / "recommend X"
  bilibili.md                         # Bilibili cookie, favorites sync, process-full, stages
  douyin.md                           # Douyin cookie (v20 ABE caveat), fetch, process_douyin
  batch.md                            # process-by-score: budget cap + decision tree
  commands.md                         # full command inventory by group
  quality-maintenance.md              # list-quality-issues, verify-and-fix, archive, comments
  failure-recovery.md                 # error triage matrices (Gemini/Whisper/Douyin/server)
  keyframes.md                        # select_keyframes.py strategies
  architecture.md                     # boundary, artifact contract, optional tool adapter
  workflow.md                         # evidence-store layout + invariants (deep reference)
scripts/                              # Python pipeline scripts + helpers
```

## How to read this skill

- For any single user request, read the row in the decision tree above and open that one reference. Don't preload everything.
- The critical rules above apply across all references. If two references seem to conflict, the critical rules win.
- When extending the pipeline (adding stages, providers, platforms), read [references/workflow.md](references/workflow.md) first to understand the invariants the rest of the system assumes.
