"""Machine readiness and at-most-once fallback; no transport or device I/O."""
import asyncio
import importlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


class DshTransportTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sys.modules.setdefault('dsh_xiaoai_server', types.SimpleNamespace())
        self.dsh = importlib.import_module('core.dsh')
        self.manager = self.dsh.DshManager
        for name, value in {'_initialized': True, '_enabled': True, '_connected': False,
                            'last_error': None, '_api_key': 'fixture',
                            '_base_url': 'http://fixture.invalid/plugin/xiaoai',
                            '_fallback_text': '电脑未收到', '_tts_provider': 'doubao'}.items():
            self.enterContext(patch.object(self.manager, name, value))
        self.session = self.enterContext(patch.object(self.dsh.aiohttp, 'ClientSession')).return_value.__aenter__.return_value
        self.session.get = MagicMock()
        self.session.post = MagicMock()
        self.play = self.enterContext(patch('core.services.tts.router.TTSRouter.play', new_callable=AsyncMock))

    def reply(self, method, status, payload):
        response = MagicMock(status=status)
        response.json = AsyncMock(return_value=payload)
        method.return_value.__aenter__.return_value = response

    async def test_ready_then_refused(self):
        for status, body, ready in [(200, {'ok': True}, True), (401, {}, False), (200, {'ok': 'yes'}, False)]:
            self.reply(self.session.get, status, body)
            await self.manager.connect()
            self.assertIs(self.manager._connected, ready)
        self.session.get.assert_called_with('http://fixture.invalid/plugin/xiaoai/ready', headers=self.manager._headers(), allow_redirects=False)
        self.play.assert_not_awaited()

    async def test_submit_to_router_count(self):
        for status, body, count in [(200, {'ok': True}, 0), (503, {'ok': False}, 0),
                                    (401, {'ok': False}, 1), (503, {'delivered': False}, 1)]:
            self.play.reset_mock()
            self.reply(self.session.post, status, body)
            await self.manager.send('hello', wait_response=True)
            self.assertEqual(count, self.play.await_count)
            if count:
                self.assertEqual(('电脑未收到',), self.play.await_args.args)
                self.assertEqual('doubao', self.play.await_args.kwargs['configured_provider'])

    async def test_unknown_timeout_is_silent(self):
        self.session.post.side_effect = asyncio.TimeoutError()
        await self.manager.send('hello', wait_response=True)
        self.play.assert_not_awaited()

    async def test_disabled_does_not_submit_or_retry(self):
        self.manager._enabled = False
        self.manager._fallback_text = ''
        self.play.side_effect = RuntimeError('provider unavailable')
        self.assertIsNone(await self.manager.send('hello'))
        self.session.post.assert_not_called()
        self.play.assert_awaited_once()
        self.assertEqual((self.dsh.FALLBACK_SPEECH,), self.play.await_args.args)
