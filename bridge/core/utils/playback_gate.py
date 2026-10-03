"""播放闸门：音箱与麦克风之间的半双工保护。

音箱的麦克风一直在往本进程送音频，所以设备**播出来的声音也会被我们自己的
VAD 听到**。没有这层保护时桥接器会回答自己：回复被识别成新的用户语句、再
问一次、再答一次，对话无限循环。实机日志里能直接看到这一幕 —— 桥接器把自
己的开场白又听了一遍（`我说：你好，我是小爱，是小爱音箱的智能助手…`）。

闸门由三处共用，它们都需要知道「设备现在是不是在说话」：
  * VAD 在关闸期间直接丢弃音频帧，不对自己的声音跑 Silero；
  * 已经在途的 ASR 结果被丢弃，不会当成用户输入投给后端；
  * 连续对话的等待窗口在关闸期间不消耗，长回复不会把对话等到超时。

计数是引用式的：一次播放里可能嵌套多层（回复 + 提示音），任意一层释放都不
能让闸门提前打开。

异步播报的关闭时刻以**设备自己上报的播放状态**为准（`hold_until_device_stops`
等 AudioPlayer 事件），估时只作为设备不上报事件时的兜底上限；`wait_until_open`
则让需要串行化的调用方等到"真的放完了"再继续。
"""

import asyncio
import threading
import time

# 播放调用返回后音箱还会继续响一小会儿（房间混响、TTS 管线的尾巴），
# 所以闸门比播放本身多关一点点。
RELEASE_TAIL_SECONDS = 0.5

# 设备异步播报时只能按文本估时长：中文 TTS 大约每秒 4 个字。
# 故意往长了估 —— 关得久只是少听一会儿，开早了回声就又进来了。
SPEAKING_RATE_CPS = 4.0
MIN_ASYNC_HOLD_SECONDS = 1.5
MAX_ASYNC_HOLD_SECONDS = 180.0


def estimate_speech_seconds(text) -> float:
    """估算一段文本会被念多久（秒），作为异步播报的**兜底上限**。

    `ubus call mibrain text_to_speech` 在设备**收下**文本后就返回，语音还在
    后面慢慢放；正常路径下闸门由设备上报的播放结束事件打开（见
    `hold_until_device_stops`），这里的估时只在设备不上报事件时兜底，顺便
    保证文本播报的最长关闸时间不比原来更长。空文本按最短时间处理。
    """
    length = len(str(text or "").strip())
    if length <= 0:
        return MIN_ASYNC_HOLD_SECONDS
    return min(
        MAX_ASYNC_HOLD_SECONDS,
        max(MIN_ASYNC_HOLD_SECONDS, length / SPEAKING_RATE_CPS),
    )


