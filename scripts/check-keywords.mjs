/**
 * Offline acceptance check for the wake-word hot-reload chain (plan 3.6 / 3.7).
 *
 * The settings card is only a real source of truth for wake words if changing
 * them reaches the running bridge, and there are three hops between the two:
 * the rendered `config.py` changes, `ConfigManager.reload_app_config()` notices
 * (the bridge's own watcher polls the file's mtime), and the KWS service
 * re-encodes `keywords.txt` and rebuilds its spotter. This script drives all
 * three with the bridge's own interpreter and a real keyword file.
 *
 * `core/models/keywords.txt` is a generated artifact outside git; it is backed
 * up here and restored, so running this never leaves the repository in a state
 * that disagrees with the checked-in template.
 *
 * Run: node scripts/check-keywords.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../lib/config.js';
import { writeConfig } from '../lib/render-config.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE_DIR = join(PACKAGE_ROOT, 'bridge');
const PYTHON = join(BRIDGE_DIR, '.venv', 'Scripts', 'python.exe');
const KEYWORDS_FILE = join(BRIDGE_DIR, 'core', 'models', 'keywords.txt');

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

if (!existsSync(KEYWORDS_FILE)) {
  console.error(`keywords file missing: ${KEYWORDS_FILE}`);
  process.exit(1);
}

const backup = readFileSync(KEYWORDS_FILE);
const original = backup.toString('utf8');
const workDir = mkdtempSync(join(tmpdir(), 'xiaoai-keywords-'));

try {
  const configA = join(workDir, 'config-a.py');
  const configB = join(workDir, 'config-b.py');
  writeConfig({ dataDir: workDir, templatePath: join(BRIDGE_DIR, 'config.py'), cfg: { ...DEFAULTS, wakeKeywords: '小爱小爱' }, path: configA });
  writeConfig({ dataDir: workDir, templatePath: join(BRIDGE_DIR, 'config.py'), cfg: { ...DEFAULTS, wakeKeywords: '你好小智\n测试唤醒词' }, path: configB });
  // Full-width separators have to split the same way the settings page does:
  // a keyword that still carries `，` is not a word sherpa can score, so it
  // would be dropped in silence and the speaker would never wake.
  const configC = join(workDir, 'config-c.py');
  writeConfig({ dataDir: workDir, templatePath: join(BRIDGE_DIR, 'config.py'), cfg: { ...DEFAULTS, wakeKeywords: '小爱小爱，小爱同学' }, path: configC });
  const renderedC = readFileSync(configC, 'utf8');
  ok(renderedC.includes('["小爱小爱", "小爱同学"]'), 'a full-width comma splits wake words in the rendered config');

  const probe = `
import json, os, shutil, sys
import core.services.audio.kws as kws_module
from core.utils.config import ConfigManager

# 真实运行时检测线程已经 start() 过；探针里手动补上这一步
kws_module.SherpaOnnx.start()
before_spotter = id(kws_module.SherpaOnnx.keyword_spotter)
before_keywords = list(kws_module.KWS.applied_keywords[0])

# 模拟插件原子替换 config.py：文件换了，桥接器自己轮询 mtime 后调用它
shutil.copyfile(os.environ["CONFIG_PATH_B"], os.environ["CONFIG_PATH"])
ConfigManager.instance().reload_app_config()

print(json.dumps({
    "before_keywords": before_keywords,
    "after_keywords": list(kws_module.KWS.applied_keywords[0]),
    "spotter_rebuilt": id(kws_module.SherpaOnnx.keyword_spotter) != before_spotter,
    "loaded_from": ConfigManager.instance().get_app_config("wakeup.keywords", []),
}, ensure_ascii=False))
`;
  const raw = execFileSync(PYTHON, ['-c', probe], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      CONFIG_PATH: configA,
      CONFIG_PATH_B: configB,
      DSH_ENABLE: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(raw.trim().split(/\r?\n/).pop());

  console.log('wake-word hot reload');
  ok(JSON.stringify(result.before_keywords) === JSON.stringify(['小爱小爱']), `starts from the rendered file (${JSON.stringify(result.before_keywords)})`);
  ok(JSON.stringify(result.after_keywords) === JSON.stringify(['你好小智', '测试唤醒词']), `follows the replacement file (${JSON.stringify(result.after_keywords)})`);
  ok(result.spotter_rebuilt === true, 'the KWS spotter was rebuilt, not just re-parameterised');

  const encoded = readFileSync(KEYWORDS_FILE, 'utf8');
  console.log(`keywords.txt now:\n${encoded.split('\n').filter(Boolean).map((line) => '    ' + line).join('\n')}`);
  ok(encoded.trim().length > 0, 'keywords.txt was regenerated');
  ok(encoded.includes('@你好小智'), 'the new wake word is encoded into the keyword file');
  ok(!encoded.includes('@小爱小爱'), 'the replaced wake word is gone from the keyword file');
  ok(JSON.stringify(result.loaded_from) === JSON.stringify(['你好小智', '测试唤醒词']), 'the reload actually re-executed the generated config');
} finally {
  writeFileSync(KEYWORDS_FILE, backup);
  rmSync(workDir, { recursive: true, force: true });
}

const restored = readFileSync(KEYWORDS_FILE, 'utf8');
ok(restored === original, 'the repository keyword file was restored');

console.log(failures === 0 ? '\nkeyword check OK' : `\nkeyword check FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
