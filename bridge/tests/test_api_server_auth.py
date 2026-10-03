"""Bearer auth for the API Server: loopback in, the network out.

The upstream API Server shipped nine endpoints with no authentication, so the
only thing protecting the speaker was the listening address. These tests pin the
rule that replaces that: loopback callers pass, everything else needs the shared
secret, and a missing secret closes the door instead of opening it.
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("dsh_xiaoai_server", types.SimpleNamespace())

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402
from multidict import CIMultiDict  # noqa: E402

from core.services import api_auth  # noqa: E402


class DecisionTableTest(unittest.TestCase):
    """The pure rule: who is let through, and why not."""

    def test_loopback_is_served_without_a_token(self):
        for peer in ("127.0.0.1", "::1", "127.0.0.5"):
            with self.subTest(peer=peer):
                self.assertIsNone(api_auth.authorize("", "", peer))
                self.assertIsNone(api_auth.authorize("secret", "", peer))

    def test_remote_peer_without_a_configured_token_is_refused(self):
        reason = api_auth.authorize("", "", "192.168.1.30")
        self.assertIsNotNone(reason)
        self.assertIn("no API token", reason)

    def test_remote_peer_needs_the_matching_token(self):
        self.assertIsNone(api_auth.authorize("secret", "secret", "192.168.1.30"))
        for provided in ("", "wrong", "secre", "secret "):
            with self.subTest(provided=provided):
                self.assertIsNotNone(api_auth.authorize("secret", provided, "192.168.1.30"))

    def test_unknown_peer_address_is_not_treated_as_loopback(self):
        for peer in (None, "", "not-an-address", "fe80::1"):
            with self.subTest(peer=peer):
                self.assertFalse(api_auth.is_loopback(peer))
                self.assertIsNotNone(api_auth.authorize("secret", "", peer))


class HeaderTest(unittest.TestCase):
    """Header parsing, including the shapes a caller actually sends."""

    def test_bearer_header_is_read_case_insensitively(self):
        # aiohttp hands handlers a CIMultiDict, which is what makes the header
        # lookup case-insensitive.
        self.assertEqual("abc", api_auth.bearer_of(CIMultiDict({"Authorization": "Bearer abc"})))
        self.assertEqual("abc", api_auth.bearer_of(CIMultiDict({"authorization": "bearer abc"})))
        self.assertEqual("abc", api_auth.bearer_of(CIMultiDict({"AUTHORIZATION": "  Bearer   abc  "})))

    def test_other_shapes_yield_no_token(self):
        for headers in (
            None,
            {},
            {"Authorization": ""},
            {"Authorization": "Basic abc"},
            {"Authorization": "Bearer"},
            {"Authorization": "abc"},
        ):
            with self.subTest(headers=headers):
                self.assertEqual("", api_auth.bearer_of(headers))


class TokenSourceTest(unittest.TestCase):
    """The environment wins; the rendered config is the manual-run fallback."""

    def setUp(self):
        self._saved = dict(__import__("os").environ)

    def tearDown(self):
        import os

        os.environ.clear()
        os.environ.update(self._saved)

    def test_env_var_wins_over_config(self):
        import os

        os.environ[api_auth.TOKEN_ENV_VAR] = " from-env "
        fake = mock.Mock()
        fake.get_app_config.return_value = {"token": "from-config"}
        with mock.patch("core.utils.config.ConfigManager.instance", return_value=fake):
            self.assertEqual("from-env", api_auth.configured_token())
            fake.get_app_config.assert_not_called()

    def test_config_is_used_when_the_env_is_empty(self):
        import os

        os.environ.pop(api_auth.TOKEN_ENV_VAR, None)
        fake = mock.Mock()
        fake.get_app_config.return_value = {"token": " from-config "}
        with mock.patch("core.utils.config.ConfigManager.instance", return_value=fake):
            self.assertEqual("from-config", api_auth.configured_token())

    def test_missing_config_reads_as_unconfigured(self):
        import os

        os.environ.pop(api_auth.TOKEN_ENV_VAR, None)
        fake = mock.Mock()
        fake.get_app_config.side_effect = RuntimeError("config not loaded")
        with mock.patch("core.utils.config.ConfigManager.instance", return_value=fake):
            self.assertEqual("", api_auth.configured_token())


class MiddlewareTest(unittest.TestCase):
    """The middleware as aiohttp runs it, over a real socket."""

    def _echo_app(self):
        async def echo(request):
            return web.json_response({"success": True, "was": "handler"})

        return web.Application(middlewares=[api_auth.bearer_auth])

    def test_loopback_request_without_a_token_reaches_the_handler(self):
        async def scenario():
            app = self._echo_app()
            app.router.add_get("/api/health", _echo)
            async with TestServer(app) as server:
                async with TestClient(server) as client:
                    response = await client.get("/api/health")
                    self.assertEqual(200, response.status)
                    self.assertEqual("handler", (await response.json())["was"])

        asyncio.run(scenario())

    def test_remote_request_is_gated_by_the_token(self):
        async def scenario():
            app = self._echo_app()
            app.router.add_get("/api/health", _echo)
            app.router.add_post("/api/play/text", _echo)
            async with TestServer(app) as server:
                async with TestClient(server) as client:
                    # Pretend the socket came from another machine: the peer check
                    # is the only thing that can be simulated over a loopback bind.
                    with mock.patch.object(api_auth, "is_loopback", return_value=False):
                        with mock.patch.object(api_auth, "configured_token", return_value="secret"):
                            for method, path in (("get", "/api/health"), ("post", "/api/play/text")):
                                with self.subTest(path=path):
                                    call = getattr(client, method)
                                    denied = await call(path)
                                    self.assertEqual(401, denied.status)
                                    self.assertEqual("unauthorized", (await denied.json())["error"])
                                    allowed = await call(path, headers={"Authorization": "Bearer secret"})
                                    self.assertEqual(200, allowed.status)

                        # No token configured and a remote peer: closed, not open.
                        with mock.patch.object(api_auth, "configured_token", return_value=""):
                            denied = await client.get("/api/health")
                            self.assertEqual(401, denied.status)

        asyncio.run(scenario())

    def test_the_real_api_server_covers_every_route(self):
        """A route added later must not slip out from behind the gate."""
        module = importlib.import_module("core.services.api_server")
        server = module.APIServer(host="127.0.0.1", port=0)
        self.assertIn(api_auth.bearer_auth, server.app.middlewares)
        paths = {route.resource.canonical for route in server.app.router.routes()}
        self.assertEqual(
            {
                "/api/play/text",
                "/api/play/url",
                "/api/play/file",
                "/api/status",
                "/api/wakeup",
                "/api/interrupt",
                "/api/health",
                "/api/tts/doubao",
                "/api/tts/doubao_voices",
            },
            paths,
        )


async def _echo(request):
    return web.json_response({"success": True, "was": "handler"})


if __name__ == "__main__":
    unittest.main()
