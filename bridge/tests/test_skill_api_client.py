"""The bundled skill scripts must authenticate the same way the bridge does.

`skills/xiaoai-tts/scripts/api_client.py` is what a person runs by hand (or from
another agent) against the API Server. It is deliberately dependency-free, so
these tests load it from its path rather than importing it as a package.
"""

import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "xiaoai-tts" / "scripts" / "api_client.py"


def load_client():
    spec = importlib.util.spec_from_file_location("skill_api_client", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SkillClientTestCase(unittest.TestCase):
    """Point CONFIG_PATH at a throwaway config and clear the token env var."""

    def setUp(self):
        self.client = load_client()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = Path(self.tmp.name) / "config.py"
        self.write_config('APP_CONFIG = {"dsh": {"token": "from-config"}}\n')
        self.env = mock.patch.dict("os.environ", {"CONFIG_PATH": str(self.config)}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("XIAOAI_API_TOKEN", None)
        self.addCleanup(os.environ.pop, "XIAOAI_API_TOKEN", None)

    def write_config(self, text):
        self.config.write_text(text, encoding="utf-8")


class TokenSourceTest(SkillClientTestCase):
    def test_config_file_is_read(self):
        self.assertEqual("from-config", self.client.get_api_token())

    def test_environment_variable_wins(self):
        os.environ["XIAOAI_API_TOKEN"] = "from-env"
        self.assertEqual("from-env", self.client.get_api_token())

    def test_blank_environment_variable_falls_through(self):
        os.environ["XIAOAI_API_TOKEN"] = "   "
        self.assertEqual("from-config", self.client.get_api_token())

    def test_missing_config_is_not_an_error(self):
        os.environ["CONFIG_PATH"] = str(Path(self.tmp.name) / "absent.py")
        self.assertEqual("", self.client.get_api_token())

    def test_config_without_a_token_is_not_an_error(self):
        self.write_config('APP_CONFIG = {"dsh": {}}\n')
        self.assertEqual("", self.client.get_api_token())

    def test_broken_config_is_not_an_error(self):
        self.write_config("raise RuntimeError('boom')\n")
        self.assertEqual("", self.client.get_api_token())


class RequestHeaderTest(SkillClientTestCase):
    def setUp(self):
        super().setUp()
        self.captured = []

    def _urlopen(self, request, timeout=None):
        self.captured.append(request)
        return FakeResponse({"success": True})

    def test_token_is_sent_when_known(self):
        os.environ["XIAOAI_API_TOKEN"] = "sekret"
        with mock.patch.object(self.client.urllib.request, "urlopen", self._urlopen):
            self.client.check_health()
        self.assertEqual("Bearer sekret", self.captured[0].get_header("Authorization"))

    def test_config_token_is_sent_when_known(self):
        with mock.patch.object(self.client.urllib.request, "urlopen", self._urlopen):
            self.client.check_health()
        self.assertEqual("Bearer from-config", self.captured[0].get_header("Authorization"))

    def test_no_token_means_no_header(self):
        os.environ["CONFIG_PATH"] = str(Path(self.tmp.name) / "absent.py")
        with mock.patch.object(self.client.urllib.request, "urlopen", self._urlopen):
            self.client.check_health()
        self.assertIsNone(self.captured[0].get_header("Authorization"))

    def test_caller_headers_still_win(self):
        os.environ["XIAOAI_API_TOKEN"] = "sekret"
        with mock.patch.object(self.client.urllib.request, "urlopen", self._urlopen):
            self.client.api_request("/api/health", headers={"Authorization": "Bearer other"})
        self.assertEqual("Bearer other", self.captured[0].get_header("Authorization"))

    def test_a_401_explains_how_to_get_a_token(self):
        def unauthorized(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

        os.environ["XIAOAI_API_TOKEN"] = "wrong"
        with mock.patch.object(self.client.urllib.request, "urlopen", unauthorized):
            with self.assertRaises(Exception) as caught:
                self.client.check_health()
        message = str(caught.exception)
        self.assertIn("401", message)
        self.assertIn("XIAOAI_API_TOKEN", message)


if __name__ == "__main__":
    unittest.main()
