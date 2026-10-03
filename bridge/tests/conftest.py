"""tests/ 的 pytest 收集规则。

`test_tts*.py` 是**手动脚本**而不是单测：它们没有 `def test_*`，但模块级就会
`import dsh_xiaoai_server`、加载真 `config`、连豆包 TTS 甚至让音箱出声 ——
pytest 只要**导入**模块就会做这些事，所以默认必须排除，否则在没设备、没凭据
的机器上收集阶段就会炸（更糟的是有设备时会真出声）。

要跑它们就直接 `python tests/test_tts.py`（用法见各文件头）。
"""

# 手动脚本：需真设备/真配置，用 `python <file>` 跑。
collect_ignore = [
    "test_tts.py",
    "test_tts_latency.py",
    "test_tts_stream.py",
]
