/**
 * Offline acceptance checks for lib/render-config.js and lib/process.js.
 *
 * The renderer only matters if the *bridge* agrees with it, so the central case
 * here does not inspect the generated source as text: it renders a config with
 * deliberately unusual settings, then runs the bridge's own interpreter with
 * `CONFIG_PATH` pointing at the result and compares the values the Python side
 * actually loaded.
 *
 * The bridge is started by environment variables alone, so the other half of
 * "the settings card is the single source of truth" is the mapping asserted
 * below against `bridgeChildEnv()`.
 *
 * Run: node scripts/check-config.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, sanitizeConfig, validateConfig } from '../lib/config.js';
import { bridgeChildEnv } from '../lib/process.js';
import {
  GENERATED_HEADER,
  buildOverrides,
  composeVoiceRule,
  pythonLiteral,
  renderConfigPath,
  splitList,
  writeConfig,
} from '../lib/render-config.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE_DIR = join(PACKAGE_ROOT, 'bridge');
const PYTHON = join(BRIDGE_DIR, '.venv', 'Scripts', 'python.exe');

let failures = 0;
/** @param {boolean} condition @param {string} label */
function ok(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}
/** @param {unknown} actual @param {unknown} expected @param {string} label */
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${label} (${a}${a === b ? '' : ` !== ${b}`})`);
}

console.log('render-config: literal rendering');
eq(pythonLiteral(true), 'True', 'boolean true');
eq(pythonLiteral(false), 'False', 'boolean false');
eq(pythonLiteral(null), 'None', 'null');
eq(pythonLiteral(20), '20', 'integer');
eq(pythonLiteral('小爱小爱'), '"小爱小爱"', 'non-ASCII string');
eq(pythonLiteral(['a', 'b']), '["a", "b"]', 'list');
eq(pythonLiteral({ a: 1, b: [true, null] }), '{"a": 1, "b": [True, None]}', 'nested object');
let threw = false;
try {
  pythonLiteral(Number.NaN);
} catch {
  threw = true;
}
ok(threw, 'non-finite numbers are refused');

console.log('render-config: list splitting');
eq(splitList('小爱小爱\n小爱同学'), ['小爱小爱', '小爱同学'], 'newline separated');
eq(splitList('退出, 停止 ,\n再见'), ['退出', '停止', '再见'], 'comma + whitespace + blank line');
eq(splitList('小爱小爱，小爱同学'), ['小爱小爱', '小爱同学'], 'full-width comma separated');
eq(splitList('你好小智、小爱小爱'), ['你好小智', '小爱小爱'], 'enumeration comma separated');
eq(splitList('甲\r\n乙'), ['甲', '乙'], 'CRLF separated');
eq(splitList(''), [], 'empty text');
eq(splitList(undefined), [], 'absent text');

console.log('render-config: overrides');
const bare = buildOverrides({ ...DEFAULTS, wakeKeywords: '', exitKeywords: '', sessionKey: '', deviceName: '', ttsSpeaker: '', wakeupReplyText: '', exitReplyText: '', fallbackText: '', voiceRuleText: '', behaviorStyle: '', asrBackend: '' });
// Four values are always written because the plugin owns them outright: the
// conversation timeout (same 20 seconds as the template), the single-shot switch
// (whose false default is the documented behavior) and the two Doubao playback
// controls the settings page shows (streaming on, speed 1.0).
eq(bare, {
  wakeup: { timeout: DEFAULTS.wakeupTimeout },
  dsh: { continuous_conversation: DEFAULTS.continuousConversation, tts_speed: DEFAULTS.ttsSpeed },
  tts: { doubao: { stream: DEFAULTS.doubaoStream } },
}, 'emptied fields fall back to the template default');
const full = buildOverrides({
  ...DEFAULTS,
  wakeKeywords: '你好小智\n小爱小爱',
  exitKeywords: '退出,再见',
  wakeupTimeout: 33,
  sessionKey: 'agent:butler:dsh-xiaoai-bridge',
  deviceName: '客厅音箱',
  ttsSpeaker: 'zh_female_1',
  wakeupReplyText: '在呢',
  exitReplyText: '拜拜',
  fallbackText: '电脑睡了',
  asrBackend: 'paraformer',
});
eq(full.wakeup.keywords, ['你好小智', '小爱小爱'], 'wakeup.keywords');
eq(full.wakeup.timeout, 33, 'wakeup.timeout');
eq(full.dsh.wakeup_keywords, ['你好小智', '小爱小爱'], 'dsh.wakeup_keywords');
eq(full.dsh.exit_keywords, ['退出', '再见'], 'dsh.exit_keywords');
eq(full.dsh.session_key, 'agent:butler:dsh-xiaoai-bridge', 'dsh.session_key');
eq(full.dsh.tts_speaker, 'zh_female_1', 'dsh.tts_speaker');
eq(full.dsh.wakeup_reply, '在呢', 'dsh.wakeup_reply');
eq(full.dsh.exit_reply, '拜拜', 'dsh.exit_reply');
eq(full.dsh.fallback_text, '电脑睡了', 'dsh.fallback_text');
eq(full.dsh.rule_prompt_for_skill, composeVoiceRule(DEFAULTS), 'dsh.rule_prompt_for_skill');
eq(
  full.dsh.rule_prompt_for_skill,
  `${DEFAULTS.voiceRuleText}\n\n行动准则：${DEFAULTS.behaviorStyle}`,
  'the action rules are appended, not bundled into the voice rule',
);
eq(DEFAULTS.voiceRuleText.includes('行动准则'), false, 'the voice rule default is the channel note only');
eq(full.dsh.continuous_conversation, false, 'dsh.continuous_conversation follows the page default');
eq(
  buildOverrides({ ...DEFAULTS, continuousConversation: true }).dsh.continuous_conversation,
  true,
  'dsh.continuous_conversation flips with the switch',
);
// The provider follows the switch, but only for a provider the bridge can load:
// an empty choice keeps the router's own voice-id rule.
ok(!('tts_provider' in bare.dsh), 'an empty provider choice writes nothing');
eq(buildOverrides({ ...DEFAULTS, ttsProvider: 'xiaoai' }).dsh.tts_provider, 'xiaoai', 'the native provider is written');
eq(buildOverrides({ ...DEFAULTS, ttsProvider: 'doubao' }).dsh.tts_provider, 'doubao', 'the Doubao provider is written');
const doubaoFull = buildOverrides({
  ...DEFAULTS,
  doubaoAppId: 'app-1',
  doubaoSpeaker: 'zh_female_1',
  doubaoAudioFormat: 'ogg_opus',
  ttsSpeed: 1.5,
});
eq(doubaoFull.tts.doubao.app_id, 'app-1', 'tts.doubao.app_id follows the settings page');
eq(doubaoFull.tts.doubao.default_speaker, 'zh_female_1', 'tts.doubao.default_speaker follows the settings page');
eq(doubaoFull.tts.doubao.audio_format, 'ogg_opus', 'tts.doubao.audio_format follows the settings page');
eq(doubaoFull.tts.doubao.stream, true, 'tts.doubao.stream follows the switch');
eq(doubaoFull.dsh.tts_speed, 1.5, 'dsh.tts_speed follows the speed field');
// The Access Token travels through the child environment, never this file.
ok(
  !JSON.stringify(doubaoFull).includes('access_key'),
  'the Doubao Access Token never reaches config.py',
);
const doubaoBare = buildOverrides({ ...DEFAULTS, doubaoAppId: '', doubaoSpeaker: '', doubaoAudioFormat: '' });
eq(doubaoBare.tts.doubao.app_id, undefined, 'an emptied App ID writes nothing');
eq(doubaoBare.tts.doubao.default_speaker, undefined, 'an emptied voice writes nothing');
eq(doubaoBare.tts.doubao.audio_format, undefined, 'an emptied audio format writes nothing');
eq(full.asr.model, 'paraformer', 'asr.model');

// Half of this plugin's settings never reach config.py: they become the child
// process environment. Assert the mapping here so a settings key without a
// consumer (or a consumer without a key) is caught offline.
console.log('render-config: child environment');
const childEnvBare = bridgeChildEnv({ ...DEFAULTS }, 'C:\\data\\config.py');
eq(childEnvBare.SILENT_START_ENABLE, '0', 'the connect prompt stays on by default');
eq(
  bridgeChildEnv({ ...DEFAULTS, silentStart: true }, 'C:\\data\\config.py').SILENT_START_ENABLE,
  '1',
  'the silent-start switch reaches the child',
);
eq(childEnvBare.DSH_ENABLE, '1', 'the master switch is passed through');
eq(
  childEnvBare.LOGLEVEL,
  'INFO',
  'the log level uses the name the bridge logger reads (LOGLEVEL, not LOG_LEVEL)',
);
eq(
  bridgeChildEnv({ ...DEFAULTS, logLevel: 'DEBUG' }, 'C:\\data\\config.py').LOGLEVEL,
  'DEBUG',
  'a changed log level reaches the child',
);
ok(!('LOG_LEVEL' in childEnvBare), 'the dead LOG_LEVEL spelling is gone');
eq(childEnvBare.AUDIO_INPUT_ENABLE, '1', 'audio input stays enabled');
eq(childEnvBare.CONFIG_PATH, 'C:\\data\\config.py', 'the child is pointed at the rendered config');
eq(childEnvBare.API_SERVER_PORT, '9092', 'the API Server port is a string for the child');
ok(!('XIAOAI_API_TOKEN' in childEnvBare), 'the token is added by the caller, never here');
ok(!('DOUBAO_ACCESS_KEY' in childEnvBare), 'the Doubao Access Token is added by the caller too');

const workDir = mkdtempSync(join(tmpdir(), 'xiaoai-config-'));
try {
  const target = renderConfigPath(workDir);
  const written = writeConfig({
    dataDir: workDir,
    templatePath: join(BRIDGE_DIR, 'config.py'),
    cfg: {
      ...DEFAULTS,
      wakeKeywords: '你好小智\n小爱小爱',
      exitKeywords: '退出,再见',
      wakeupTimeout: 33,
      sessionKey: 'agent:butler:dsh-xiaoai-bridge',
      deviceName: '客厅音箱',
      ttsSpeaker: 'zh_female_1',
      wakeupReplyText: '在呢',
      exitReplyText: '拜拜',
      fallbackText: '电脑睡了',
      asrBackend: 'paraformer',
      continuousConversation: true,
      ttsProvider: 'xiaoai',
    },
  });
  ok(existsSync(target), `config written to ${target}`);
  ok(written.source.startsWith(GENERATED_HEADER), 'generated file carries the do-not-edit header');
  ok(!existsSync(`${target}.tmp`), 'the temp file is renamed away, not left behind');

  // A destination the atomic install can never replace (here: a directory) must
  // surface as an error and must not leave the half-written temp file behind.
  // The Windows read window the retry exists for cannot be staged in-process
  // (it needs a foreign handle opened without FILE_SHARE_DELETE), so the
  // negative path is what this checker can hold down; the positive one — a real
  // lock released mid-retry — is recorded in docs/deploy.md §12.31.3.
  const blockedDir = mkdtempSync(join(tmpdir(), 'xiaoai-config-blocked-'));
  try {
    const blockedTarget = renderConfigPath(blockedDir);
    mkdirSync(blockedTarget);
    let blockedError = null;
    const startedAt = Date.now();
    try {
      writeConfig({ dataDir: blockedDir, templatePath: join(BRIDGE_DIR, 'config.py'), cfg: { ...DEFAULTS } });
    } catch (err) {
      blockedError = err;
    }
    const blockedMs = Date.now() - startedAt;
    ok(blockedError !== null, `an uninstallable destination fails loudly (${blockedError?.code ?? 'no error'} after ${blockedMs} ms)`);
    ok(!existsSync(`${blockedTarget}.tmp`), 'a failed install cleans up its own temp file');
    ok(existsSync(blockedTarget), 'a failed install leaves the existing path alone');
  } finally {
    rmSync(blockedDir, { recursive: true, force: true });
  }

  // The bridge reads config.py through core.utils.config_loader; run its own
  // interpreter against the rendered file rather than trusting the text.
  const probe = `
