import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "video-knowledge"
    / "scripts"
    / "video_knowledge.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("video_knowledge", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load video_knowledge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VideoKnowledgeHelperTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_local_url_opener_disables_proxy(self):
        calls = {}

        def fake_proxy_handler(proxies):
            calls["proxies"] = proxies
            return ("proxy", proxies)

        def fake_build_opener(*handlers):
            calls["handlers"] = handlers
            return "opener"

        with patch.object(self.module.urllib.request, "ProxyHandler", fake_proxy_handler), patch.object(
            self.module.urllib.request,
            "build_opener",
            fake_build_opener,
        ):
            opener = self.module.url_opener("http://127.0.0.1:4317/api/capabilities")

        self.assertEqual(opener, "opener")
        self.assertEqual(calls["proxies"], {})
        self.assertEqual(calls["handlers"], (("proxy", {}),))

    def test_pnpm_command_respects_override(self):
        with patch.dict(self.module.os.environ, {"VIDEO_KNOWLEDGE_PNPM": "/tmp/pnpm"}):
            self.assertEqual(self.module.pnpm_command(), "/tmp/pnpm")

    def test_check_environment_calls_native_capability(self):
        with patch.object(self.module, "call_tool", return_value={"ok": True}) as call_tool:
            result = self.module.check_environment(
                "http://127.0.0.1:4317",
                scope="capture",
                strict=True,
                download="false",
                probe="false",
                keyframes="true",
                script_path="/tmp/visual.py",
            )

        self.assertEqual(result, {"ok": True})
        call_tool.assert_called_once_with(
            "http://127.0.0.1:4317",
            "video.environment.check",
            {
                "scope": "capture",
                "strict": "true",
                "download": "false",
                "probe": "false",
                "keyframes": "true",
                "scriptPath": "/tmp/visual.py",
            },
        )

    def test_process_full_forwards_force(self):
        with patch.object(self.module, "call_tool", return_value={"ok": True}) as call_tool:
            result = self.module.process_full_video_ingest(
                "http://127.0.0.1:4317",
                target="BV_FORCE",
                provider="gemini",
                endpoint="vertex-express",
                model="gemini-3.1-pro-preview",
                language="zh",
                force=True,
            )

        self.assertEqual(result, {"ok": True})
        call_tool.assert_called_once_with(
            "http://127.0.0.1:4317",
            "video.ingest.process-full",
            {
                "videoId": "BV_FORCE",
                "provider": "gemini",
                "endpoint": "vertex-express",
                "model": "gemini-3.1-pro-preview",
                "language": "zh",
                "force": "true",
            },
            timeout=14400,
        )

    def test_process_folder_missing_reports_runs_one_by_one_and_repairs_invalid_transcripts(self):
        favorites = {
            "data": {
                "folders": [
                    {"id": "3925007994", "title": "技术美术-材质"},
                ],
                "items": [
                    {"bvid": "BV_DONE", "folderId": "3925007994", "title": "done"},
                    {"bvid": "BV_BAD", "folderId": "3925007994", "title": "bad"},
                    {"bvid": "BV_NEW", "folderId": "3925007994", "title": "new"},
                ],
                "total": 3,
                "count": 3,
            }
        }
        checks = {
            "BV_DONE": {"data": {"ok": True, "status": "processed"}},
            "BV_BAD": {"data": {"ok": False, "status": "processed_invalid_transcript"}},
            "BV_NEW": {"data": {"ok": False, "status": "not_processed"}},
        }
        final_checks = {
            "BV_BAD": {"data": {"ok": True, "status": "processed"}},
            "BV_NEW": {"data": {"ok": True, "status": "processed"}},
        }

        check_counts = {}

        def fake_check(_base_url, video_id):
            check_counts[video_id] = check_counts.get(video_id, 0) + 1
            if check_counts[video_id] == 1:
                return checks[video_id]
            return final_checks[video_id]

        with tempfile.TemporaryDirectory() as tmp:
            progress_file = str(Path(tmp) / "progress.json")
            with patch.object(self.module, "list_bilibili_favorites", return_value=favorites) as list_favorites, patch.object(
                self.module,
                "check_processed_video",
                side_effect=fake_check,
            ), patch.object(
                self.module,
                "process_full_video_ingest",
                return_value={"data": {"outcome": "processed", "finalCheck": {"ok": True}}},
            ) as process_full:
                result = self.module.process_folder_missing_reports(
                    "http://127.0.0.1:4317",
                    folder="技术美术-材质",
                    one_by_one=True,
                    provider="gemini",
                    endpoint="vertex-express",
                    model="gemini-3.1-pro-preview",
                    language="zh",
                    progress_file=progress_file,
                )

        list_favorites.assert_has_calls(
            [
                call("http://127.0.0.1:4317", None, None, None, "500", "0"),
                call("http://127.0.0.1:4317", None, "3925007994", None, "500", "0"),
            ]
        )
        self.assertEqual([call.kwargs["target"] for call in process_full.call_args_list], ["BV_BAD", "BV_NEW"])
        self.assertEqual(process_full.call_args_list[0].kwargs["force"], True)
        self.assertEqual(process_full.call_args_list[1].kwargs["force"], False)
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["stats"]["alreadyProcessed"], 1)
        self.assertEqual(result["stats"]["processed"], 2)
        self.assertEqual(result["items"][1]["beforeStatus"], "processed_invalid_transcript")

    def test_process_folder_missing_reports_dry_run_honors_max_videos(self):
        favorites = {
            "data": {
                "folders": [{"id": "folder-1", "title": "材质"}],
                "items": [
                    {"bvid": "BV_ONE", "folderId": "folder-1"},
                    {"bvid": "BV_TWO", "folderId": "folder-1"},
                    {"bvid": "BV_THREE", "folderId": "folder-1"},
                ],
                "total": 3,
                "count": 3,
            }
        }

        with patch.object(self.module, "list_bilibili_favorites", return_value=favorites), patch.object(
            self.module,
            "check_processed_video",
            return_value={"data": {"ok": False, "status": "not_processed"}},
        ) as check_video, patch.object(self.module, "process_full_video_ingest") as process_full:
            result = self.module.process_folder_missing_reports(
                "http://127.0.0.1:4317",
                folder="材质",
                one_by_one=True,
                max_videos=1,
                dry_run=True,
            )

        self.assertEqual(result["stats"]["planned"], 1)
        self.assertEqual(result["stoppedReason"], "max_videos_reached")
        self.assertEqual(result["remainingUninspected"], 2)
        self.assertEqual(check_video.call_count, 1)
        process_full.assert_not_called()


if __name__ == "__main__":
    unittest.main()
