/**
 * Focused check for the speaking path: lib/speech-log.js, lib/replyer.js,
 * lib/auto-speak.js and the `xiaoai_speak` tool that shares their turn state.
 *
 * The behaviour under test is the one that is invisible in the GUI: an utterance
 * that came in through the speaker must be answered through the speaker, the
 * agent's screen-shaped answer must be reworded for the ear, and exactly one
 * line must come out per turn no matter how many steps the turn had or whether
 * the agent called the tool by itself.
 *
 * Run: node scripts/check-speak.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createSpokenLog, spokenLogPath, SPOKEN_LOG_FILE, SPOKEN_LOG_ROTATED_FILE, SPOKEN_LOG_MAX_BYTES } = await import(
  new URL('../lib/speech-log.js', import.meta.url).href
);
const { truncateSpokenText, resolveReplyerRoute, buildReplyerPrompts, replyerMessages, buildCondensePrompts, createReplyer } = await import(
  new URL('../lib/replyer.js', import.meta.url).href
);
const { createAutoSpeak, DEFAULT_FAILURE_TEXT, DEFAULT_APPROVAL_TEXT } = await import(new URL('../lib/auto-speak.js', import.meta.url).href);
const { createSpeakTool, SPEAK_TOOL_NAME, SPEAK_TOOL_DESCRIPTION } = await import(new URL('../lib/tools.js', import.meta.url).href);
const { DEFAULTS } = await import(new URL('../lib/config.js', import.meta.url).href);

const dataDir = mkdtempSync(join(tmpdir(), 'xiaoai-speak-check-'));
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

/** @param {Array<object>} chunks @returns {AsyncIterable<object>} a fake stream */
async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk;
}

/** One text-delta plus a terminal finish chunk. */
const say = (text) => [{ type: 'text-delta', index: 0, text }, { type: 'finish', reason: { kind: 'stop' } }];

