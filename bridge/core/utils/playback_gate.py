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
"""

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
    """估算一段文本会被念多久（秒）。

    `ubus call mibrain text_to_speech` 在设备**收下**文本后就返回，语音还在
    后面慢慢放，所以除文本本身之外没有别的依据。空文本按最短时间处理。
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

    def set_device_playing(self, playing: bool) -> None:
        """同步音箱侧上报的播放状态（AudioPlayer 事件）。

        只用来**延长**关闸时间，从不用来提前打开 —— 设备可能在播放刚开始时
        报一次 idle，信了它回声就回来了。
        """
        with self._lock:
            self._device_playing = bool(playing)

    def reset(self) -> None:
        """丢掉全部占用（测试与打断流程使用）。"""
        with self._lock:
            self._depth = 0
            self._until = 0.0
            self._device_playing = False

    @property
    def closed(self) -> bool:
        """设备正在（或刚刚在，误差为尾音）说话时为 True。"""
        with self._lock:
            if self._depth > 0 or self._device_playing:
                return True
            return (time.monotonic() - self._until) < self._tail

    def __enter__(self):
        self.hold()
        return self

    def __exit__(self, *_exc):
        self.release()
        return False


PlaybackGate = _PlaybackGate()
