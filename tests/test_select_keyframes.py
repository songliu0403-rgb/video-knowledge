from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "video-knowledge"
    / "scripts"
    / "select_keyframes.py"
)
SPEC = importlib.util.spec_from_file_location("select_keyframes", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
select_keyframes = importlib.util.module_from_spec(SPEC)
sys.modules["select_keyframes"] = select_keyframes
SPEC.loader.exec_module(select_keyframes)


def sample(index: int, timestamp: float, score: float = 0.4):
    return select_keyframes.FrameSample(
        index=index,
        timestamp=timestamp,
        width=1,
        height=1,
        data=bytes([index % 255]),
        score=score,
        edge=0.1,
        entropy=0.3,
        exposure=0.8,
    )


class HybridKeyframeSelectionTests(unittest.TestCase):
    def test_hybrid_adds_coverage_samples_inside_a_static_visual_cluster(self):
        samples = []
        for index in range(61):
            timestamp = index * 2.0
            score = 0.9 if timestamp in {28.0, 58.0, 88.0, 118.0} else 0.2
            samples.append(sample(index, timestamp, score=score))

        selected = select_keyframes.select_frames_for_strategy(
            samples=samples,
            clusters=[samples],
            strategy="hybrid",
            target_interval_seconds=30.0,
            change_threshold=None,
            forced_timestamps=[],
            max_frames_per_minute=0,
        )

        timestamps = [selection.frame.timestamp for selection in selected]
        gaps = [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]

        self.assertGreaterEqual(len(selected), 4)
        self.assertLessEqual(max(gaps), 30.0)
        self.assertTrue(
            any("coverage_window" in selection.reasons for selection in selected)
        )

    def test_hybrid_fills_large_gaps_left_by_edge_weighted_coverage_windows(self):
        samples = []
        for index in range(61):
            timestamp = index * 2.0
            score = 0.9 if timestamp in {0.0, 58.0, 118.0} else 0.2
            samples.append(sample(index, timestamp, score=score))

        selected = select_keyframes.select_frames_for_strategy(
            samples=samples,
            clusters=[samples],
            strategy="hybrid",
            target_interval_seconds=30.0,
            change_threshold=None,
            forced_timestamps=[],
            max_frames_per_minute=0,
        )

        timestamps = [selection.frame.timestamp for selection in selected]
        gaps = [later - earlier for earlier, later in zip(timestamps, timestamps[1:])]

        self.assertLessEqual(max(gaps), 30.0)
        self.assertTrue(any("gap_filler" in selection.reasons for selection in selected))

    def test_hybrid_can_force_the_nearest_sample_to_a_semantic_timestamp(self):
        samples = [sample(index, index * 10.0, score=0.2) for index in range(5)]

        selected = select_keyframes.select_frames_for_strategy(
            samples=samples,
            clusters=[samples],
            strategy="hybrid",
            target_interval_seconds=0,
            change_threshold=None,
            forced_timestamps=[23.0],
            max_frames_per_minute=0,
        )

        forced = [
            selection
            for selection in selected
            if "forced_timestamp" in selection.reasons
        ]

        self.assertEqual(len(forced), 1)
        self.assertEqual(forced[0].frame.timestamp, 20.0)

    def test_semantic_manifest_forces_high_value_nearest_sample(self):
        samples = [sample(index, index * 10.0, score=0.2) for index in range(8)]

        signals = [
            select_keyframes.SemanticSignal(
                start=43.0,
                end=43.0,
                score=0.92,
                reasons=["visible_code"],
                source="ocr",
            )
        ]
        selected = select_keyframes.select_frames_for_strategy(
            samples=samples,
            clusters=[samples],
            strategy="hybrid",
            target_interval_seconds=0,
            change_threshold=None,
            forced_timestamps=[],
            max_frames_per_minute=0,
            semantic_signals=signals,
            semantic_window_seconds=8.0,
            semantic_min_score=0.6,
        )

        self.assertEqual([selection.frame.timestamp for selection in selected], [40.0])
        self.assertIn("semantic_signal", selected[0].reasons)
        self.assertAlmostEqual(selected[0].frame.semantic_score, 0.92)

    def test_loads_gemini_visual_summary_as_semantic_signals(self):
        payload = {
            "results": [
                {
                    "segment_range": "01:00-02:00",
                    "analysis": {
                        "visible_text": [
                            {
                                "time": "01:15",
                                "text": "Compile Error",
                                "source": "error",
                                "confidence": "high",
                            }
                        ],
                        "operation_steps": [
                            {
                                "time": "01:20-01:30",
                                "action": "调整节点参数",
                                "confidence": "medium",
                            }
                        ],
                        "concepts": [
                            {
                                "evidence": "01:45",
                                "title": "FlowMap 偏移",
                                "confidence": "high",
                            }
                        ],
                    },
                }
            ]
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "keyframe-steps-summary.json"
            path.write_text(json.dumps(payload), encoding="utf-8")

            signals = select_keyframes.load_semantic_manifest(path)

        self.assertEqual(len(signals), 3)
        self.assertEqual(signals[0].start, 75.0)
        self.assertGreaterEqual(signals[0].score, 0.9)
        self.assertIn("visible_text:error", signals[0].reasons)


if __name__ == "__main__":
    unittest.main()