/** Wait until `predicate()` holds (auto-speak drains fire-and-forget). */
async function until(predicate, label) {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const quiet = { info: () => {}, warn: () => {}, debug: () => {} };

// --- speech log: one JSON object per line ----------------------------------
console.log('speech log');
const log = createSpokenLog({ dataDir, logger: quiet });
await log.write({ time: 't', device: 'dev', intent: 'i', spoken: 's', provider: 'p', model: 'm', source: 'replyer' });
const logged = readFileSync(spokenLogPath(dataDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
await check('the log lands under <dataDir>/spoken.jsonl', () => {
  assert.equal(SPOKEN_LOG_FILE, 'spoken.jsonl');
  assert.equal(spokenLogPath(dataDir), join(dataDir, 'spoken.jsonl'));
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], { time: 't', device: 'dev', intent: 'i', spoken: 's', provider: 'p', model: 'm', source: 'replyer' });
});

// --- speech log: the file has a ceiling, the history has one slot ----------
console.log('speech log: rotation');
const rotatedDir = mkdtempSync(join(tmpdir(), 'xiaoai-speak-rotate-'));
const line = { time: 't', device: 'dev', intent: 'i', spoken: 'x'.repeat(80), provider: 'p', model: 'm', source: 'replyer' };
const small = createSpokenLog({ dataDir: rotatedDir, logger: quiet, maxBytes: 2000 });
for (let i = 0; i < 30; i += 1) await small.write(line);
await check('the shipped cap is 5 MiB', () => {
  assert.equal(SPOKEN_LOG_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(SPOKEN_LOG_ROTATED_FILE, 'spoken.jsonl.1');
});
await check('the live file never grows past its cap', () => {
  assert.ok(statSync(spokenLogPath(rotatedDir)).size <= 2000, 'the live log is over the cap');
});
await check('size() reports the live file, which is what the card shows', async () => {
  assert.equal(await small.size(), statSync(spokenLogPath(rotatedDir)).size);
});
await check('the older lines moved to the single rotation slot', () => {
  const old = readFileSync(join(rotatedDir, SPOKEN_LOG_ROTATED_FILE), 'utf8').trim().split('\n');
  assert.ok(old.length >= 1, 'the rotation slot is empty');
  assert.ok(old.length < 30, 'the rotation slot kept every line, so nothing rotated');
});
await check('a second rotation replaces the slot instead of piling up', async () => {
  // A different payload in the second round, so "the slot changed" is a
  // statement about the rotation rather than about the line content.
  const marked = { ...line, spoken: 'y'.repeat(80) };
  for (let i = 0; i < 30; i += 1) await small.write(marked);
  const after = readFileSync(join(rotatedDir, SPOKEN_LOG_ROTATED_FILE), 'utf8');
  assert.ok(after.includes('yyyy'), 'the slot still holds the previous generation');
  assert.ok(statSync(join(rotatedDir, SPOKEN_LOG_ROTATED_FILE)).size <= 2000, 'the slot grew past the cap');
});
rmSync(rotatedDir, { recursive: true, force: true });

// --- replyer: pure prompt and route decisions ------------------------------
console.log('replyer: prompts and routes');
await check('a line inside the limit is returned untouched', () => {
  assert.equal(truncateSpokenText('你好呀', 10), '你好呀');
});
await check('an over-long line is cut at a sentence end, not mid-sentence', () => {
  assert.equal(truncateSpokenText('你好你好。世界', 6), '你好你好。');
});
await check('a line with no early sentence end is cut and marked with an ellipsis', () => {
  assert.equal(truncateSpokenText('一二三四五六七八九十', 5), '一二三四五…');
});
await check('an empty override follows the session model', () => {
  assert.deepEqual(resolveReplyerRoute({}, { provider: 'sp', model: 'sm' }), { provider: 'sp', model: 'sm', source: 'session' });
});
await check('both overrides win over the session model', () => {
  assert.deepEqual(
    resolveReplyerRoute({ replyerProvider: 'op', replyerModel: 'om' }, { provider: 'sp', model: 'sm' }),
    { provider: 'op', model: 'om', source: 'settings' },
  );
});
await check('a half override is reported as mixed', () => {
  assert.deepEqual(
    resolveReplyerRoute({ replyerProvider: 'op', replyerModel: '' }, { provider: 'sp', model: 'sm' }),
    { provider: 'op', model: 'sm', source: 'mixed' },
  );
});
await check('a route with no model on either side is none', () => {
  assert.deepEqual(resolveReplyerRoute({}, null), { provider: '', model: '', source: 'none' });
});
const prompts = buildReplyerPrompts({
  intent: '答案是 42',
  history: [{ role: 'user', text: '一个问题' }, { role: 'assistant', text: '一个回答' }],
  cfg: { personality: '你很耐心', replyStyle: '慢慢说', outputLimits: '不要 emoji' },
});
await check('the system prompt carries personality, style and output limits', () => {
  assert.match(prompts.system, /你很耐心/);
  assert.match(prompts.system, /慢慢说/);
  assert.match(prompts.system, /不要 emoji/);
});
await check('the shipped defaults carry the identity, the speaking style and the limits', () => {
  const defaults = buildReplyerPrompts({ intent: 'i', history: [], cfg: DEFAULTS });
  assert.match(defaults.system, /语音助手/);
  assert.match(defaults.system, /说话风格：用日常、口语化的说法讲出来/);
  assert.match(defaults.system, /不要 emoji/);
  assert.equal(defaults.system.includes('关于你自己：'), false, 'the shipped persona is not restated');
});
await check('the user prompt carries the transcript and the intent', () => {
  assert.match(prompts.user, /用户：一个问题/);
  assert.match(prompts.user, /你：一个回答/);
  assert.match(prompts.user, /【要表达的意图】\n答案是 42/);
});
await check('split mode sends a system message, combined mode sends one user message', () => {
  assert.deepEqual(replyerMessages(prompts, 'split').map((m) => m.role), ['system', 'user']);
  assert.deepEqual(replyerMessages(prompts, 'combined').map((m) => m.role), ['user']);
  assert.match(replyerMessages(prompts, 'combined')[0].content[0].text, /答案是 42/);
});
await check('the shortening prompt names the limit and the draft', () => {
  const condense = buildCondensePrompts({ draft: '很长的草稿', intent: 'i', history: [], cfg: {}, maxChars: 40 });
  assert.match(condense.user, /40 个字以内/);
  assert.match(condense.user, /很长的草稿/);
  assert.match(condense.system, /语音助手/);
});

// --- replyer: the model call ------------------------------------------------
console.log('replyer: the model call');
/** A fake llm whose stream is scripted per call. */
function fakeCtx(script) {
  const calls = [];
  return {
    calls,
    ctx: {
      get: (name) => (name === 'llm' ? {
        stream(options) {
          calls.push(options);
          return streamOf(script(options, calls.length));
        },
      } : undefined),
    },
  };
}

const l1 = fakeCtx(() => say('念出来的话'));
const replyer1 = createReplyer({ ctx: l1.ctx, logger: quiet });
const ok1 = await replyer1.generate({ intent: 'intent', history: [], cfg: {}, fallbackRoute: { provider: 'p', model: 'm' } });
await check('a working route returns the spoken line and the route it used', () => {
  assert.equal(ok1.ok, true);
  assert.equal(ok1.text, '念出来的话');
  assert.equal(ok1.provider, 'p');
  assert.equal(ok1.model, 'm');
  assert.equal(ok1.source, 'session');
});

const l2 = fakeCtx((options, call) => (call === 1
  ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }]
  : say('第二次成功了')));
