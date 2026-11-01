#!/usr/bin/env node
/**
 * 九个离线自检脚本的聚合入口。
 *
 * 用法：在仓库根执行 `npm run check`（等价于 `node scripts/check-all.mjs`）。
 *
 * 行为：按固定顺序显式列出并逐个 spawn 这九个脚本，标准输出/错误直接透传，
 * 全部跑完后汇总结果并分类报数：通过 / 跳过 / 未通过。跳过只代表缺前置
 * （`bridge/.venv`、模型包这类不入库的东西，脚本自己会打印补救命令），
 * 只有未通过才让本脚本以非 0 退出。
 * 之所以不写成 glob 通配，是为了让"有几个检查、叫什么名字"这件事在源码里可读，
 * 也让漏掉一个脚本时能被 review 发现。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKIP_EXIT_CODE } from './prereq.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

/** 检查脚本的文件名，顺序即执行顺序（与 AGENTS.md / CONTRIBUTING.md 的列表一致）。 */
const CHECKERS = [
  'check-client.mjs',
  'check-config.mjs',
  'check-keywords.mjs',
  'check-session.mjs',
  'check-supervisor.mjs',
  'check-speak.mjs',
  'check-diagnostics.mjs',
  'check-http.mjs',
  'check-cleanup.mjs',
];

/** @type {string[]} */
const passed = [];
/** @type {string[]} 缺前置、本项没跑（脚本以 SKIP_EXIT_CODE 退出） */
const skipped = [];
/** @type {string[]} 真失败或无法启动 */
const failed = [];
/** @type {string[]} 脚本文件本身不存在 */
const missing = [];

for (const name of CHECKERS) {
  const script = join(HERE, name);
  process.stdout.write(`\n===== ${name} =====\n`);
  const result = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      missing.push(name);
      process.stderr.write(`[check-all] 找不到 ${name}：${result.error.message}\n`);
    } else {
      failed.push(name);
      process.stderr.write(`[check-all] 无法启动 ${name}：${result.error.message}\n`);
    }
    continue;
  }
  if (result.status === SKIP_EXIT_CODE) {
    skipped.push(name);
    process.stderr.write(`[check-all] ${name} 跳过（缺前置，补救命令见上）\n`);
    continue;
  }
  if (result.status !== 0) {
    failed.push(name);
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    process.stderr.write(`[check-all] ${name} 失败（${how}）\n`);
    continue;
  }
  passed.push(name);
}

const bad = [...missing, ...failed];
const tally = `${CHECKERS.length} 个检查：${passed.length} 项通过 / ${skipped.length} 项跳过 / ${bad.length} 项未通过`;
if (bad.length > 0) {
  process.stderr.write(`\n[check-all] ${tally}：${bad.join(', ')}\n`);
  process.exit(1);
}
if (skipped.length > 0) {
  process.stdout.write(`\n[check-all] ${tally}。\n`);
  process.stdout.write(`[check-all] 跳过的是缺前置的项，补齐后重跑即可：${skipped.join(', ')}\n`);
  process.exit(0);
}

process.stdout.write(`\n[check-all] 全部 ${CHECKERS.length} 个检查通过。\n`);