import json, sys
from core.utils.config_loader import load_config_module
module = load_config_module()
print(json.dumps({
    "path": module.__file__,
    "wakeup_keywords": module.APP_CONFIG["wakeup"]["keywords"],
    "wakeup_timeout": module.APP_CONFIG["wakeup"]["timeout"],
    "dsh_wakeup_keywords": module.APP_CONFIG["dsh"]["wakeup_keywords"],
    "dsh_exit_keywords": module.APP_CONFIG["dsh"]["exit_keywords"],
    "dsh_session_key": module.APP_CONFIG["dsh"]["session_key"],
    "dsh_device_name": module.APP_CONFIG["dsh"]["device_name"],
    "dsh_tts_speaker": module.APP_CONFIG["dsh"]["tts_speaker"],
    "dsh_wakeup_reply": module.APP_CONFIG["dsh"]["wakeup_reply"],
    "dsh_exit_reply": module.APP_CONFIG["dsh"]["exit_reply"],
    "dsh_fallback_text": module.APP_CONFIG["dsh"]["fallback_text"],
    "dsh_continuous_conversation": module.APP_CONFIG["dsh"]["continuous_conversation"],
    "dsh_tts_provider": module.APP_CONFIG["dsh"].get("tts_provider"),
    "dsh_tts_speed": module.APP_CONFIG["dsh"].get("tts_speed"),
    "tts_doubao_stream": module.APP_CONFIG["tts"]["doubao"].get("stream"),
    "asr_model": module.APP_CONFIG["asr"]["model"],
    "hooks": [callable(module.before_wakeup), callable(module.after_wakeup)],
    "untouched_default": module.APP_CONFIG["kws"]["keywords_score"],
    "hook_globals_match": (
        module.before_wakeup.__globals__["APP_CONFIG"]["dsh"]["wakeup_reply"]
        == module.APP_CONFIG["dsh"]["wakeup_reply"]
    ),
}, ensure_ascii=False))
`;
  const raw = execFileSync(PYTHON, ['-c', probe], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, CONFIG_PATH: target, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
  });
  const loaded = JSON.parse(raw.trim().split(/\r?\n/).pop());

  console.log('render-config: what the bridge actually loads');
  eq(loaded.wakeup_keywords, ['你好小智', '小爱小爱'], 'wakeup.keywords');
  eq(loaded.dsh_wakeup_keywords, ['你好小智', '小爱小爱'], 'dsh.wakeup_keywords');
  eq(loaded.dsh_exit_keywords, ['退出', '再见'], 'dsh.exit_keywords');
  eq(loaded.wakeup_timeout, 33, 'wakeup.timeout');
  eq(loaded.dsh_session_key, 'agent:butler:dsh-xiaoai-bridge', 'dsh.session_key');
  eq(loaded.dsh_device_name, '客厅音箱', 'dsh.device_name');
  eq(loaded.dsh_tts_speaker, 'zh_female_1', 'dsh.tts_speaker');
  eq(loaded.dsh_wakeup_reply, '在呢', 'dsh.wakeup_reply');
  eq(loaded.dsh_exit_reply, '拜拜', 'dsh.exit_reply');
  eq(loaded.dsh_fallback_text, '电脑睡了', 'dsh.fallback_text');
  eq(loaded.dsh_continuous_conversation, true, 'the switch reaches the bridge as a real boolean');
  eq(loaded.dsh_tts_provider, 'xiaoai', 'the provider switch reaches the bridge as a string');
  eq(loaded.dsh_tts_speed, DEFAULTS.ttsSpeed, 'the Doubao speed reaches the bridge as a number');
  eq(loaded.tts_doubao_stream, true, 'the streaming switch reaches the bridge as a real boolean');
  eq(loaded.asr_model, 'paraformer', 'asr.model');
  eq(loaded.hooks, [true, true], 'both wake hooks survive the overlay');
  eq(loaded.hook_globals_match, true, 'the hooks see the overridden values, not the template ones');
  eq(loaded.untouched_default, 2.0, 'keys the plugin does not own keep the template default');

  // A field the plugin does not own must not be written at all, or an upstream
  // default change would be silently pinned by this plugin.
  const sparse = join(workDir, 'sparse.py');
  const sparseOverrides = buildOverrides({ ...DEFAULTS, wakeKeywords: '小爱小爱' });
  writeConfig({
    dataDir: workDir,
    templatePath: join(BRIDGE_DIR, 'config.py'),
    cfg: { ...DEFAULTS, wakeKeywords: '小爱小爱' },
    path: sparse,
  });
  const sparseSource = readFileSync(sparse, 'utf8');
  eq(sparseOverrides.wakeup, { keywords: ['小爱小爱'], timeout: DEFAULTS.wakeupTimeout }, 'sparse overrides carry only the wake words');
  eq(sparseOverrides.dsh.wakeup_keywords, ['小爱小爱'], 'the same words feed the routing hook');
  // `rule_prompt` (the text channel's wording) is template-only: the plugin
  // writes `rule_prompt_for_skill` and must leave the other one alone.
  ok(!sparseSource.includes('"rule_prompt"'), 'template-only keys are never restated in the generated file');
  ok(sparseSource.includes('"continuous_conversation": False'), 'a false switch is still written, as a Python literal');
  ok(!sparseSource.includes('tts_provider'), 'the provider stays out of the file while the choice is empty');
  ok(sparseSource.includes('"stream": True'), 'a page-owned switch is written even at its default');
  ok(sparseSource.includes('"tts_speed": 1'), 'a page-owned number is written even at its default');
  ok(!sparseSource.includes('response_timeout'), 'template-only keys are never restated in the generated file');
  ok(!sparseSource.includes('openai'), 'untouched sections stay out of the generated file');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// The schema is the settings page's contract, not a guarantee about what
// reaches `apply()`: a local `POST /config`, a composition base or a patch
// stored before a rule was tightened can all hand over a value it would have
// rejected. The runtime path repairs such a section instead of starting a
// bridge that cannot work, and the strict path is what a writer calls first.
console.log('config: unusable values are repaired, not passed through');
const repaired = sanitizeConfig({
  ...DEFAULTS,
  apiServerPort: 70000,
  wakeupTimeout: 20.5,
  logLevel: 'TRACE',
  apiServerHost: '   ',
  spokenMaxChars: 3,
});
eq(repaired.value.apiServerPort, DEFAULTS.apiServerPort, 'an out-of-range port falls back to the default');
eq(repaired.value.wakeupTimeout, DEFAULTS.wakeupTimeout, 'a fractional timeout falls back to the default');
eq(repaired.value.logLevel, DEFAULTS.logLevel, 'an unknown log level falls back to the default');
eq(repaired.value.apiServerHost, DEFAULTS.apiServerHost, 'a blank host falls back to the default');
eq(repaired.value.spokenMaxChars, DEFAULTS.spokenMaxChars, 'a too-small spoken limit falls back to the default');
eq(
  repaired.repairs.map((repair) => repair.key).sort(),
  ['apiServerHost', 'apiServerPort', 'logLevel', 'spokenMaxChars', 'wakeupTimeout'],
  'every repaired field is reported by name',
);
eq(sanitizeConfig({ ...DEFAULTS }).repairs.length, 0, 'a usable section reports no repairs');

/** @param {object} patch @returns {boolean} whether the strict check refused it */
function refused(patch) {
  try {
    validateConfig({ ...DEFAULTS, ...patch });
    return false;
  } catch {
    return true;
  }
}
ok(refused({ wakeupTimeout: 20.5 }), 'a fractional wakeupTimeout is refused by the strict check');
ok(refused({ apiServerPort: 70000 }), 'an out-of-range port is refused by the strict check');
ok(refused({ apiServerHost: '' }), 'a blank host is refused by the strict check');
ok(!refused({}), 'a usable section passes the strict check');

console.log(failures === 0 ? '\nconfig check OK' : `\nconfig check FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