const replyer2 = createReplyer({ ctx: l2.ctx, logger: quiet });
const ok2 = await replyer2.generate({ intent: 'i', history: [], cfg: {}, fallbackRoute: { provider: 'p', model: 'm' } });
await check('a failed first attempt is retried once and the retry is used', () => {
  assert.equal(ok2.ok, true);
  assert.equal(ok2.text, '第二次成功了');
  assert.equal(l2.calls.length, 2);
  assert.equal(l2.calls[0].messages[0].role, 'system');
  assert.equal(l2.calls[1].messages[0].role, 'user', 'the retry folds the system prompt into one user message');
});

const l3 = fakeCtx((options) => {
  const combined = options.messages.map((m) => m.content[0].text).join('\n');
  return combined.includes('【草稿】') ? say('短句') : say('这是一句特别特别长的话，长到必须压缩才念得完。');
});
const replyer3 = createReplyer({ ctx: l3.ctx, logger: quiet });
const ok3 = await replyer3.generate({ intent: 'i', history: [], cfg: { spokenMaxChars: 5 }, fallbackRoute: { provider: 'p', model: 'm' } });
await check('an over-long first answer is shortened once and fits the limit', () => {
  assert.equal(ok3.ok, true);
  assert.equal(ok3.text, '短句');
  assert.equal(l3.calls.length, 2);
});

const l4 = fakeCtx((options) => {
  const combined = options.messages.map((m) => m.content[0].text).join('\n');
  return combined.includes('【草稿】') ? say('这句压缩后还是很长很长很长') : say('这是一句特别特别长的话，长到必须压缩才念得完。');
});
const replyer4 = createReplyer({ ctx: l4.ctx, logger: quiet });
const ok4 = await replyer4.generate({ intent: 'i', history: [], cfg: { spokenMaxChars: 5 }, fallbackRoute: { provider: 'p', model: 'm' } });
await check('a still-too-long draft is truncated rather than spoken whole', () => {
  assert.equal(ok4.ok, true);
  assert.ok(ok4.text.length <= 6, ok4.text);
});

const l5 = fakeCtx(() => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }]);
const replyer5 = createReplyer({ ctx: l5.ctx, logger: quiet });
const bad5 = await replyer5.generate({ intent: 'i', history: [], cfg: {}, fallbackRoute: { provider: 'p', model: 'm' } });
await check('a broken route reports failure instead of inventing text', () => {
  assert.equal(bad5.ok, false);
  assert.equal(bad5.reason, 'failure');
  assert.match(bad5.error, /RATE_LIMIT/);
  assert.equal(l5.calls.length, 2, 'the retry happened before giving up');
});

const replyer6 = createReplyer({ ctx: { get: () => undefined }, logger: quiet });
const bad6 = await replyer6.generate({ intent: 'i', history: [], cfg: {}, fallbackRoute: null });
await check('no route at all is reported as no-route, not as a failure', () => {
  assert.equal(bad6.ok, false);
  assert.equal(bad6.reason, 'no-route');
});

// --- auto-speak: one line per turn ------------------------------------------
console.log('auto-speak: one line per turn');
/** A bridge that records what it was asked to say. */
function fakeBridge() {
  const spoken = [];
  return {
    spoken,
    playText: async (text) => { spoken.push(text); return { ok: true }; },
  };
}

function harness(overrides = {}, replyerOverrides = {}) {
  const cfg = { autoSpeak: true, replyerHistoryTurns: 6, spokenMaxChars: 300, replyerFailureText: '念不出来', ...overrides };
  const bridge = fakeBridge();
  const records = [];
  const calls = [];
  const autoSpeak = createAutoSpeak({
    getConfig: () => cfg,
    bridge,
    replyer: {
      generate: async (input) => {
        // Copy: the live history array keeps growing after this call, and the
        // assertions are about what the generator saw at the time.
        calls.push({ ...input, history: [...input.history] });
        return { ok: true, text: `说：${input.intent}`, provider: 'p', model: 'm' };
      },
      ...replyerOverrides,
    },
    spokenLog: { write: async (record) => { records.push(record); } },
    sessionRoute: (sessionId) => ({ provider: `sp-${sessionId}`, model: 'sm' }),
    logger: quiet,
  });
  return { cfg, bridge, records, calls, autoSpeak };
}

