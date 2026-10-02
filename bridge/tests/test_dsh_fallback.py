"""Layer 2 of the fallback design: the bridge speaks when the plugin is gone.

`_submit_utterance` is fire-and-forget, so a failed POST is only ever noticed
there; the controller above it has already returned "continue". These tests pin
that the failure is announced out loud, that the wording comes from the rendered
config, and that a failure to speak never escapes.
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class _FakeSpeaker:
    def __init__(self, fail: bool = False):
        self.spoken: list[str] = []
        self._fail = fail

    async def play(self, text: str, **_kwargs):
        if self._fail:
            raise RuntimeError("speaker exploded")
        self.spoken.append(text)


class FallbackSpeechTest(unittest.TestCase):
    def setUp(self):
        sys.modules.setdefault("open_xiaoai_server", types.SimpleNamespace())
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        sys.modules.pop("core.dsh", None)
        self.dsh = importlib.import_module("core.dsh")
        self.ref = importlib.import_module("core.ref")
        self.manager = self.dsh.DshManager

    def tearDown(self):
        self.ref.GLOBAL_STATES.pop("speaker", None)

    def test_configured_wording_is_spoken(self):
        """The settings page owns the sentence that gets said here."""
        speaker = _FakeSpeaker()
        self.ref.set_speaker(speaker)
        self.manager._fallback_text = "电脑睡着了"
        asyncio.run(self.manager._play_fallback())
        self.assertEqual(["电脑睡着了"], speaker.spoken)

    def test_empty_setting_falls_back_to_the_builtin_line(self):
        """A manual run without a rendered config still says something."""
        speaker = _FakeSpeaker()
        self.ref.set_speaker(speaker)
        self.manager._fallback_text = ""
        asyncio.run(self.manager._play_fallback())
        self.assertEqual([self.dsh.FALLBACK_SPEECH], speaker.spoken)

    def test_missing_speaker_is_not_an_error(self):
        """Before the audio stack is up there is nothing to play through."""
        asyncio.run(self.manager._play_fallback())

    def test_speaker_failure_is_contained(self):
        """A broken speaker must not turn into an unhandled task exception."""
        self.ref.set_speaker(_FakeSpeaker(fail=True))
        self.manager._fallback_text = "在吗"
        asyncio.run(self.manager._play_fallback())


if __name__ == "__main__":
    unittest.main()
