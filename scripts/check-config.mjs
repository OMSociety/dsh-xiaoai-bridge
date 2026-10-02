/**
 * Offline acceptance checks for lib/render-config.js.
 *
 * The renderer only matters if the *bridge* agrees with it, so the central case
 * here does not inspect the generated source as text: it renders a config with
 * deliberately unusual settings, then runs the bridge's own interpreter with
 * `CONFIG_PATH` pointing at the result and compares the values the Python side
 * actually loaded.
 *
 * Run: node scripts/check-config.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../lib/config.js';
import {
  GENERATED_HEADER,
  buildOverrides,
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
eq(splitList(''), [], 'empty text');
eq(splitList(undefined), [], 'absent text');

console.log('render-config: overrides');
const bare = buildOverrides({ ...DEFAULTS, wakeKeywords: '', exitKeywords: '', sessionKey: '', deviceName: '', ttsSpeaker: '', wakeupReplyText: '', exitReplyText: '', fallbackText: '', voiceRuleText: '', asrBackend: '' });
// Two keys are always written because the plugin owns them outright: the
// conversation timeout (same 20 seconds as the template) and the single-shot
// switch, whose false default is the documented behavior.
eq(bare, { wakeup: { timeout: DEFAULTS.wakeupTimeout }, dsh: { continuous_conversation: DEFAULTS.continuousConversation } }, 'emptied fields fall back to the template default');
const full = buildOverrides({
  ...DEFAULTS,
  wakeKeywords: '你好小智\n小爱小爱',
  exitKeywords: '退出,再见',
  wakeupTimeout: 33,
  sessionKey: 'agent:butler:open-xiaoai-bridge',
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
eq(full.dsh.session_key, 'agent:butler:open-xiaoai-bridge', 'dsh.session_key');
eq(full.dsh.tts_speaker, 'zh_female_1', 'dsh.tts_speaker');
eq(full.dsh.wakeup_reply, '在呢', 'dsh.wakeup_reply');
eq(full.dsh.exit_reply, '拜拜', 'dsh.exit_reply');
eq(full.dsh.fallback_text, '电脑睡了', 'dsh.fallback_text');
eq(full.dsh.rule_prompt_for_skill, DEFAULTS.voiceRuleText, 'dsh.rule_prompt_for_skill');
eq(full.dsh.continuous_conversation, false, 'dsh.continuous_conversation follows the page default');
eq(
  buildOverrides({ ...DEFAULTS, continuousConversation: true }).dsh.continuous_conversation,
  true,
  'dsh.continuous_conversation flips with the switch',
);
// The provider follows the switch, but only for a provider the bridge can load:
// an empty choice keeps the router's own voice-id rule, and the reserved `mimo`
// choice must never reach the bridge, which would raise on it.
ok(!('tts_provider' in bare.dsh), 'an empty provider choice writes nothing');
eq(buildOverrides({ ...DEFAULTS, ttsProvider: 'xiaoai' }).dsh.tts_provider, 'xiaoai', 'the native provider is written');
ok(!('tts_provider' in buildOverrides({ ...DEFAULTS, ttsProvider: 'mimo' }).dsh), 'the reserved provider is not written');
const reservist = buildOverrides({
  ...DEFAULTS,
  ttsProvider: 'mimo',
  mimoBaseUrl: 'https://mimo.invalid/v1/audio/speech',
  mimoApiKeyCredential: 'MIMO_API_KEY',
  mimoModel: 'mimo-tts',
  mimoVoice: 'zh_female_1',
});
ok(!Object.keys(reservist.dsh).some((key) => key.includes('mimo')), 'the MiMo placeholders stay out of the bridge config');
eq(full.asr.model, 'paraformer', 'asr.model');

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
      sessionKey: 'agent:butler:open-xiaoai-bridge',
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
  eq(loaded.dsh_session_key, 'agent:butler:open-xiaoai-bridge', 'dsh.session_key');
  eq(loaded.dsh_device_name, '客厅音箱', 'dsh.device_name');
  eq(loaded.dsh_tts_speaker, 'zh_female_1', 'dsh.tts_speaker');
  eq(loaded.dsh_wakeup_reply, '在呢', 'dsh.wakeup_reply');
  eq(loaded.dsh_exit_reply, '拜拜', 'dsh.exit_reply');
  eq(loaded.dsh_fallback_text, '电脑睡了', 'dsh.fallback_text');
  eq(loaded.dsh_continuous_conversation, true, 'the switch reaches the bridge as a real boolean');
  eq(loaded.dsh_tts_provider, 'xiaoai', 'the provider switch reaches the bridge as a string');
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
  ok(!sparseSource.includes('mimo'), 'the reserved MiMo fields never reach the generated file');
  ok(!sparseSource.includes('response_timeout'), 'template-only keys are never restated in the generated file');
  ok(!sparseSource.includes('doubao'), 'untouched sections stay out of the generated file');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nconfig check OK' : `\nconfig check FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