const S1 = 'session-speak-1';
const h1 = harness();
h1.autoSpeak.onUtterance({ sessionId: S1, deviceKey: 'dev-1', text: '你好' });
h1.autoSpeak.onAssistantText(S1, '第一版草稿');
h1.autoSpeak.onAssistantText(S1, '最终版草稿');
h1.autoSpeak.onTurnEnd(S1);
await until(() => h1.records.length === 1, 'the first line to be spoken');
await check('the newest draft of the turn is the one that gets spoken', () => {
  assert.deepEqual(h1.bridge.spoken, ['说：最终版草稿']);
  assert.equal(h1.calls[0].intent, '最终版草稿');
  assert.equal(h1.calls[0].history.length, 1, 'the utterance is the only history entry before the reply');
  assert.equal(h1.calls[0].fallbackRoute.provider, `sp-${S1}`);
});
await check('the spoken line is logged with the intent it came from', () => {
  assert.equal(h1.records.length, 1);
  assert.deepEqual(h1.records[0], {
    time: h1.records[0].time,
    device: 'dev-1',
    intent: '最终版草稿',
    spoken: '说：最终版草稿',
    provider: 'p',
    model: 'm',
    source: 'replyer',
  });
  assert.match(h1.records[0].time, /^\d{4}-\d{2}-\d{2}T/);
});
h1.autoSpeak.onUtterance({ sessionId: S1, deviceKey: 'dev-1', text: '然后呢' });
h1.autoSpeak.onAssistantText(S1, '接着讲');
h1.autoSpeak.onTurnEnd(S1);
await until(() => h1.records.length === 2, 'the second line to be spoken');
await check('the next turn sees the spoken line as history', () => {
  assert.deepEqual(h1.calls[1].history, [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '说：最终版草稿' },
    { role: 'user', text: '然后呢' },
  ]);
});

const h2 = harness();
h2.autoSpeak.onUtterance({ sessionId: 'session-speak-2', deviceKey: 'dev-2', text: '念这个' });
h2.autoSpeak.onAssistantText('session-speak-2', '我本来想说这句');
h2.autoSpeak.onToolCall('session-speak-2', SPEAK_TOOL_NAME);
h2.autoSpeak.onTurnEnd('session-speak-2');
await check('a turn the agent spoke through the tool is not spoken again', () => {
  assert.deepEqual(h2.bridge.spoken, []);
  assert.deepEqual(h2.records, []);
});

const h3 = harness();
h3.autoSpeak.onUtterance({ sessionId: 'session-speak-3', deviceKey: 'dev-3', text: '你好' });
const claimA = h3.autoSpeak.claimToolSpeak('session-speak-3');
const claimB = h3.autoSpeak.claimToolSpeak('session-speak-3');
h3.autoSpeak.onTurnEnd('session-speak-3');
await check('the tool may speak once per turn and the repeat is refused', () => {
  assert.deepEqual(claimA, { allowed: true });
  assert.deepEqual(claimB, { allowed: false, reason: 'already' });
  assert.deepEqual(h3.bridge.spoken, [], 'a tool turn is never auto-spoken as well');
});
await check('a session with no voice turn in flight is never blocked', () => {
  assert.deepEqual(h3.autoSpeak.claimToolSpeak('session-desktop'), { allowed: true });
  assert.deepEqual(h3.autoSpeak.claimToolSpeak(undefined), { allowed: true });
});

const h4 = harness({ autoSpeak: false });
h4.autoSpeak.onUtterance({ sessionId: 'session-speak-4', deviceKey: 'dev-4', text: '你好' });
h4.autoSpeak.onAssistantText('session-speak-4', '不该念');
h4.autoSpeak.onTurnEnd('session-speak-4');
await check('autoSpeak off means the speaker stays quiet', () => {
  assert.deepEqual(h4.bridge.spoken, []);
  assert.deepEqual(h4.records, []);
});

const h5 = harness();
h5.autoSpeak.onAssistantText('session-never-heard', '桌面会话的文本');
h5.autoSpeak.onTurnEnd('session-never-heard');
await check('a turn nobody spoke into is left alone', () => {
  assert.deepEqual(h5.bridge.spoken, []);
  assert.deepEqual(h5.calls, []);
});

const h6 = harness();
h6.autoSpeak.onUtterance({ sessionId: 'session-speak-6', deviceKey: 'dev-6', text: '你好' });
h6.autoSpeak.onTurnEnd('session-speak-6');
await check('a turn whose answer carried no text says nothing', () => {
  assert.deepEqual(h6.bridge.spoken, []);
});

