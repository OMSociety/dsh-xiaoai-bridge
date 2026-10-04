"""
HTTP API Server for the bridge
Provides endpoints to play text/audio remotely
"""

import asyncio
import json
import os
import tempfile
import threading
import weakref

import dsh_xiaoai_server
from aiohttp import web
from core.ref import get_speaker, get_xiaoai
from core.services.api_auth import auth_mode, bearer_auth
from core.services.tts.doubao import DoubaoTTS
from core.utils.background import spawn_background
from core.utils.config import ConfigManager
from core.utils.logger import logger
from core.utils.playback_gate import PlaybackGate, estimate_speech_seconds


# ---- 播报串行化 ----
# 插件侧每个会话各自独立（lib/auto-speak.js），定时提醒与对话回复会同时打
# `/api/play/text`；两路 ubus TTS 撞在一起就是叠音。桥接器是唯一能兜住的地方：
# 同一时刻只允许一路真正出声，其余在锁上排队。队列有界，满了立刻回明确的
# 503（调用方拿到 ok:false 会记一条警告），不无限堆积。
#
# 只有 `/api/play/text`（含它的 `blocking` 模式）走这条队列，这是**有意**的：
# `/api/play/url` 与 `/api/play/file` 是上游遗留端点（插件侧零调用，见各自
# docstring），`/api/tts/doubao` 是处理器内联合成并播放、`lib/**` 也零调用。
# 把它们塞进同一条队列会改掉这些端点既有的 HTTP 时序（立刻返回 / 立刻 503），
# 而它们没有任何已知调用方；混用它们与 `/api/play/text` 的调用方自己承担叠音
# 风险。三者都仍然受 `PlaybackGate` 保护，自问自答不会发生。
MAX_PENDING_PLAYS = 8
_pending_plays = 0
# asyncio.Lock 首次 await 后会绑定当时的事件循环，跨循环复用会抛
# "bound to a different event loop"，所以按 loop 各持一把（测试会换 loop）。
_play_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)
_play_locks_guard = threading.Lock()


def _playback_lock() -> asyncio.Lock:
    """取当前事件循环的播报锁。"""
    loop = asyncio.get_running_loop()
    with _play_locks_guard:
        lock = _play_locks.get(loop)
        if lock is None:
            lock = asyncio.Lock()
            _play_locks[loop] = lock
        return lock


def _reserve_play_slot() -> bool:
    """占一个队列名额；队列满时返回 False，调用方据此立刻回失败。"""
    global _pending_plays
    if _pending_plays >= MAX_PENDING_PLAYS:
        return False
    _pending_plays += 1
    return True


def _release_play_slot() -> None:
    """归还队列名额。"""
    global _pending_plays
    if _pending_plays > 0:
        _pending_plays -= 1


async def _play_text_serially(speaker, text: str, timeout: int) -> None:
    """排队后真正出声，直到设备放完才让出锁。

    `speaker.play(blocking=False)` 只是把文本交给设备就返回，声音还在后面放；
    锁必须等到闸门重新打开（设备上报播完，或闸门的兜底到期）才算这一路结束，
    否则第二路的命令会叠在第一路的声音上。`timeout` 兼作等待上限。
    """
    try:
        async with _playback_lock():
            await speaker.play(text=text, blocking=False, timeout=timeout)
            await PlaybackGate.wait_until_open(timeout=max(timeout, 0) / 1000)
    except Exception as exc:
        logger.error(f"[APIServer] Background text playback failed: {exc}")
    # 名额不在这里归还：见 _finalize_play_task（协程可能还没跑第一步就被取消）。


# 在飞 / 还在锁上排队的播报任务。打断（POST /api/interrupt 与原生唤醒打断）
# 要能把它们一次全取消，否则早先排好队的话会在闸门放行后接着念。
_play_tasks: "set[asyncio.Task]" = set()


def _finalize_play_task(task: asyncio.Task) -> None:
    """播报任务收尾：归还队列名额并摘掉登记。

    归还放在 done 回调而不是协程的 `finally` 里：打断会对在飞任务调
    `Task.cancel()`，如果这一刻协程还没跑第一步，协程体（连同 `finally`）根本
    不会执行，名额就永久漏掉一个 —— 攒够 `MAX_PENDING_PLAYS` 之后所有播报都
    被判成"队列满"回 503。done 回调对取消 / 异常 / 正常结束三种结局都只跑一次。
    """
    _release_play_slot()
    _play_tasks.discard(task)


