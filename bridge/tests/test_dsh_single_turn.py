"""Single-shot mode: one wake word, one sentence.

The DSH side of the bridge is submit-only — the utterance goes to the plugin
and the reply comes back later through the API Server — so staying in the
listen loop after delivering a turn buys nothing and costs a live microphone
during the answer. `keeps_listening()` is what ends the session instead, and
these tests pin both halves: the switch itself, and the loop honouring it.
"""

import asyncio
import importlib
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class _FakeConfig:
    """Stands in for ConfigManager: only `get_app_config("dsh.…")` is used."""

    def __init__(self, dsh: dict | None = None):
        self.app = {"dsh": dsh or {}}

    def get_app_config(self, path=None, default=None):
        if not path:
            return self.app
        value = self.app
        for key in path.split("."):
            if not isinstance(value, dict):
                return default
            value = value.get(key, default)
        return value


class _LoopProbe:
    """Records what the shared conversation loop actually did."""

    def __init__(self):
        self.turns = 0
        self.after_wakeup = 0
        self.stopped_recording = 0

    async def _stop_recording(self):
        self.stopped_recording += 1

    async def _start_recording(self):
        pass

    async def _play_notify(self):
        pass

    async def _call_after_wakeup(self):
        self.after_wakeup += 1


class KeepsListeningFlagTest(unittest.TestCase):
    """The switch the settings page owns, with the template's own default."""

    def setUp(self):
        sys.modules.setdefault("open_xiaoai_server", types.SimpleNamespace())
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        self.module = importlib.import_module("core.dsh_conversation")
        self.template = importlib.import_module("config")

    def _controller(self, dsh: dict):
        # __new__ skips ConfigManager's device probing; the controller under
        # test only ever reads `dsh.continuous_conversation`.
        controller = self.module.DshConversationController.__new__(
            self.module.DshConversationController
        )
        controller.config = _FakeConfig(dsh)
        return controller

    def test_the_bridge_template_ships_single_shot(self):
        """A manual run without the plugin gets the documented default too."""
        self.assertIs(self.template.APP_CONFIG["dsh"]["continuous_conversation"], False)

    def test_single_shot_by_default(self):
        self.assertIs(self._controller({}).keeps_listening(), False)

    def test_enabling_the_switch_keeps_listening(self):
        self.assertIs(
            self._controller({"continuous_conversation": True}).keeps_listening(),
            True,
        )

    def test_a_non_boolean_still_decides(self):
        """Hand-edited config should not turn a truthy value into silence."""
        self.assertIs(
            self._controller({"continuous_conversation": "yes"}).keeps_listening(),
            True,
        )


class ConversationLoopTest(unittest.TestCase):
    """The shared loop, driven with the probe above instead of audio."""

    def setUp(self):
        sys.modules.setdefault("open_xiaoai_server", types.SimpleNamespace())
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        self.base = importlib.import_module("core.external_conversation")
        self.dsh_module = importlib.import_module("core.dsh_conversation")

    def _run(self, controller, results):
        """Run the real loop, feeding it a scripted list of turn results."""
        queue = list(results)

        async def one_turn():
            controller.turns += 1
            return queue.pop(0) if queue else "exit"

        controller._run_one_turn_with_local_asr = one_turn
        controller.uses_xiaoai_asr = lambda: False
        controller.active = True
        asyncio.run(controller._conversation_loop())

    def test_single_shot_leaves_after_one_turn(self):
        controller = self.dsh_module.DshConversationController.__new__(
            self.dsh_module.DshConversationController
        )
        probe = _LoopProbe()
        for name in ("_stop_recording", "_start_recording", "_play_notify", "_call_after_wakeup"):
            setattr(controller, name, getattr(probe, name))
        controller.turns = 0
        controller.after_wakeup = 0
        controller.config = _FakeConfig({})
        self._run(controller, ["continue", "continue", "continue"])
        self.assertEqual(1, controller.turns)
        self.assertEqual(0, controller.after_wakeup, "no goodbye after a single sentence")
        self.assertEqual(1, probe.stopped_recording)

    def test_continuous_mode_keeps_talking(self):
        controller = self.dsh_module.DshConversationController.__new__(
            self.dsh_module.DshConversationController
        )
        probe = _LoopProbe()
        for name in ("_stop_recording", "_start_recording", "_play_notify", "_call_after_wakeup"):
            setattr(controller, name, getattr(probe, name))
        controller.turns = 0
        controller.after_wakeup = 0
        controller.config = _FakeConfig({"continuous_conversation": True})
        self._run(controller, ["continue", "continue", "exit"])
        self.assertEqual(3, controller.turns)
        self.assertEqual(1, probe.after_wakeup, "a real exit still says goodbye")

    def test_the_base_class_still_listens_on(self):
        """The OpenAI controller shares this loop; only DSH narrows the hook."""
        plain = self.base.ExternalConversationController.__new__(
            self.base.ExternalConversationController
        )
        self.assertIs(plain.keeps_listening(), True)


if __name__ == "__main__":
    unittest.main()