const h7 = harness({}, { generate: async () => ({ ok: false, error: 'boom', reason: 'failure' }) });
h7.autoSpeak.onUtterance({ sessionId: 'session-speak-7', deviceKey: 'dev-7', text: '你好' });
h7.autoSpeak.onAssistantText('session-speak-7', '正文');
h7.autoSpeak.onTurnEnd('session-speak-7');
await until(() => h7.records.length === 1, 'the failure line');
await check('a broken reply generator says so instead of reading the raw answer', () => {
  assert.deepEqual(h7.bridge.spoken, ['念不出来']);
  assert.equal(h7.records[0].source, 'failure');
  assert.equal(h7.records[0].intent, '正文');
});
await check('the built-in failure line is used when the setting is blank', () => {
  assert.equal(DEFAULT_FAILURE_TEXT, '回复器调用失败');
});

const h8 = harness({ spokenMaxChars: 4 }, { generate: async () => ({ ok: false, error: 'no route', reason: 'no-route' }) });
h8.autoSpeak.onUtterance({ sessionId: 'session-speak-8', deviceKey: 'dev-8', text: '你好' });
h8.autoSpeak.onAssistantText('session-speak-8', '一二三四五六七八');
h8.autoSpeak.onTurnEnd('session-speak-8');
await until(() => h8.bridge.spoken.length === 1, 'the raw fallback line');
await check('a missing route speaks the agent text (bounded) rather than a failure line', () => {
  assert.deepEqual(h8.bridge.spoken, ['一二三四…']);
});

const h9 = harness({ replyerHistoryTurns: 1 });
h9.autoSpeak.onUtterance({ sessionId: 'session-speak-9', deviceKey: 'dev-9', text: '一' });
h9.autoSpeak.onAssistantText('session-speak-9', '二');
h9.autoSpeak.onTurnEnd('session-speak-9');
// Turns are minutes apart in reality; settling in between is what keeps the
// transcript a transcript instead of a race between two drains.
await until(() => h9.records.length === 1, 'the first history-capped line');
h9.autoSpeak.onUtterance({ sessionId: 'session-speak-9', deviceKey: 'dev-9', text: '三' });
h9.autoSpeak.onAssistantText('session-speak-9', '四');
h9.autoSpeak.onTurnEnd('session-speak-9');
await until(() => h9.records.length === 2, 'the second history-capped line');
await check('history is trimmed to the configured number of turns', () => {
  assert.deepEqual(h9.calls[1].history, [
    { role: 'assistant', text: '说：二' },
    { role: 'user', text: '三' },
  ]);
});
const h9b = harness({ replyerHistoryTurns: 0 });
h9b.autoSpeak.onUtterance({ sessionId: 'session-speak-9b', deviceKey: 'dev-9b', text: '一' });
h9b.autoSpeak.onAssistantText('session-speak-9b', '二');
h9b.autoSpeak.onTurnEnd('session-speak-9b');
await until(() => h9b.records.length === 1, 'the no-history line');
await check('zero turns of history means the reply generator sees no transcript', () => {
  assert.deepEqual(h9b.calls[0].history, []);
});

const h10 = harness();
h10.autoSpeak.onUtterance({ sessionId: 'session-speak-10', deviceKey: 'dev-10', text: '你好' });
h10.autoSpeak.dispose();
h10.autoSpeak.onTurnEnd('session-speak-10');
await check('dispose drops every tracked turn', () => {
  assert.deepEqual(h10.autoSpeak.snapshot(), []);
  assert.deepEqual(h10.bridge.spoken, []);
});

// --- approvals: the one line, never the payload -----------------------------
console.log('approvals');

const a1 = harness({ approvalText: '到电脑上点一下' });
const A1 = 'session-approval-1';
a1.autoSpeak.onUtterance({ sessionId: A1, deviceKey: 'dev-a1', text: '帮我把那个临时文件删了' });
a1.autoSpeak.onAssistantText(A1, '我要运行 rm --force /tmp/x，请批准');
a1.autoSpeak.onApprovalAsked(A1, { id: 'ap-1', toolName: 'Bash', reason: 'rm --force /tmp/x' });
await until(() => a1.records.length === 1, 'the approval line');
await check('an approval says only where to go, never the payload', () => {
  assert.deepEqual(a1.bridge.spoken, ['到电脑上点一下']);
  assert.deepEqual(a1.calls, [], 'the approval line is not reworded by the reply generator');
  assert.deepEqual(a1.records[0], {
    time: a1.records[0].time,
    device: 'dev-a1',
    intent: 'approval: Bash',
    spoken: '到电脑上点一下',
    provider: '',
    model: '',
    source: 'approval',
  });
});
a1.autoSpeak.onApprovalAsked(A1, { id: 'ap-2', toolName: 'Bash', reason: 'rm --force /tmp/y' });
await check('a second approval in the same turn does not send the user twice', () => {
  assert.deepEqual(a1.bridge.spoken, ['到电脑上点一下']);
  assert.equal(a1.records.length, 1);
});
a1.autoSpeak.onAssistantText(A1, '删掉了');
a1.autoSpeak.onTurnEnd(A1);
await until(() => a1.records.length === 2, 'the post-approval answer');
await check('the pre-approval draft is dropped and the answer after it is spoken', () => {
  assert.deepEqual(a1.bridge.spoken, ['到电脑上点一下', '说：删掉了']);
  assert.equal(a1.records[1].source, 'replyer');
  assert.equal(a1.records[1].intent, '删掉了');
});

