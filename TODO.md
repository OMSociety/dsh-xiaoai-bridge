# TODO（发布前）

这份清单只记**发布前还必须做**的事；做完一条删一条，不留复选框考古。功能与用法见 [README.md](README.md)，编码纪律见 [AGENTS.md](AGENTS.md)，实现决策与踩坑见 [docs/deploy.md](https://github.com/OMSociety/dsh-xiaoai-bridge/blob/main/docs/deploy.md) 的 §12.x。本文件不随包发布（不在 `package.json` 的 `files` 白名单里）。

## 必须在发布前做完

- [ ] **MiMo TTS 接线**。现状是「存了不写」：设置页能选「MiMo（预留）」，四个 MiMo 字段只留在插件配置里，`lib/render-config.js` 的 `RENDERED_TTS_PROVIDERS` 只有 `xiaoai`，所以桥接器永远收不到 `tts_provider = "mimo"`（决策见 `docs/deploy.md` §12.25）。
  - [ ] 桥接器侧加 MiMo 客户端：走 OpenAI 兼容的 `POST /v1/audio/speech`，照 `bridge/core/services/tts/openai.py` 的写法接进 `bridge/core/services/tts/router.py`，并把 `mimo` 加进它的 `SUPPORTED_PROVIDERS`。
  - [ ] 密钥**绝不进配置**：`mimoApiKeyCredential` 存的是 **DSH 凭据名**，真令牌走 credentials seam（对照 `lib/index.js` 的 `currentToken()`）。
  - [ ] `lib/render-config.js` 的 `buildOverrides()` 在 `ttsProvider === "mimo"` 时写 `dsh.tts_provider = "mimo"` 与四个 `mimo*` 项（先把 `mimo: 'mimo'` 加进 `RENDERED_TTS_PROVIDERS`）；说明 `ttsSpeaker` 在 mimo 下不再起作用。
  - [ ] 未知或未接线的 provider 仍然是**回退**、不是报错（`bridge/core/services/tts/router.py` 的 `resolve_provider()`，口径见 §12.37.6）。
  - [ ] 同步检查与文档：`scripts/check-config.mjs`（「预留 provider 不写进渲染配置」那条断言改成「未接线的 provider 不写」）、`scripts/check-client.mjs`（`ttsProvider` 的选项文案是逐字断言的）、`README.md` 配置表去掉「MiMo（预留）」、`docs/deploy.md` §12.25 追加接线记录。
- [ ] **版本与 CHANGELOG 收口**：`package.json` 的 `version` 仍是 `0.2.8`，**改前先报备用户**；改完同步 README 徽章，并让 `CHANGELOG.md` 的 `Unreleased` 节落定（版本标题带日期、中英条目 1:1，跑 `changelog-check.mjs`）。
- [ ] **发布前全绿**：仓库根 `npm run check`（九条）、`bridge` 的 `pytest -q`（基线 `115 passed, 19 subtests`，只许升）、仓库外的 `doc-check.mjs` 与 `changelog-check.mjs`。`bridge` 的 `.venv` 里若没有 pytest，先 `uv pip install --python .venv\Scripts\python.exe pytest`（`uv sync` 会把它卸掉）。
- [ ] **push 归用户**：提交只推 `origin`，`upstream` 只用来查看状态。

## 可选（用户没点头就不动）

- [ ] 外观项去品牌化：`bridge/pyproject.toml` 的分发名 `open-xiaoai-bridge`（dist-info 至今仍是 `open_xiaoai_bridge-1.0.0.dist-info`）、`bridge/docker-compose.yml` 的服务名与镜像名、豆包 TTS 的 uid。三处要一起改才自洽，所以没单独动。
- [ ] `bridge/README.md` 与 `bridge/CHANGELOG.md` 里搬来的旧内容（快速开始的 clone 地址、旧 `session_key` 示例、`v1.0.7` 历史条目）**有意保留**；真要重写，先确认不再需要出处与历史。

## 需要用户动手（不是编码任务）

- [ ] 重启 DSH，确认设置页 bundle 与「小爱模式」预设都是新的；音箱**开新对话**才会用上新预设（已有会话保留它启动时的 revision）。
- [ ] 实机验收（`docs/deploy.md` §8 里的 3.13 / 3.15）：说唤醒词 → 说话 → 听到口语化播报、`spoken.jsonl` 落一行、音箱会话出现在工作区分组里。
- [ ] 第二台音箱到位后验多设备（`device_host` 已全链路透传，只差实机；§8 的 3.10）。
