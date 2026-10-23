// 流水线单元测试：npx tsx experiments/voice-draft/ec3/selftest.mts
import { run } from './pipeline.mts';
import assert from 'node:assert';
const T = { 1: '我先看一下 go 005，现在是什么状态？', 2: '那除了证据不足，还有别的原因吗？', 3: '实际上我认为这些结论是样本质量造成的。', 4: '也就是说，进程形态是完全不一样的？', 5: '你刚才说的那个表，再解释一下' };
const ctx = '[用户] 查一下\n[Claude Code] GOAL-005 的状态是 achieved\n| 方案 | 代价 |\n| A | 高 |';
const raw = { items: [
  { id: 1, unit: 1, type: '问题', span: '我先看一下 go 005，现在是什么状态？', answers: null },
  { id: 2, unit: 2, type: '探路', span: '那除了证据不足，还有别的原因吗？', answers: null },
  { id: 3, unit: 3, type: '假设', span: '实际上我认为这些结论是样本质量造成的', answers: 2 },
  { id: 4, unit: 4, type: '事实', span: '也就是说进程形态是完全不一样的？', answers: null },
  { id: 5, unit: 5, type: '问题', span: '你刚才说的那个表再解释一下', answers: null },
  { id: 6, unit: 5, type: '事实', span: '这句话我编的', answers: null }],
  replacements: [{ from: 'go 005', to: 'GOAL-005' }, { from: 'go', to: 'server/*' }, { from: '状态', to: 'achieved' }], anchors: [{ unit: 5, lines: [3, 4] }, { unit: 1, lines: [2] }, { unit: 5, lines: [1, 3] }] };
const r = run(raw, T as any, ctx, true);
assert.equal(r.dropped, 1, '编造的跨度被丢弃');
assert.equal(r.overridden, 1, '求证式问句被覆盖成假设');
assert.equal(r.items.find((i) => i.id === 4)!.type, '假设');
assert.ok(r.items.find((i) => i.id === 2)!.answeredBy === 3, '自问自答合并');
assert.ok(!r.prompt.includes('还有别的原因吗'), '被回答的问题不渲染');
assert.ok(r.prompt.includes('GOAL-005'), '合法替换被应用');
assert.equal(r.replacements.accepted.length, 1);
assert.ok(r.replacements.rejected.some((x: any) => x.why === 'not-latin' || x.why === 'to-not-in-context' || x.why === 'concretizes' || x.why === 'from-in-context' || x.why === 'too-far'), '危险替换被拒绝');
assert.equal(r.anchors.ok.length, 1, '只接受带指代标志、行号合法且连续的引用');
assert.ok(r.prompt.includes('> 引用：| 方案 | 代价 |'), '引用逐字');
const r0 = run(raw, T as any, '', false); assert.equal(r0.replacements.accepted.length, 0); assert.equal(r0.anchors.ok.length, 0);
console.log('SELFTEST-OK'); console.log(r.prompt);

// ── v2：问 + 答
import { runV2 } from './pipeline.mts';
const T2 = { 1: '密钥要不要留在 config_json 里？要留，可用性比保护更重要。', 2: '日志要不要按天切分？按天切，保留七天。', 3: '我可以接受手机上不显示这段文字。', 4: '如果删掉，怎么恢复到以前没有这一行的状态？我可以接受手机上不显示这段文字。', 5: '重试次数呢？三次。' };
const raw2 = { items: [
  { id: 1, unit: 1, type: '问题', span: '密钥要不要留在 config_json 里？', answers: null }, { id: 2, unit: 1, type: '决定', span: '要留，可用性比保护更重要。', answers: null },
  { id: 3, unit: 2, type: '问题', span: '日志要不要按天切分？', answers: null }, { id: 4, unit: 2, type: '决定', span: '按天切，保留七天。', answers: null },
  { id: 5, unit: 4, type: '问题', span: '如果删掉，怎么恢复到以前没有这一行的状态？', answers: null }, { id: 6, unit: 4, type: '决定', span: '我可以接受手机上不显示这段文字。', answers: null },
  { id: 7, unit: 5, type: '问题', span: '重试次数呢？', answers: null }, { id: 8, unit: 5, type: '决定', span: '三次。', answers: null }], replacements: [], anchors: [] };
const r2 = runV2(raw2, T2 as any, '', false);
assert.ok(r2.promptV2.includes('已决定：（问）密钥要不要留在 config_json 里？（答）要留，可用性比保护更重要'), '省略式回答带着问句');
assert.ok(r2.promptV2.includes('（问）日志要不要按天切分？（答）按天切，保留七天'), '以应答词开头的回答也配对');
assert.ok(r2.promptV2.includes('（问）重试次数呢？（答）三次'), '很短的回答配对');
assert.ok(!r2.promptV2.includes('（问）如果删掉，怎么恢复'), '并不回答该问句的决定不配对');
assert.ok(r2.promptV2.includes('请检查/查明：如果删掉，怎么恢复到以前没有这一行的状态'), '未被回答的问句仍是请求');
console.log('SELFTEST-V2-OK'); console.log(r2.promptV2);

// ── v2 护栏：模型给出的配对不过关时不采用
const T3 = { 1: '那本项目存在一个打包的生产形态吗？', 2: '白屏的问题也一起查。', 3: '如果生产形态确实存在，那我想知道怎么运行。', 4: '难道这个会话每次都换进程？', 5: '也就是说，进程形态是完全不一样的？' };
const raw3 = { items: [
  { id: 1, unit: 1, type: '问题', span: '那本项目存在一个打包的生产形态吗？', answers: null }, { id: 2, unit: 3, type: '问题', span: '如果生产形态确实存在，那我想知道怎么运行。', answers: 1 },
  { id: 3, unit: 4, type: '假设', span: '难道这个会话每次都换进程？', answers: null }, { id: 4, unit: 5, type: '假设', span: '也就是说，进程形态是完全不一样的？', answers: 3 }], replacements: [], anchors: [] };
const r3 = runV2(raw3, T3 as any, '', false);
assert.equal(r3.pairs.size, 0, '隔了两段、或回答本身是问句的配对不采用');
console.log('SELFTEST-V2-GUARDS-OK');

// ── v3：单字回答 + 无问号的疑问
import { runV3 } from './pipeline.mts';
const T4 = { 1: '超时时间要不要改成60秒？改。', 2: '要不要先改成按需加载，应该要，但先确认是不是这个包。', 3: '他说行，但我不确定。' };
const raw4 = { items: [
  { id: 1, unit: 1, type: '问题', span: '超时时间要不要改成60秒？', answers: null }, { id: 2, unit: 1, type: '决定', span: '改。', answers: 1 },
  { id: 3, unit: 2, type: '问题', span: '要不要先改成按需加载，', answers: null }, { id: 4, unit: 2, type: '决定', span: '应该要，', answers: null },
  { id: 5, unit: 3, type: '事实', span: '行', answers: null }], replacements: [], anchors: [] };
const v2x = runV2(raw4, T4 as any, '', false), v3x = runV3(raw4, T4 as any, '', false);
assert.equal(v2x.items.length < v3x.items.length, true, 'v3 保留单字整句「改。」');
assert.ok(v3x.promptV3.includes('（问）超时时间要不要改成60秒？（答）改。'), '单字回答配对');
assert.ok(v3x.promptV3.includes('（问）要不要先改成按需加载，（答）应该要'), '无问号的强疑问形态也配对');
assert.ok(!v3x.items.some((i) => i.id === 5), '单字「行」不是整句时不接受（「他说行，但……」里的「行」是句中字）');
console.log('SELFTEST-V3-OK'); console.log(v3x.promptV3);