const a2 = harness();
const A2 = 'session-approval-2';
a2.autoSpeak.onUtterance({ sessionId: A2, deviceKey: 'dev-a2', text: '你好' });
a2.autoSpeak.onAssistantText(A2, '这句不该被念出来');
a2.autoSpeak.onApprovalAsked(A2, { id: 'ap-3', toolName: 'Write' });
a2.autoSpeak.onTurnEnd(A2);
await until(() => a2.records.length === 1, 'the built-in approval line');
await check('the built-in approval line is used when the setting is blank', () => {
  assert.equal(DEFAULT_APPROVAL_TEXT, '需要你到电脑上确认一下');
  assert.deepEqual(a2.bridge.spoken, ['需要你到电脑上确认一下']);
  assert.equal(a2.records[0].source, 'approval');
  assert.equal(a2.calls.length, 0, 'an approval-only turn never reaches the reply generator');
});

const a3 = harness({ autoSpeak: false });
const A3 = 'session-approval-3';
a3.autoSpeak.onUtterance({ sessionId: A3, deviceKey: 'dev-a3', text: '你好' });
a3.autoSpeak.onApprovalAsked(A3, { id: 'ap-4', toolName: 'Bash' });
a3.autoSpeak.onTurnEnd(A3);
await check('with autoSpeak off an approval stays silent too', () => {
  assert.deepEqual(a3.bridge.spoken, []);
  assert.deepEqual(a3.records, []);
});

const a4 = harness();
a4.autoSpeak.onApprovalAsked('session-never-heard', { id: 'ap-5', toolName: 'Bash' });
await check('an approval from a session the speaker never opened is ignored', () => {
  assert.deepEqual(a4.bridge.spoken, []);
  assert.deepEqual(a4.records, []);
});

// --- the tool shares that turn state ---------------------------------------
console.log('xiaoai_speak tool');
await check('the description tells the model its reply is spoken for it', () => {
  assert.match(SPEAK_TOOL_DESCRIPTION, /自动念出来/);
  assert.match(SPEAK_TOOL_DESCRIPTION, /不需要/);
  assert.match(SPEAK_TOOL_DESCRIPTION, /逐字/);
});

function toolHarness({ cfg = {}, claim = { allowed: true } } = {}) {
  const played = [];
  const noted = [];
  const claims = [];
  const tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true, ...cfg }),
    bridge: { playText: async (text) => { played.push(text); return { ok: true }; } },
    sessions: {
      deviceForSession: () => ({ key: 'dev', host: '192.168.1.191', name: '小爱音箱' }),
      primaryDevice: () => null,
    },
    autoSpeak: {
      claimToolSpeak: (sessionId) => { claims.push(sessionId); return claim; },
      noteSpoken: async (record) => { noted.push(record); },
    },
    logger: quiet,
  });
  return { tool, played, noted, claims };
}

const t1 = toolHarness();
const r1 = await t1.tool.execute({ text: '念这句' }, { agent: { session: { id: 'session-tool-1' } } });
await check('the tool speaks, claims the turn and logs the line', () => {
  assert.deepEqual(t1.played, ['念这句']);
  assert.deepEqual(t1.claims, ['session-tool-1']);
  assert.deepEqual(r1, { text: '已让小爱音箱念出：念这句' });
  assert.equal(t1.noted.length, 1);
  assert.deepEqual(t1.noted[0], { sessionId: 'session-tool-1', deviceKey: 'dev', intent: '念这句', spoken: '念这句', source: 'tool' });
});

const t2 = toolHarness({ claim: { allowed: false, reason: 'already' } });
const r2 = await t2.tool.execute({ text: '再念一次' }, { agent: { session: { id: 'session-tool-2' } } });
await check('a repeated call in one turn is refused, not spoken over', () => {
  assert.deepEqual(t2.played, []);
  assert.deepEqual(t2.noted, []);
  assert.match(r2.text, /忽略/);
  assert.notEqual(r2.isError, true, 'being ignored is not a tool error to recover from');
});