class _PlaybackGate:
    """谁在放音，麦克风就归谁。"""

    def __init__(self, tail_seconds: float = RELEASE_TAIL_SECONDS):
        self._lock = threading.Lock()
        self._depth = 0
        self._until = 0.0
        self._device_playing = False
        self._tail = tail_seconds
        # 「等设备报放完」的持有：token -> 兜底定时器，以及已经观察到过
        # playing 的 token（只有先看到 playing，后来的非 playing 才算真放完）。
        self._device_holds: dict[object, threading.Timer] = {}
        self._started_device_holds: set[object] = set()

    def hold(self) -> None:
        """在调用方放音期间关闸（用 `with PlaybackGate:` 更省事）。"""
        with self._lock:
            self._depth += 1

    def release(self) -> None:
        """撤销一次 `hold()`。"""
        with self._lock:
            if self._depth > 0:
                self._depth -= 1
            if self._depth == 0:
                self._until = max(self._until, time.monotonic())

    def hold_for(self, seconds: float) -> None:
        """按预计时长关闸，用于「调用立刻返回、声音还在后面放」的播报。

        与 `hold()` 的区别：不需要配对释放，自己会到期。两者取最晚的那个。
        """
        if seconds <= 0:
            return
        with self._lock:
            self._until = max(self._until, time.monotonic() + float(seconds))

    def hold_until_device_stops(self, max_seconds: float) -> None:
        """异步播报：一直关到设备上报"我放完了"，`max_seconds` 只是兜底。

        与 `hold_for()` 的区别是**关闭时刻的依据**：`hold_for()` 按估时放开，
        URL 播放没有文本可估（按空串估出来只有 1.5 秒），声音还在放闸门就开
        了；而且"命令发出 → 首条 playing 事件"之间还有一段空窗。这里改成由
        AudioPlayer 的播放状态驱动：

          * 先关闸，不等首条事件（空窗也盖住）；
          * 观察到 `playing` 之后转成非 playing，才算真实播放结束，放行；
          * 设备从头到尾没报 `playing` 时绝不提前放行，只有 `max_seconds`
            到期才兜底打开（防止设备不上报事件时麦克风被永久关掉）。

        不需要配对释放，到期或设备报完自己结束。
        """
        if max_seconds <= 0:
            return

        token = object()
        timer = threading.Timer(float(max_seconds), self._release_device_hold, args=(token,))
        timer.daemon = True
        with self._lock:
            self._depth += 1
            self._device_holds[token] = timer
            if self._device_playing:
                # 命令发出前设备就已经在放（极少见）：起点算确认过。
                self._started_device_holds.add(token)
        timer.start()

    def _release_device_hold(self, token: object) -> None:
        """结束一次 `hold_until_device_stops()`（设备报完或兜底到期）。"""
        with self._lock:
            timer = self._device_holds.pop(token, None)
            self._started_device_holds.discard(token)
            if timer is not None:
                if self._depth > 0:
                    self._depth -= 1
                if self._depth == 0:
                    self._until = max(self._until, time.monotonic())
        if timer is not None:
            timer.cancel()

    def set_device_playing(self, playing: bool) -> None:
        """同步音箱侧上报的播放状态（AudioPlayer 事件）。

        两件事：

          * 用来**延长**关闸时间 —— 设备还在放，闸门就必须关着；
          * 用来结束 `hold_until_device_stops()` 的等待 —— 但只认"观察到
            playing 之后转成非 playing"这一次真实结束。设备在播放刚开始时
            可能先报一次 idle，信了它回声就回来了。
        """
        finished: list[object] = []
        with self._lock:
            was_playing = self._device_playing
            self._device_playing = bool(playing)
            if playing:
                self._started_device_holds.update(self._device_holds)
            elif was_playing:
                finished = [
                    token
                    for token in self._device_holds
                    if token in self._started_device_holds
                ]
        for token in finished:
            self._release_device_hold(token)

    def reset(self) -> None:
        """丢掉全部占用（测试与打断流程使用）。"""
        with self._lock:
            timers = list(self._device_holds.values())
            self._device_holds.clear()
            self._started_device_holds.clear()
            self._depth = 0
            self._until = 0.0
            self._device_playing = False
        for timer in timers:
            timer.cancel()

    @property
    def closed(self) -> bool:
        """设备正在（或刚刚在，误差为尾音）说话时为 True。"""
        with self._lock:
            if self._depth > 0 or self._device_playing:
                return True
            return (time.monotonic() - self._until) < self._tail

    async def wait_until_open(
        self,
        timeout: float | None = None,
        poll_interval: float = 0.05,
    ) -> bool:
        """异步等闸门自己打开（设备报放完，或兜底持有到期）。

        异步播报的调用方（`speaker.play(blocking=False)`）返回时声音还在后面
        放；想把多路播报串行化、或者想在播完之后再做别的事，就得等这一刻。
        `timeout` 秒内没等到就返回 False，由调用方决定怎么办。
        """
        deadline = None if timeout is None else time.monotonic() + max(0.0, float(timeout))
        while self.closed:
            if deadline is not None and time.monotonic() >= deadline:
                return False
            await asyncio.sleep(poll_interval)
        return True

    def __enter__(self):
        self.hold()
        return self

    def __exit__(self, *_exc):
        self.release()
        return False


PlaybackGate = _PlaybackGate()
