"""Bypass the process-full force bug.

Directly call `transcribe-local --force` and `analyze-visual --force` on every
video flagged by list-quality-issues. These two underlying commands honor
--force properly (verified). The retry-failed-videos / process-full pipeline
does NOT propagate force to subordinate stages, so use this script instead
when you actually need to re-run ASR or visual analysis on existing videos.

Usage:
    pnpm rerun-failed                     # rerun both ASR and visual
    pnpm rerun-failed -- --dry-run        # show targets, don't run
    pnpm rerun-failed -- --asr-only       # only re-transcribe
    pnpm rerun-failed -- --visual-only    # only re-analyze visual
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Iterable

PYTHON = r"python"
ASR_TYPES = {"asr_legacy_errors", "asr_failed", "asr_partial"}
VISUAL_TYPES = {"visual_legacy_errors", "visual_failed", "visual_partial"}


def call_vk(vk: str, *args: str) -> tuple[str, int]:
    cmd = [PYTHON, vk, *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    return (proc.stdout or ""), proc.returncode


def list_targets(vk: str, video_root: str, types: Iterable[str]) -> list[dict]:
    out, _ = call_vk(vk, "list-quality-issues", "--video-root", video_root, "--only", *types)
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        print(f"WARN: list-quality-issues output is not JSON; head: {out[:300]}", file=sys.stderr)
        return []
    return data.get("videos", []) or []


def run_phase(vk: str, label: str, targets: list[str], cmd_args: list[str], success_markers: list[str], max_consec_fail: int) -> tuple[int, int, list[str]]:
    ok = 0
    fail = 0
    failed_ids: list[str] = []
    consec = 0
    total = len(targets)
    for i, bv in enumerate(targets, 1):
        print(f"  [{label} {i}/{total}] {bv}", flush=True)
        out, rc = call_vk(vk, *cmd_args, bv)
        success = rc == 0 and any(marker in out for marker in success_markers)
        if success:
            ok += 1
            consec = 0
        else:
            fail += 1
            failed_ids.append(bv)
            consec += 1
            tail = out.strip().splitlines()[-1] if out.strip() else "(no output)"
            print(f"    FAIL: {tail[:200]}", flush=True)
            if max_consec_fail > 0 and consec >= max_consec_fail:
                print(f"  {label} phase stopping: {consec} consecutive failures", flush=True)
                break
    return ok, fail, failed_ids


def main() -> int:
    parser = argparse.ArgumentParser(description="Rerun failed transcribe / analyze-visual stages with --force.")
    parser.add_argument("--video-root", default=r"./data/video-poc")
    parser.add_argument("--asr-only", action="store_true")
    parser.add_argument("--visual-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-consecutive-failures", type=int, default=5)
    parser.add_argument("--provider", default="gemini")
    parser.add_argument("--endpoint", default="vertex-express")
    parser.add_argument("--model", default="gemini-3.1-pro-preview")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    if args.asr_only and args.visual_only:
        print("ERROR: --asr-only and --visual-only are mutually exclusive", file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parent.parent
    vk = str(repo_root / "skills" / "video-knowledge" / "scripts" / "video_knowledge.py")
    if not Path(vk).exists():
        print(f"ERROR: video_knowledge.py not found at {vk}", file=sys.stderr)
        return 2

    # Resolve targets
    asr_targets: list[str] = []
    visual_targets: list[str] = []

    if not args.visual_only:
        for v in list_targets(vk, args.video_root, ASR_TYPES):
            if set(v.get("issueTypes") or []) & ASR_TYPES:
                asr_targets.append(v["videoId"])
    if not args.asr_only:
        for v in list_targets(vk, args.video_root, VISUAL_TYPES):
            if set(v.get("issueTypes") or []) & VISUAL_TYPES:
                visual_targets.append(v["videoId"])

    asr_targets = sorted(set(asr_targets))
    visual_targets = sorted(set(visual_targets))

    print(f"ASR rerun targets:    {len(asr_targets)}")
    print(f"Visual rerun targets: {len(visual_targets)}")

    if args.dry_run:
        print("\nASR targets:")
        for bv in asr_targets:
            print(f"  - {bv}")
        print("\nVisual targets:")
        for bv in visual_targets:
            print(f"  - {bv}")
        return 0

    asr_ok = asr_fail = 0
    visual_ok = visual_fail = 0
    asr_failed: list[str] = []
    visual_failed: list[str] = []

    if asr_targets:
        print("\n===== ASR phase =====", flush=True)
        asr_args = [
            "transcribe-local",
            "--provider", args.provider,
            "--endpoint", args.endpoint,
            "--model", args.model,
            "--language", args.language,
            "--force",
        ]
        asr_ok, asr_fail, asr_failed = run_phase(
            vk, "ASR", asr_targets, asr_args,
            success_markers=['"outcome": "transcribed"', '"transcriptTextPath"'],
            max_consec_fail=args.max_consecutive_failures,
        )

    if visual_targets:
        print("\n===== Visual phase =====", flush=True)
        visual_args = [
            "analyze-visual",
            "--mode", "keyframes",
            "--endpoint", args.endpoint,
            "--model", args.model,
            "--force",
        ]
        visual_ok, visual_fail, visual_failed = run_phase(
            vk, "Visual", visual_targets, visual_args,
            success_markers=['"outcome": "visual_analyzed"', '"visualSummaryPath"'],
            max_consec_fail=args.max_consecutive_failures,
        )

    print()
    print("===== Summary =====")
    print(f"  ASR    ok={asr_ok} fail={asr_fail}")
    print(f"  Visual ok={visual_ok} fail={visual_fail}")
    if asr_failed:
        print(f"  ASR failed:    {asr_failed}")
    if visual_failed:
        print(f"  Visual failed: {visual_failed}")
    print()
    print("Next: run `pnpm recompose-all` to apply new ASR/visual into bundles + reports.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
