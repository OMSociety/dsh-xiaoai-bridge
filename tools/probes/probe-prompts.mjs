const root = new URL('../../', import.meta.url).href;
const { buildReplyerPrompts } = await import(root + 'lib/replyer.js');
const { DEFAULTS } = await import(root + 'lib/config.js');
const { composeVoiceRule, buildOverrides } = await import(root + 'lib/render-config.js');

const shipped = buildReplyerPrompts({ intent: '现在几点了', history: [{ role: 'user', text: '几点了' }], cfg: DEFAULTS });
console.log('=== system (shipped defaults) ===');
console.log(shipped.system);
console.log('=== user ===');
console.log(shipped.user);

console.log('\n=== system (cfg {}) ===');
console.log(buildReplyerPrompts({ intent: 'i', history: [], cfg: {} }).system);

console.log('\n=== system (custom persona) ===');
console.log(buildReplyerPrompts({ intent: 'i', history: [], cfg: { ...DEFAULTS, personality: '你很耐心' } }).system);

console.log('\n=== composeVoiceRule(DEFAULTS) ===');
console.log(composeVoiceRule(DEFAULTS));

console.log('\n=== composeVoiceRule({}) ===');
console.log(JSON.stringify(composeVoiceRule({})));

console.log('\n=== rendered overrides (DEFAULTS) ===');
console.log(JSON.stringify(buildOverrides(DEFAULTS).dsh, null, 1));

console.log('\n=== cleared fields ===');
console.log('personality:"" ->');
console.log(buildReplyerPrompts({ intent: 'i', history: [], cfg: { ...DEFAULTS, personality: '' } }).system);
console.log('replyStyle:"" ->');
console.log(buildReplyerPrompts({ intent: 'i', history: [], cfg: { ...DEFAULTS, replyStyle: '' } }).system);
console.log('behaviorStyle:"" ->');
console.log(JSON.stringify(composeVoiceRule({ ...DEFAULTS, behaviorStyle: '' })));
