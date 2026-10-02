"""DSH continuous conversation controller.

Thin subclass of `ExternalConversationController` that swaps the backend for
`DshManager` and replaces the request/response turn with a submit-only turn.

Why submit-only: the DSH side speaks asynchronously. The bridge POSTs the
utterance, the plugin injects it into the DSH agent session, and the reply is
spoken later by the plugin's `xiaoai_speak` tool calling this bridge's API
Server. So a turn never blocks on a response and the bridge never speaks a
reply itself — that bookkeeping lives in the plugin, which is the only party
that knows whether the model already spoke this turn.
"""

import asyncio

from core.dsh import DshManager
from core.external_conversation import ExternalConversationController
from core.ref import get_speaker, get_vad
from core.utils.logger import logger


class DshConversationController(ExternalConversationController):
    """Manages multi-turn conversation for the DSH bridge plugin."""

    CONFIG_PREFIX = "dsh"
    BACKEND_NAME = "DSH"
    LOG_MODULE = "DSH Conv"
    WAKEUP_SOURCE = "dsh"
    MANAGER = DshManager

    async def _run_one_turn_with_local_asr(self) -> str:
        """Submit one utterance to DSH without waiting for a reply.

        Returns:
            "continue" - utterance delivered, loop to next
            "exit"     - user said an exit keyword
            "timeout"  - no speech detected within timeout
            "error"    - unrecoverable error
        """
        vad = get_vad()
        if not vad:
            logger.error("VAD not available", module=self.LOG_MODULE)
            return "error"

        speech_bytes = await self._wait_for_speech(vad)
        if speech_bytes is None:
            return "timeout"

        logger.debug(
            f"Got speech buffer: {len(speech_bytes)} bytes",
            module=self.LOG_MODULE,
        )

        from core.services.audio.asr import ASRService

        text = ASRService.asr(speech_bytes, sample_rate=16000)
        if not text:
            logger.debug("ASR empty, retrying", module=self.LOG_MODULE)
            return "continue"

        for kw in self.exit_keywords:
            if kw in text:
                logger.info(f"Exit keyword: {kw}", module=self.LOG_MODULE)
                return "exit"

        # The voice channel needs the skill variant: it is the text that tells
        # the model the user cannot read its reply, which is what pushes it to
        # speak through the plugin's `xiaoai_speak` tool. The plain rule prompt
        # only talks about formatting, so fall back to it only when the voice
        # one is empty.
        rule = (
            getattr(self.backend, "_rule_prompt_for_skill", "")
            or self.backend._rule_prompt
        )
        full_text = text if not rule else text + "\n" + rule

        run_id = await self.backend.send(full_text, wait_response=False)
        if run_id is None:
            logger.warning("Failed to deliver utterance to DSH", module=self.LOG_MODULE)
            speaker = get_speaker()
            if speaker:
                # Layer 2 of the fallback design: the bridge is alive but the
                # plugin is gone, so say so out loud instead of going silent.
                # The wording comes from the settings page.
                from core.dsh import FALLBACK_SPEECH

                await speaker.play(
                    text=getattr(self.backend, "_fallback_text", "") or FALLBACK_SPEECH
                )
            return "continue"

        # Brief pause so the "sent" cue does not run into the next VAD window.
        await self._play_send_sound()
        await asyncio.sleep(0)
        return "continue"