def _spawn_play_task(speaker, text: str, timeout: int) -> asyncio.Task:
    """起一条串行播报任务，并登记进 `_play_tasks` 以便被打断取消。"""
    task = spawn_background(
        _play_text_serially(speaker, text, timeout),
        name="api-play-text",
    )
    _play_tasks.add(task)
    task.add_done_callback(_finalize_play_task)
    return task


def cancel_pending_plays() -> int:
    """取消所有在飞 / 排队的播报任务，返回取消掉的条数。

    打断必须**穿透播报队列**：只停设备上正在放的那一路，早先排队的话会在闸门
    放行后接着念 —— 用户听到的是"喊停了还在说"。名额不需要在这里动：每条任务
    的收尾回调（`_finalize_play_task`）都会归还一次，包括"还没跑第一步就被取消"
    那种。

    必须在**持有这些任务的事件循环**里调用（`Task.cancel()` 不是线程安全的），
    跨线程的调用方用 `loop.call_soon_threadsafe(cancel_pending_plays)`。
    闸门**不**在这里重置：调用方要先停掉设备音频、再 `PlaybackGate.reset()`，
    反过来的话麦克风会在音箱还在响的时候恢复收音（自问自答）。
    """
    cancelled = 0
    for task in list(_play_tasks):
        if not task.done():
            task.cancel()
            cancelled += 1
    return cancelled