const t3 = toolHarness();
const r3 = await t3.tool.execute({ text: '   ' }, {});
await check('an empty text is refused', () => {
  assert.equal(r3.isError, true);
  assert.deepEqual(t3.played, []);
});
await check('the plugin being disabled, or the API server off, refuses the call', async () => {
  const off = toolHarness({ cfg: { enabled: false } });
  const denied = await off.tool.execute({ text: 'x' }, {});
  assert.equal(denied.isError, true);
  assert.deepEqual(off.played, []);
  const api = toolHarness({ cfg: { apiServerEnabled: false } });
  const noApi = await api.tool.execute({ text: 'x' }, {});
  assert.equal(noApi.isError, true);
  assert.deepEqual(api.played, []);
});
await check('a playback failure is reported, and nothing is logged as spoken', async () => {
  const failing = toolHarness();
  failing.tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true }),
    bridge: { playText: async () => ({ ok: false, error: 'bridge refused' }) },
    sessions: { deviceForSession: () => ({ key: 'dev' }), primaryDevice: () => null },
    autoSpeak: { claimToolSpeak: () => ({ allowed: true }), noteSpoken: async () => { throw new Error('must not be called'); } },
    logger: quiet,
  });
  const result = await failing.tool.execute({ text: '念这句' }, { agent: { session: { id: 'session-tool-fail' } } });
  assert.equal(result.isError, true);
  assert.match(result.text, /bridge refused/);
});

await check('a session the speaker did not start cannot make the speaker talk', async () => {
  const played = [];
  const claims = [];
  const tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true }),
    bridge: { playText: async (text) => { played.push(text); return { ok: true }; } },
    sessions: { deviceForSession: () => null, primaryDevice: () => ({ key: 'fallback', name: '小爱音箱' }) },
    autoSpeak: {
      claimToolSpeak: (sessionId) => { claims.push(sessionId); return { allowed: true }; },
      noteSpoken: async () => { throw new Error('must not be called'); },
    },
    logger: quiet,
  });
  const refused = await tool.execute({ text: '念这句' }, { agent: { session: { id: 'session-desktop' } } });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /小爱音箱发起的对话/);
  assert.deepEqual(played, [], 'a refused call must not play anything');
  assert.deepEqual(claims, [], 'a refused call must not claim the turn');
});

await check('speakFromAnySession opens the tool to sessions with no speaker', async () => {
  const played = [];
  const noted = [];
  const tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true, speakFromAnySession: true }),
    bridge: { playText: async (text) => { played.push(text); return { ok: true }; } },
    sessions: { deviceForSession: () => null, primaryDevice: () => ({ key: 'fallback', name: '小爱音箱' }) },
    autoSpeak: { claimToolSpeak: () => ({ allowed: true }), noteSpoken: async (record) => { noted.push(record); } },
    logger: quiet,
  });
  const result = await tool.execute({ text: '水开了' }, { agent: { session: { id: 'session-desktop-open' } } });
  assert.deepEqual(played, ['水开了']);
  assert.notEqual(result.isError, true);
  assert.equal(noted.length, 1);
  assert.equal(noted[0].deviceKey, 'fallback', 'the opt-in falls back to the first configured device');
});

await check('a non-boolean speakFromAnySession stays closed', async () => {
  const tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true, speakFromAnySession: 'true' }),
    bridge: { playText: async () => { throw new Error('must not play'); } },
    sessions: { deviceForSession: () => null, primaryDevice: () => ({ key: 'fallback' }) },
    autoSpeak: { claimToolSpeak: () => ({ allowed: true }), noteSpoken: async () => {} },
    logger: quiet,
  });
  const refused = await tool.execute({ text: '念这句' }, { agent: { session: { id: 'session-desktop-string' } } });
  assert.equal(refused.isError, true);
});

await check('the tool keeps the stable name the skill text promises', () => {
  assert.equal(SPEAK_TOOL_NAME, 'xiaoai_speak');
});

// --- speaking without being asked (phase 4.1) ------------------------------
console.log('proactive speech');

/**
 * Build the tool around a bridge client whose first answers we control.
 * @param {object} options
 * @param {(attempt: number, text: string) => object} options.playText answer per call
 * @param {() => object} options.ensureBridge supervisor hook
 * @param {number} [options.reviveWaitMs] retry deadline override
 * @param {number} [options.revivePollMs] retry interval override
 * @returns {object} tool plus what it did
 */
