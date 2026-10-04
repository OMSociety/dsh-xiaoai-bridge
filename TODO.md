# TODO（发布前）

这份清单只记**发布前还必须做**的事；做完一条删一条，不留复选框考古。功能与用法见 [README.md](README.md)，编码纪律见 [AGENTS.md](AGENTS.md)，实现决策与踩坑见 [CHANGELOG.md](CHANGELOG.md) 的版本条目。本文件不随包发布（不在 `package.json` 的 `files` 白名单里）。

## 必须在发布前做完

- [ ] **打 tag 与 CHANGELOG 条目**：版本号已按用户签字收口到 `1.0.0`（`package.json` 与 README 徽章同步，`CHANGELOG.md` 保持只有文件头的初始状态）。打 `1.0.0` tag 那天再补 `## [1.0.0] - YYYY-MM-DD` 与条目，并跑仓库外的 `changelog-check.mjs`（它要求非 `Unreleased` 的版本标题带日期）。本仓库已有上游 tag `v1.0.0` … `v1.0.7`、`baseline`、`vad-kws-asr-models`，打 tag 前先 `git tag -l` 确认不撞名。条目要一并交代本轮审计留下的取舍（`xiaoai_speak` 只在桥接器明确答复时才交还发言权、`registerScoped` 的半注册回滚、`routeHintFor` 里 empty 优先于 partial），这些取舍目前只写在代码注释里。
- [ ] **发布前全绿**：仓库根 `npm run check`（九条）、`bridge` 的 `pytest -q`（基线 `157 passed, 19 subtests`，只许升）、仓库外的 `doc-check.mjs` 与 `changelog-check.mjs`。`bridge` 的 `.venv` 里若没有 pytest，先 `uv pip install --python .venv\Scripts\python.exe pytest`（`uv sync` 会把它卸掉）。
- [ ] **push 归用户**：提交只推 `origin`，`upstream` 只用来查看状态。

## 可选（用户没点头就不动）

- [ ] 外观项去品牌化：`bridge/pyproject.toml` 的分发名 `open-xiaoai-bridge`（dist-info 至今仍是 `open_xiaoai_bridge-1.0.0.dist-info`）、`bridge/docker-compose.yml` 的服务名与镜像名、豆包 TTS 的 uid。三处要一起改才自洽，所以没单独动。

## 需要用户动手（不是编码任务）

- [ ] 重启 DSH，确认设置页 bundle 与「小爱模式」预设都是新的；音箱**开新对话**才会用上新预设（已有会话保留它启动时的 revision）。
- [ ] 实机验收：说唤醒词 → 说话 → 听到口语化播报、`spoken.jsonl` 落一行、音箱会话出现在工作区分组里。
- [ ] 第二台音箱到位后验多设备（`device_host` 已全链路透传，只差实机）。
