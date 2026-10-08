# 高风险路径与症状处置

根 [AGENTS.md](../../AGENTS.md) 的外移章节。改动前的风险清单与出错时的处置表都在这里；根文件只留触发条件最高的一小段。改动契约（要一起改什么、跑什么）见 [change-contract.md](./change-contract.md)。

## 已知风险区

| 路径 | 风险 | 改动前后置动作 |
|---|---|---|
| `lib/client.js` | 手写产物、没有 bundler，语法或席位写错只有运行时才炸 | 改完必跑 `node scripts\check-client.mjs`；可见行为还要按验收标准第 5 条重启后核对 |
| `lib/config.js` | `DEFAULTS` 与 `CONFIG_SCHEMA` 是两处，漂移后设置页显示的值与桥接器实际读到的值不一致；运行时坏值靠 `sanitizeConfig` 逐键回退（同一组坏值告警一次、不同组各一次），静默漂移看不出来 | 两处一起改，跑 `check-config` 与 `check-client` |
| `lib/http.js` | 路由、请求体解析与同源校验错了会直接动到鉴权边界（缺令牌必须 fail-closed），真机 socket 行为离线也测不全 | 跑 `node scripts\check-http.mjs`；协议语义变动再用真实请求打通一遍（含拒绝路径） |
| `lib/exposure.js` | `xiaoai_speak` 与其技能注册到哪一层（音箱会话的 agent 作用域，或逃生门打开时的全局层）；注册错层会让普通会话也看得见工具，或让音箱会话里反而没有工具 | 跑 `node scripts\check-session.mjs`（case 9/10 覆盖作用域注册、无模型选择那一路、exposureState 的降级与逃生门）；宿主没有 scoped `tools`/`skills` 时必须**不注册**并记一条 `scope-registration-unavailable`，绝不偷偷退回全局 |
| `cordis.patch.yml`（含「小爱模式」预设那一条 insert） | 一个 bundle 两条 insert：插件本体（设置卡命名空间 `id: xiaoai`，定了就不能改）与音箱会话的 Agent 预设（`preset-xiaoai`）；声明写坏会让预设装上却激活失败（`agent-preset-broken`），`plugins` 清单里误加子代理、计划模式或 `dsh-tool-ask-user` 则等于把语音会话又交回给要人点界面的工具 | 跑 `node scripts\check-session.mjs`（case 11）；profile 里是 `link:`，改完不用重装，但新增工具要重启 DSH 并让音箱会话新建一个；宿主没有 `agentPresets` 注册表或 `agentPreset` 留空时**完全不碰注册表** |
| `lib/cleanup.js` | GENERATED/HISTORY 划分错了，会在每次 DSH 关闭时删掉 `spoken.jsonl`（用户明确要留的历史）；teardown 只在「stop 成功且端口都释放」时才删 generated，否则要 `removeGenerated({ keep: ['bridge.pid'] })` | 跑 `check-cleanup` |
| `lib/ports.js` + `bridge/native/src/server.rs` + `bridge/docker-compose.yml` | `4399` 是硬编码的；仓库内不同步会让「端口仍被占用」的诊断误报或漏报，漏改设备侧 `/data/open-xiaoai/server.txt`（不在仓库内）则是音箱完全没反应；`4399` 默认还要求设备带令牌（`speakerAuth`），设备侧没带的表现是日志报 401、音箱同样没反应 | 三处一起改 + 人工改设备侧（含 `?token=`），跑 `check-cleanup`、`check-supervisor` |
| `lib/process.js` | 接管 DSH 异常退出后遗留的桥接器进程（按 pid 文件里的 **pid + 命令行身份**）与 Windows 下的进程树清理；看门狗的重启预算按**滑动崩溃窗口**算（`crashWindowMs`）；改错会留下孤儿进程占着 4399/9092，或把「一天崩一次」误判成崩溃循环 | 跑 `node scripts\check-supervisor.mjs`；真机验收里核对卸载后无残留 |
| `locale/zh.json`、`locale/en.json` 与 `lib/client.js` | 插件标题/描述在 json 里，其余界面文案在 `client.js` 的两张内联表里，中英 parity 没有工具守着 | 三处一起改 |
| `bridge/core/utils/playback_gate.py` | 半双工闸门：引用计数或设备事件时序写错会自问自答；设备不上报播放事件时还可能把麦克风关死 | 改前读文件顶部 docstring；跑 `bridge/tests/test_playback_gate.py` |
| `bridge/core/services/speaker.py` | 设备命令面与打断，写错在单测里看不出来 | 实机验证一次打断 |
| `bridge/core/services/api_server.py` + `api_auth.py` | 监听地址可被设成 `0.0.0.0`，等于把音箱的播放与唤醒交给整个局域网 | 新端点走既有 middleware，不要绕过 |
| `bridge/core/utils/config.py` + `config_loader.py` | 配置由插件渲染到 `<dataDir>/config.py` 并秒级热重载 | 不要在模块顶层缓存配置值（`api_auth.py` 就是每请求读） |
| `bridge/core/dsh.py` | 令牌来源（`XIAOAI_API_TOKEN` 优先、渲染配置的 `dsh.token` 兜底）与 `run_id` 关联 | 令牌单源；取不到值会让音箱每句被插件 503 |
| `bridge/core/services/tts/router.py` 的豆包分支 | 凭据也是两条来源（`DOUBAO_ACCESS_KEY` 优先、`tts.doubao.access_key` 兜底）；环境变量在进程启动时快照，插件里换了凭据名要重启桥接器才带上新值 | 不要把凭据读成模块级常量；缺 app_id / access_key 时明确抛错，不要静默换 provider |
| `bridge/.venv` 里的 `.pyd` | Windows 上文件被占用就删不掉 | 改 Rust 前先停桥接器 |