class APIServer:
    """HTTP API Server to control the speaker remotely"""

    def __init__(self, host: str = "0.0.0.0", port: int = 8080):
        self.host = host
        self.port = port
        self.config = ConfigManager.instance()
        # Every route sits behind the bearer gate (see core/services/api_auth.py):
        # upstream shipped all nine endpoints open, which is only acceptable while
        # the listener is loopback.
        self.app = web.Application(middlewares=[bearer_auth])
        self.runner = None
        self.site = None
        self._setup_routes()

    def _setup_routes(self):
        """Setup API routes"""
        self.app.router.add_post("/api/play/text", self.handle_play_text)
        # `/api/play/url` 是上游遗留端点：本插件侧零调用方（插件只走
        # /api/play/text）。保留接口不动，详见 handle_play_url 的说明。
        self.app.router.add_post("/api/play/url", self.handle_play_url)
        self.app.router.add_post("/api/play/file", self.handle_play_file)
        self.app.router.add_get("/api/status", self.handle_get_status)
        self.app.router.add_post("/api/wakeup", self.handle_wakeup)
        self.app.router.add_post("/api/interrupt", self.handle_stop)
        self.app.router.add_get("/api/health", self.handle_health)
        # TTS endpoints
        self.app.router.add_post("/api/tts/doubao", self.handle_tts_doubao)
        self.app.router.add_get("/api/tts/doubao_voices", self.handle_tts_voices)

    async def start(self):
        """Start the HTTP server"""
        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, self.host, self.port)
        await self.site.start()
        mode = auth_mode()
        logger.info(
            f"[APIServer] HTTP server started at http://{self.host}:{self.port} (auth: {mode})"
        )
        if mode != "bearer" and self.host not in ("127.0.0.1", "::1", "localhost"):
            logger.warning(
                "[APIServer] listening on "
                f"{self.host} without an API token: only loopback callers will be served here"
            )

    async def stop(self):
        """Stop the HTTP server"""
        if self.runner:
            await self.runner.cleanup()
            logger.info("[APIServer] HTTP server stopped")

    # ============ Handlers ============

    async def handle_play_text(self, request: web.Request) -> web.Response:
        """
        POST /api/play/text
        Play text via TTS

        Request body:
            {
                "text": "你好",           # required
                "blocking": false,        # optional, default false
                "timeout": 60000          # optional, timeout in ms
            }

        播报是**桥接器侧串行**的：同一时刻只有一路真正出声，其余排队。非阻塞
        请求在入队后立刻返回（响应里 `queued`/`serialized` 说明这一点），真正
        的 TTS 在后台任务里持锁完成；队列满则回 503 + `queued: false`。

        `blocking=true` 是有意保留的另一条通道，不是漏掉队列的旁路：它占住
        同一个串行名额、持同一把锁等 `tts_play.sh` 整个跑完（最长 `timeout`，
        默认 600 秒），期间后面的话只能排队 —— 这正是"同步播报"的语义，等待
        上限（`timeout`）就是它自己的保护。插件侧恒发 `blocking:false`
        （lib/bridge.js），所以这条路径只服务于手动调用。
        """
        try:
            data = await request.json()
            text = data.get("text")

            if not text:
                return web.json_response(
                    {"success": False, "error": "Missing required field: text"},
                    status=400
                )

            blocking = data.get("blocking", False)
            timeout = data.get("timeout", 10 * 60 * 1000)

            speaker = get_speaker()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            # Run in background to not block the response
            if blocking:
                if not _reserve_play_slot():
                    return web.json_response(
                        {
                            "success": False,
                            "error": "Playback queue is full",
                            "queued": False,
                        },
                        status=503,
                    )
                try:
                    async with _playback_lock():
                        result = await speaker.play(text=text, blocking=True, timeout=timeout)
                finally:
                    _release_play_slot()
                return web.json_response({"success": result})
            else:
                if not _reserve_play_slot():
                    return web.json_response(
                        {
                            "success": False,
                            "error": "Playback queue is full",
                            "queued": False,
                        },
                        status=503,
                    )
                # 持强引用的后台任务：这条协程可能被 GC 回收（见 utils/background.py），
                # 而且要串行到设备真的放完才让出锁。任务同时被登记，供打断取消。
                try:
                    _spawn_play_task(speaker, text, timeout)
                except Exception as exc:  # noqa: BLE001 - 名额必须归还
                    # 建任务失败时名额没有 done 回调去归还，留着它就等于把这个
                    # 进程的队列永久占满（之后每次播放都是 503）。
                    _release_play_slot()
                    logger.error(f"[API] 创建后台播报任务失败: {exc}")
                    return web.json_response(
                        {
                            "success": False,
                            "error": "Could not queue playback",
                            "queued": False,
                        },
                        status=503,
                    )
                return web.json_response({
                    "success": True,
                    "message": "Playing text in background",
                    "queued": True,
                    "serialized": True,
                })

        except json.JSONDecodeError:
            return web.json_response(
                {"success": False, "error": "Invalid JSON"},
                status=400
            )
        except Exception as e:
            logger.error(f"[APIServer] Error playing text: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_play_url(self, request: web.Request) -> web.Response:
        """
        POST /api/play/url
        Play audio from URL

        上游遗留端点：本插件的任何调用方都不用它（插件只走 `/api/play/text`，
        `lib/**` 里 grep `playUrl` 零命中），保留是为了不破坏上游 API 兼容。
        它对应的 `speaker.play(url=..., blocking=False)` 已不再按文本估时长关
        闸门，而是等设备上报的播放结束事件（见 utils/playback_gate.py）。
        它**有意**不走 `/api/play/text` 的串行队列（理由见模块顶部「播报串行化」
        注释）：本插件无调用方，入队只会改掉"命令发出即返回"的既有时序。

        Request body:
            {
                "url": "http://example.com/audio.mp3",  # required
                "blocking": false,                       # optional, default false
                "timeout": 60000                         # optional, timeout in ms
            }
        """
        try:
            data = await request.json()
            url = data.get("url")

            if not url:
                return web.json_response(
                    {"success": False, "error": "Missing required field: url"},
                    status=400
                )

            blocking = data.get("blocking", False)
            timeout = data.get("timeout", 10 * 60 * 1000)

            speaker = get_speaker()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            if blocking:
                result = await speaker.play(url=url, blocking=True, timeout=timeout)
                return web.json_response({"success": result})
            else:
                spawn_background(
                    speaker.play(url=url, blocking=False, timeout=timeout),
                    name="api-play-url",
                )
                return web.json_response({"success": True, "message": "Playing URL in background"})

        except json.JSONDecodeError:
            return web.json_response(
                {"success": False, "error": "Invalid JSON"},
                status=400
            )
        except Exception as e:
            logger.error(f"[APIServer] Error playing URL: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_play_file(self, request: web.Request) -> web.Response:
        """
        POST /api/play/file
        Upload and play audio file directly via audio buffer

        Request: multipart/form-data
            - file: audio file (required, mp3/wav/opus etc.)

        Query params:
            - blocking: true/false (optional, default false)
            - sample_rate: target sample rate in Hz (optional, default 24000, can be 48000, 44100, etc.)

        它**有意**不走 `/api/play/text` 的串行队列（理由见模块顶部「播报串行化」
        注释）：插件侧零调用，且 `blocking:false` 的既有语义是"立刻回 200、
        上传的文件在后台放"，入队会把它变成可能回 503 的排队请求。

        Response:
            {
                "success": true,
                "message": "File played"
            }
        """
        try:
            # Parse query params
            blocking = request.query.get("blocking", "false").lower() == "true"
            sample_rate = int(request.query.get("sample_rate", "24000"))

            reader = await request.multipart()

            # Get the file field
            field = await reader.next()
            if not field or field.name != "file":
                return web.json_response(
                    {"success": False, "error": "Missing required field: file"},
                    status=400
                )

            # Check filename
            filename = field.filename
            if not filename:
                return web.json_response(
                    {"success": False, "error": "No filename provided"},
                    status=400
                )

            speaker = get_speaker()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            suffix = os.path.splitext(filename)[1] or ".mp3"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
                total_size = 0
                while True:
                    chunk = await field.read_chunk(size=8192)
                    if not chunk:
                        break
                    temp_file.write(chunk)
                    total_size += len(chunk)
                temp_path = temp_file.name

            logger.info(f"[APIServer] Received file: {filename}, size: {total_size} bytes, blocking={blocking}, sample_rate={sample_rate}")
            logger.info(f"[APIServer] Saved upload to temp file: {temp_path}")

            async def play_audio():
                try:
                    success = await speaker.play_server_file(
                        temp_path,
                        blocking=True,
                        sample_rate=sample_rate,
                    )
                    if success:
                        logger.info(f"[APIServer] Finished playing: {filename}")
                    else:
                        logger.error(f"[APIServer] Error playing file: {filename}")
                    return success
                finally:
                    if os.path.exists(temp_path):
                        os.unlink(temp_path)

            if blocking:
                # Wait for playback to complete
                success = await play_audio()
                return web.json_response({
                    "success": success,
                    "message": f"Finished playing: {filename}",
                    "filename": filename,
                    "size": total_size,
                    "sample_rate": sample_rate
                })
            else:
                # Run in background
                spawn_background(play_audio(), name=f"api-play-file-{filename}")
                return web.json_response({
                    "success": True,
                    "message": f"Playing file: {filename}",
                    "filename": filename,
                    "size": total_size,
                    "sample_rate": sample_rate
                })

        except Exception as e:
            logger.error(f"[APIServer] Error handling file upload: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_get_status(self, request: web.Request) -> web.Response:
        """
        GET /api/status
        Get current speaker status
        """
        try:
            speaker = get_speaker()

            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            status = await speaker.get_playing()

            return web.json_response({
                "success": True,
                "data": {
                    "status": status  # "playing", "paused", "idle"
                }
            })

        except Exception as e:
            logger.error(f"[APIServer] Error getting status: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_wakeup(self, request: web.Request) -> web.Response:
        """
        POST /api/wakeup
        Wake up the speaker

        Request body:
            {
                "silent": false   # optional, default false (audible wakeup)
            }
        """
        try:
            data = await request.json() if request.can_read_body else {}
            silent = data.get("silent", False)

            speaker = get_speaker()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            result = await speaker.wake_up(awake=True, silent=silent)
            return web.json_response({"success": result})

        except Exception as e:
            logger.error(f"[APIServer] Error waking up: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_stop(self, request: web.Request) -> web.Response:
        """
        POST /api/interrupt
        Interrupt current playback

        打断必须**穿透播报队列**：`/api/play/text` 的串行队列里可能还压着几路
        待播文本（多段回复、定时提醒与会话回复撞车）。只调 `stop_device_audio()`
        停掉正在放的那一路，排队的话会在闸门放行后接着念 —— 用户听到的是
        "喊停了还在说"。所以按顺序做三件事：

        1. 取消在飞 / 排队的播报任务（`cancel_pending_plays`）；
        2. 停掉设备上的当前音频、结束连续对话；
        3. `PlaybackGate.reset()` 重置半双工闸门。

        第 3 步不能省：被打断那一路留下的设备占用（`hold_until_device_stops`）
        否则会把麦克风通路继续关着，用户下一句进不来。顺序也不能换 —— 先开闸
        会让麦克风在音箱还在响的时候恢复收音。
        """
        try:
            speaker = get_speaker()
            xiaoai = get_xiaoai()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            cancelled = cancel_pending_plays()
            logger.info(
                f"[APIServer] Interrupt: cancelled {cancelled} pending playback(s)"
            )
            await speaker.stop_device_audio()
            # 停止连续对话
            if xiaoai:
                xiaoai.stop_conversation()
            # 设备已经停了才开闸（理由见 docstring）。
            PlaybackGate.reset()

            return web.json_response({"success": True})

        except Exception as e:
            logger.error(f"[APIServer] Error interrupting: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_health(self, request: web.Request) -> web.Response:
        """
        GET /api/health
        Health check endpoint
        """
        data = {
            "status": "healthy",
            "speaker_ready": get_speaker() is not None,
            # "bearer" = non-loopback callers need the token;
            # "loopback-only" = no token is configured, so only this machine
            # is served (see core/services/api_auth.py).
            "auth": auth_mode(),
        }
        # 语音识别后端是配置里最容易"选了却没生效"的一项（切到没装模型的后端、
        # 或者模型名写错），所以把实况一起报出去，设置页据此提示用户。
        # 延迟 import：健康检查不该被 ASR 的依赖拖垮。
        try:
            from core.services.audio.asr.service import ASRService

            data["asr"] = ASRService.status()
        except Exception as exc:  # noqa: BLE001 - 健康检查必须能答话
            data["asr"] = {"requested": None, "active": None, "error": str(exc)}
        return web.json_response({"success": True, "data": data})

    async def handle_tts_doubao(self, request: web.Request) -> web.Response:
        """
        POST /api/tts/doubao
        Synthesize text using Doubao (ByteDance Volcano) TTS and play it

        它**有意**不走 `/api/play/text` 的串行队列（理由见模块顶部「播报串行化」
        注释）：插件侧零调用，合成与播放都在本处理器内联完成，并自带
        `PlaybackGate` 占用；但 `blocking:false` 的响应是"整段放完之后"才回的，
        入队只会让等待变得更长。

        Request body:
            {
                "text": "你好",                    # required
                "app_id": "your_app_id",           # optional (uses config if not provided)
                "access_key": "your_access_key",   # optional (uses config if not provided)
                "resource_id": "your_resource_id", # optional (auto-detected based on speaker_id)
                "speaker_id": "zh_female_cancan_mars_bigtts",  # optional, default voice
                "speed": 1.0,                       # optional, 0.8-2.0
                "blocking": true,                   # optional, default false
                "emotion": "happy",                 # optional, emotion for multi-emotion speakers
                "context_texts": [                   # optional, only for 2.0 speakers (only first value effective)
                    "你可以说慢一点吗？",
                    "你可以用特别痛心的语气说话吗？",
                    "你能用骄傲的语气来说话吗？"
                ]
            }
        """
        speaker_id = "<unknown>"
        resource_id_for_log = "<unknown>"
        resolved_format = "<unknown>"
        blocking = False
        use_stream = False

        try:
            data = await request.json()
            text = data.get("text")

            if not text:
                return web.json_response(
                    {"success": False, "error": "Missing required field: text"},
                    status=400
                )

            # Get credentials from request or config
            tts_config = self.config.get_app_config("tts.doubao", {})

            app_id = data.get("app_id") or tts_config.get("app_id")
            access_key = data.get("access_key") or tts_config.get("access_key")
            # resource_id is now optional - will be auto-detected based on speaker
            resource_id = data.get("resource_id") or tts_config.get("resource_id")
            resource_id_for_log = resource_id or "<auto>"

            if not all([app_id, access_key]):
                return web.json_response(
                    {"success": False, "error": "Doubao TTS credentials not configured. Provide app_id and access_key in request or config.py"},
                    status=400
                )

            speaker_id = data.get("speaker_id") or data.get("speaker") or tts_config.get("default_speaker") or "zh_female_shuangkuaisisi_moon_bigtts"
            speed = float(data.get("speed", 1.0))
            blocking = data.get("blocking", False)
            context_texts = data.get("context_texts")  # Only supported for 2.0 speakers
            emotion = data.get("emotion")  # Emotion parameter for multi-emotion speakers

            speaker = get_speaker()
            if not speaker:
                return web.json_response(
                    {"success": False, "error": "Speaker not initialized"},
                    status=503
                )

            # Create TTS instance (auto-detects resource_id if not provided)
            tts = DoubaoTTS(
                app_id=app_id,
                access_key=access_key,
                resource_id=resource_id,
                speaker=speaker_id,
            )
            resolved_format = tts.resolve_audio_format(text)
            resource_id_for_log = tts.resource_id
            logger.info(
                f"[APIServer] Doubao TTS: speaker={speaker_id}, resource_id={tts.resource_id}, format={resolved_format}"
            )

            use_stream = tts_config.get("stream", False)

            # 半双工：这条播报同样会进麦克风，闸门要跟着开合。异步播报的
            # 调用会立刻返回，所以只能按文本估时长。
            if not blocking:
                PlaybackGate.hold_for(estimate_speech_seconds(text))

            if use_stream:
                async def play_tts_stream():
                    play_fn = (
                        dsh_xiaoai_server.tts_stream_play
                        if blocking
                        else dsh_xiaoai_server.tts_stream_play_background
                    )
                    await play_fn(
                        text,
                        app_id=app_id,
                        access_key=access_key,
                        resource_id=tts.resource_id,
                        speaker=speaker_id,
                        speed=speed,
                        format=resolved_format,
                        sample_rate=24000,
                        emotion=emotion,
                        context_texts=context_texts,
                    )

                if blocking:
                    with PlaybackGate:
                        await play_tts_stream()
                else:
                    await play_tts_stream()
            else:
                async def play_tts_audio():
                    play_fn = (
                        dsh_xiaoai_server.tts_play
                        if blocking
                        else dsh_xiaoai_server.tts_play_background
                    )
                    await play_fn(
                        text,
                        app_id=app_id,
                        access_key=access_key,
                        resource_id=tts.resource_id,
                        speaker=speaker_id,
                        speed=speed,
                        format=resolved_format,
                        sample_rate=24000,
                        emotion=emotion,
                        context_texts=context_texts,
                    )
                    logger.debug("[APIServer] Finished playing TTS audio")

                if blocking:
                    try:
                        with PlaybackGate:
                            await play_tts_audio()
                    except Exception as e:
                        return web.json_response(
                            {"success": False, "error": f"TTS playback failed: {str(e)}"},
                            status=500
                        )
                else:
                    await play_tts_audio()

            if blocking:
                return web.json_response({
                    "success": True,
                    "message": f"TTS played: {text[:50]}..." if len(text) > 50 else f"TTS played: {text}",
                    "speaker_id": speaker_id,
                })

            return web.json_response(
                {
                    "success": True,
                    "message": "TTS request accepted for background playback",
                    "speaker_id": speaker_id,
                    "accepted": True,
                    "blocking": False,
                },
                status=202,
            )

        except json.JSONDecodeError:
            return web.json_response(
                {"success": False, "error": "Invalid JSON"},
                status=400
            )
        except Exception as e:
            logger.error(
                f"[APIServer] Doubao TTS failed: "
                f"speaker={speaker_id}, resource_id={resource_id_for_log}, "
                f"format={resolved_format}, blocking={blocking}, stream={use_stream}, "
                f"error={type(e).__name__}: {e}"
            )
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )

    async def handle_tts_voices(self, request: web.Request) -> web.Response:
        """
        GET /api/tts/doubao_voices
        Get available TTS voices for Doubao

        Query params:
            - version: "1.0", "2.0", or "all" (optional, default shows all)
        """
        try:
            tts_config = self.config.get_app_config("tts.doubao", {})
            resource_id = tts_config.get("resource_id", "")

            # Get version from query param or auto-detect from resource_id
            version = request.query.get("version", "all")

            if version == "2.0":
                voices = DoubaoTTS.VOICES_2_0
            elif version == "1.0":
                voices = DoubaoTTS.VOICES_1_0
            else:
                voices = DoubaoTTS.list_voices()
                # Add version info for all voices
                return web.json_response({
                    "success": True,
                    "data": {
                        "provider": "doubao",
                        "resource_id": resource_id,
                        "versions": {
                            "1.0": {
                                "count": len(DoubaoTTS.VOICES_1_0),
                                "description": "豆包语音合成模型1.0",
                                "voices": DoubaoTTS.VOICES_1_0
                            },
                            "2.0": {
                                "count": len(DoubaoTTS.VOICES_2_0),
                                "description": "豆包语音合成模型2.0 - 支持情感变化、指令遵循、ASMR",
                                "voices": DoubaoTTS.VOICES_2_0
                            }
                        },
                        "total_voices": len(voices)
                    }
                })

            return web.json_response({
                "success": True,
                "data": {
                    "provider": "doubao",
                    "version": version,
                    "resource_id": resource_id,
                    "voices": voices,
                    "count": len(voices)
                }
            })
        except Exception as e:
            logger.error(f"[APIServer] Error getting voices: {e}")
            return web.json_response(
                {"success": False, "error": str(e)},
                status=500
            )