function reviveHarness({ playText, ensureBridge, reviveWaitMs, revivePollMs }) {
  const played = [];
  const noted = [];
  const attempts = [];
  const tool = createSpeakTool({
    getConfig: () => ({ enabled: true, apiServerEnabled: true }),
    bridge: {
      playText: async (text) => {
        played.push(text);
        return playText(played.length, text);
      },
    },
    sessions: {
      deviceForSession: () => ({ key: 'dev', host: '192.168.1.191', name: '小爱音箱' }),
      primaryDevice: () => null,
    },
    autoSpeak: {
      claimToolSpeak: () => ({ allowed: true }),
      noteSpoken: async (record) => { noted.push(record); },
    },
    ensureBridge: async () => { attempts.push(Date.now()); return ensureBridge(); },
    reviveWaitMs,
    revivePollMs,
    logger: quiet,
  });
  return { tool, played, noted, attempts };
}

const t9 = reviveHarness({
  // Nothing is listening on the first call, then the supervisor brought it up.
  playText: (attempt) => (attempt === 1 ? { ok: false, error: '无法连接桥接器 http://127.0.0.1:9092' } : { ok: true }),
  ensureBridge: async () => ({ ok: true, pid: 4242 }),
  reviveWaitMs: 500,
  revivePollMs: 5,
});
await check('a bridge that is down is started on demand, then the line is spoken', async () => {
  const result = await t9.tool.execute({ text: '水开了' }, { agent: { session: { id: 'session-tool-9' } } });
  assert.deepEqual(t9.played, ['水开了', '水开了']);
  assert.equal(t9.attempts.length, 1);
  assert.deepEqual(result, { text: '已让小爱音箱念出：水开了' });
  assert.equal(t9.noted.length, 1, 'a line that was really spoken is still logged');
  assert.equal(t9.noted[0].source, 'tool');
});

const t10 = reviveHarness({
  playText: () => ({ ok: false, error: '无法连接桥接器 http://127.0.0.1:9092' }),
  ensureBridge: async () => ({ ok: false, error: 'bridge is not running (autostart is off)' }),
});
await check('when the bridge cannot be started the reason is reported, not swallowed', async () => {
  const result = await t10.tool.execute({ text: '水开了' }, {});
  assert.equal(result.isError, true);
  assert.match(result.text, /autostart is off/);
  assert.deepEqual(t10.played, ['水开了'], 'a failed start is not retried against the same dead port');
  assert.deepEqual(t10.noted, []);
});

const t11 = reviveHarness({
  playText: () => ({ ok: false, status: 401, error: 'HTTP 401: unauthorized' }),
  ensureBridge: async () => { throw new Error('an answered HTTP error must not restart the bridge'); },
});
await check('an HTTP error means the bridge answered, so it is not restarted', async () => {
  const result = await t11.tool.execute({ text: '水开了' }, {});
  assert.equal(result.isError, true);
  assert.match(result.text, /401/);
  assert.deepEqual(t11.attempts, []);
});

const t12 = reviveHarness({
  playText: () => ({ ok: false, error: '请求超时（15000 ms）' }),
  ensureBridge: async () => ({ ok: true, pid: 99 }),
  reviveWaitMs: 40,
  revivePollMs: 5,
});
await check('a revived bridge that never answers stops at the deadline', async () => {
  const result = await t12.tool.execute({ text: '水开了' }, {});
  assert.equal(result.isError, true);
  assert.ok(t12.played.length >= 2, `expected retries after the start, saw ${t12.played.length}`);
  assert.equal(t12.attempts.length, 1);
});

const t13Played = [];
const t13 = createSpeakTool({
  getConfig: () => ({ enabled: true, apiServerEnabled: true }),
  bridge: {
    playText: async (text) => {
      t13Played.push(text);
      return { ok: false, error: '无法连接桥接器 http://127.0.0.1:9092' };
    },
  },
  sessions: { deviceForSession: () => ({ key: 'dev' }), primaryDevice: () => null },
  autoSpeak: { claimToolSpeak: () => ({ allowed: true }), noteSpoken: async () => {} },
  logger: quiet,
});
await check('without an ensureBridge hook a dead bridge is reported, not revived', async () => {
  const result = await t13.execute({ text: '念这句' }, {});
  assert.equal(result.isError, true);
  assert.match(result.text, /无法连接桥接器/);
  assert.deepEqual(t13Played, ['念这句'], 'no hook means no retry loop');
});

rmSync(dataDir, { recursive: true, force: true });
console.log(failures === 0 ? '\nspeak check OK' : `\nspeak check FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