## 出错怎么办

用户可见的排错口径在 [README.md](../../README.md) 的排错表；下表是开发/维护时的常见故障。

| 症状（可检索片段） | 处理 |
|---|---|
| 装 GitHub 版本报 `no matching ref` | 写的 ref 不存在：本仓库已没有 tag（历史 tag 随 Release 删除，版本固定走 npm），`github:…#<tag>` 一律报错；GitHub 安装只能不带 ref 或 `#main`（跟随开发分支） |
| `config render failed: ENOENT` 且路径里有 `config.py.tmp` | 数据目录还没建（`autoStart` 关着，或在临时 `DSH_HOME` 里跑），不是渲染器坏了 |
| `No module named pytest` | `uv sync` 清掉了 dev 依赖：`uv pip install --python bridge\.venv\Scripts\python.exe pytest`；也可能是用了系统 Python，改用 `bridge/.venv` 的解释器 |
| `failed to remove file …dsh_xiaoai_server.pyd: 拒绝访问 (os error 5)` | 桥接器正在跑，`.pyd` 被占用：先 `POST http://127.0.0.1:19387/plugin/xiaoai/bridge/stop` 再 `uv sync`，装完 `POST …/bridge/start` |
| 改了 `bridge/native/src/*.rs` 但行为没变 | 扩展没重编译：停桥接器后 `uv sync`，核对 `.pyd` 的文件时间戳 |
| `No module named 'dsh_xiaoai_server'`、`ImportError: DLL load failed` | Rust 扩展没编译好：停桥接器后 `uv sync`；`main.py` 会自动补 onnxruntime 的库路径 |
| `[WARN] Failed to replace env in config: ${NPM_TOKEN}` | `dsh plugin`（pnpm）打印的无关警告，忽略 |
| 卸载后仍有进程或端口没释放 | 这条决策由 `check-cleanup` 与 `check-supervisor` 覆盖 |
| 状态卡上出现 `port-held` / `watchdog-gave-up` / `start-failed` / `token-not-applied` | 编码含义见 README 排错表；实时状态看 `GET /plugin/xiaoai/health` 的 `bridgeApi.state` |
| 设置页存了值但行为没变 | 先看日志里有没有 `unusable config repaired with defaults:`，坏值会被逐键回退成默认值，存的不是你写的那份 |
| 日志刷 `Unknown tts_provider=` | provider 名字没进 `SUPPORTED_PROVIDERS`，见 [change-contract.md](./change-contract.md) |
| 音箱自己接自己的话 | 有播报路径没过 `PlaybackGate`，或闸门提前放开 |
| 音箱完全没反应，日志里 `[DSH] Plugin not reachable at` | 桥接器连不上插件：确认 DSH 在跑，且 `base_url` 是 `http://127.0.0.1:19387/plugin/xiaoai` |
| 每一句都被拒 | 令牌没拿到：看插件 `/health` 的 `tokenConfigured` 与诊断里的 `token-not-applied` |
