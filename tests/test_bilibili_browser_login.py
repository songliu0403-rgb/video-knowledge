import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "video-knowledge"
    / "scripts"
    / "bilibili_browser_login.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("bilibili_browser_login", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load bilibili_browser_login.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BilibiliBrowserLoginTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_find_wsl_powershell_uses_windows_system_path_when_not_on_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "powershell.exe"
            target.write_text("fake powershell", encoding="utf-8")

            with patch.object(self.module.shutil, "which", return_value=None), patch.object(
                self.module,
                "WSL_POWERSHELL_CANDIDATES",
                [str(target)],
            ):
                self.assertEqual(self.module.find_wsl_powershell(), str(target))

    def test_launch_wsl_browser_falls_back_to_direct_windows_exe(self):
        browser = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
        args = [
            browser,
            "--remote-debugging-port=9223",
            "--user-data-dir=C:\\Users\\example\\.video-knowledge\\secrets\\profile",
            "https://passport.bilibili.com/login",
        ]

        captured = {}

        def fake_popen(command, stdout=None, stderr=None):
            captured["command"] = command
            return SimpleNamespace(pid=12345)

        with patch.object(self.module, "find_wsl_powershell", return_value=None), patch.object(
            self.module.subprocess,
            "Popen",
            fake_popen,
        ):
            launched = self.module.launch_wsl_browser(browser, args)

        self.assertEqual(launched["launchedVia"], "direct-windows-exe")
        self.assertEqual(launched["pid"], 12345)
        self.assertEqual(captured["command"], args)

    def test_launch_wsl_browser_reports_all_launcher_options_when_unavailable(self):
        browser = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
        args = [browser, "https://passport.bilibili.com/login"]

        with patch.object(self.module, "find_wsl_powershell", return_value=None), patch.object(
            self.module.subprocess,
            "Popen",
            side_effect=OSError("interop disabled"),
        ):
            with self.assertRaisesRegex(
                self.module.BrowserLoginError,
                "Tried powershell.exe",
            ):
                self.module.launch_wsl_browser(browser, args)

    def test_launch_wsl_browser_uses_encoded_powershell_script(self):
        browser = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
        args = [
            browser,
            "--remote-debugging-port=9223",
            "--remote-debugging-address=0.0.0.0",
            "--user-data-dir=C:\\Users\\example\\profile path",
            "https://passport.bilibili.com/login",
        ]
        captured = {}

        def fake_run(command, capture_output=None, text=None, timeout=None):
            captured["command"] = command
            return SimpleNamespace(returncode=0, stdout='{"Id":123,"ArgumentCount":4}', stderr="")

        with patch.object(self.module, "find_wsl_powershell", return_value="/mnt/c/powershell.exe"), patch.object(
            self.module.subprocess,
            "run",
            fake_run,
        ):
            launched = self.module.launch_wsl_browser(browser, args)

        self.assertEqual(launched["launchedVia"], "/mnt/c/powershell.exe")
        self.assertEqual(launched["process"], {"Id": 123, "ArgumentCount": 4})
        self.assertIn("-EncodedCommand", captured["command"])
        encoded = captured["command"][captured["command"].index("-EncodedCommand") + 1]
        decoded = base64.b64decode(encoded).decode("utf-16le")
        self.assertIn("Start-Process -FilePath $browser -ArgumentList $browserArgs", decoded)
        self.assertIn("'--remote-debugging-address=0.0.0.0'", decoded)
        self.assertNotIn("$args[0]", decoded)

    def test_launch_browser_exposes_devtools_to_wsl_host(self):
        browser = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
        captured = {}

        def fake_launch(wsl_browser, args):
            captured["browser"] = wsl_browser
            captured["args"] = args
            return {"launchedVia": "test", "browser": wsl_browser}

        with tempfile.TemporaryDirectory() as temp_dir, patch.object(self.module, "is_wsl", return_value=True), patch.object(
            self.module,
            "launch_wsl_browser",
            fake_launch,
        ):
            launched = self.module.launch_browser(browser, Path(temp_dir), 9223)

        self.assertEqual(launched["launchedVia"], "test")
        self.assertIn("--remote-debugging-address=0.0.0.0", captured["args"])
        self.assertIn("--remote-debugging-port=9223", captured["args"])

    def test_wait_for_devtools_tries_wsl_host_candidates(self):
        calls = []

        def fake_http_json(url, timeout=2):
            calls.append(url)
            if "172.20.0.1" in url:
                return {"Browser": "Chrome"}
            raise self.module.BrowserLoginError("connection refused")

        with patch.object(self.module, "devtools_host_candidates", return_value=["172.20.0.1", "127.0.0.1"]), patch.object(
            self.module,
            "http_json",
            fake_http_json,
        ):
            result = self.module.wait_for_devtools(9223, timeout=0.1)

        self.assertEqual(result["host"], "172.20.0.1")
        self.assertEqual(result["version"], {"Browser": "Chrome"})
        self.assertEqual(calls, ["http://172.20.0.1:9223/json/version"])

    def test_choose_target_rewrites_local_websocket_host(self):
        targets = [
            {
                "type": "page",
                "url": "https://passport.bilibili.com/login",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/page/abc",
            },
        ]

        with patch.object(self.module, "list_targets", return_value=targets):
            ws_url = self.module.choose_target(9223, "172.20.0.1")

        self.assertEqual(ws_url, "ws://172.20.0.1:9223/devtools/page/abc")


if __name__ == "__main__":
    unittest.main()
