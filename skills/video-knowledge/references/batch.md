# Batch Processing (process-by-score)

When the user wants to process **many** videos at once, do **not** loop `process-full` per video manually. Use the batch runner:

```bash
pnpm process-by-score:dry                # Bilibili dry-run: top 20 + worst-case spend
pnpm process-by-score:douyin:dry         # Douyin dry-run
pnpm process-by-score                     # Bilibili real run, no budget cap, scores >= 50
pnpm process-by-score:douyin              # Douyin real run, no budget cap, scores >= 50
```

The runner reads the prescored JSON for the chosen platform, sorts by score desc + duration asc, and calls the right per-video command (`video_knowledge.py process-full` for Bilibili, `process_douyin.py` for Douyin). Re-running the same batch is safe — already-documented videos return `outcome=skipped` with $0 spend instantly.

## Mandatory budget cap (agent must enforce)

Real runs cost real money. The agent must **never** start a batch without an explicit, user-provided budget. If the user asks to "跑批 / process all / run top N" without naming a dollar figure:

1. Run dry-run first.
2. Show count of candidates + worst-case spend.
3. Ask "what's your budget for this run?".
4. Only then call with `-BudgetUsd <N>`.

```bash
powershell -NoProfile -File scripts/process-by-score.ps1 -Platform douyin -MinScore 85 -BudgetUsd 5
```

How budget cap behaves:

- Hard-stops before the next fresh video would exceed `BudgetUsd`.
- Default `-CostPerVideoUsd 0.5` is a conservative Gemini 2.5 Pro estimate for a 10-min Bilibili tutorial. Short Douyin videos are cheaper (often $0.10–0.20). Tune after the first real billing report on AI Studio.
- Skipped (already-documented) videos count $0.
- Failed videos count `CostPerVideoUsd * 0.5` toward spend because the model may have partially run before the crash.

## Filter parameters

| Flag | Default | Use |
|---|---|---|
| `-Platform bilibili\|douyin` | bilibili | Pick the source list |
| `-MinScore <N>` | 50 | Drop candidates below; use 70-95 to be selective |
| `-Tier high\|medium\|low\|skip` | any | Filter by tier label |
| `-MaxVideos <N>` | 0 (no cap) | Hard cap on number processed |
| `-MaxConsecutiveFailures <N>` | 5 | Auto-stop after N back-to-back fails |
| `-BudgetUsd <N>` | 0 (no cap) | **Required for real runs.** See above |
| `-CostPerVideoUsd <N>` | 0.5 | Per-fresh-video estimate |

## Progress tracking

`_progress/by-score-{platform}.json` is written after every video, so a crashed batch can be diagnosed without re-running. The same path is reused on rerun — earlier history is overwritten.

## Reading the batch summary

```text
===== Summary: processed=12 skipped=3 failed=1 spent=$3.85 elapsed=92.3 min =====
```

- `processed`: videos that consumed budget and now have a complete report.
- `skipped`: videos with an existing report (no LLM cost incurred).
- `failed`: pipeline errors; check `_progress/by-score-*.json` `reason` field.
- `spent`: **estimated** $$$ from `CostPerVideoUsd`, not actual billing. Cross-check against the AI Studio billing dashboard after every batch.
- If the summary ends with `(BUDGET HIT)`, more candidates remained. Either re-run with a higher budget or accept partial completion.

## Decision tree for "run a batch"

When the user says "处理 X 个" / "跑 top N" / "跑批" / "process all high tier":

1. **No count, no budget** → dry-run, show candidate count + worst-case, ask "what's your budget?".
2. **Budget only** → compute `MaxVideos = floor(BudgetUsd / 0.5)`, pass both `-BudgetUsd` and `-MaxVideos` so the user is not surprised by partial completion.
3. **Count only** → estimate spend (count × $0.5), confirm with user, then run with `-MaxVideos <count> -BudgetUsd <count*0.5*1.5>` (50% safety margin).
4. **Both supplied** → run as instructed.
5. **"看花多少钱"** → dry-run only, never real run.

## Common scenarios

| User says | Command |
|---|---|
| "Douyin 试试 5 个最高分" | `process-by-score.ps1 -Platform douyin -MinScore 85 -MaxVideos 5 -BudgetUsd 3` |
| "B 站 top 20 跑完" | confirm count → `-MaxVideos 20 -BudgetUsd 15` |
| "把所有 high 都跑完" | dry-run → confirm budget → `-Tier high -BudgetUsd <user>` |
| "估一下要花多少钱" | dry-run only |
| "继续上次没跑完的" | re-run same command; `outcome=skipped` for already-done |

For per-platform prescore details see `references/bilibili.md` and `references/douyin.md`.
