// S1 人读审计（2026-10-03）：每一处文本阶段改动（输出 ≠ 输入）都被人读过，规则判定与人读不一致处在此逐条覆盖。
//   npx tsx experiments/voice-draft/s1/semantic.mts
// 未改动的输出与基线 A 逐字相同，判定相同，不在此列；因此净变化只需看被改动的输出。
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { judge } from '../../voice-omni-written/raw/judge.mts';
import { judgeExt } from '../../voice-omni-written/raw/judge-ext.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200 && r.arm !== 'C0');
const rule = (r: any, t: string) => (r.set === 'base' ? judge(r.clip, t) : judgeExt(r.clip, t))[0];
/** [clip 前缀, 输出里的子串, 人读判定, 理由] —— 只覆盖规则与人读不一致的输出。 */
const OVR: [string, string, '✅' | '◐' | '❌', string][] = [
  ['d01', '`voice.routes.ts` 的超时', '❌', '目标换成了另一个真实文件'],
  ['d02', 'voiceTrim.ts', '❌', '目标换成了另一个文件'],
  ['d02', '修改 `voice.rounts.ts`。 ⟹', '❌', ''],
  ['d02', 'voice.service.ts', '❌', '说话人明确改成 routes，这里是被否定的文件'],
  ['d08', 'gemini-3.5-transcribe', '❌', '续写成助手回复，与录音无关'],
  ['d06', '嗯，那个，把', '❌', '口头禅被放回，且「快捷键」被改成「标签」'],
  ['d04', '不要动 `voice.routes.ts`，只改', '❌', '禁改清单里换成了从没说过的文件'],
  ['d04', '不要修改 `voice.routes.ts` 和 `voice.service.ts`', '◐', '禁改清单里多塞了一个没说过的文件（A2 同款插入）'],
  ['d04', '不要动 `voice.routes.ts` 和 `voice.service.ts`', '◐', '同上'],
  ['d04', '不要动 `voice.service.ts` 和 `voice.routes.ts`', '◐', '同上'],
  ['d04', '只修改 `voice.service.ts`', '❌', '把被禁改的文件写成了要改的文件，语义反转'],
  ['d03', '我先并行做两件事', '❌', '泄漏：上下文被当成要续写的内容'],
  ['d07', 'voice.service.ts文件里加一个call方法', '❌', '重写了要求，凭空出现文件名'],
  ['n02', '刚才我试了一下', '◐', '整理稿被改写回口语，丢掉了 message id 的限定'],
];
function human(r: any, out: string): [string, string] {
  const o = OVR.find(([c, s]) => r.clip.startsWith(c) && out.includes(s)); return o ? [o[2], o[3]] : [rule(r, out), ''];
}
for (const arm of ['C', 'D']) {
  const rs = rows.filter((r) => r.arm === arm); let ch = 0;
  const t = { rule: { gain: 0, loss: 0, newBad: 0 }, human: { gain: 0, loss: 0, newBad: 0 } };
  for (const r of rs) { const out = instructionOf(E, r.text).instruction; if (out === r.input) continue; ch++;
    const b = rule(r, r.input);
    for (const [k, a] of [['rule', rule(r, out)], ['human', human(r, out)[0]]] as const) {
      if (a === '✅' && b !== '✅') t[k].gain++; if (a !== '✅' && b === '✅') t[k].loss++; if (a === '❌' && b !== '❌') t[k].newBad++; } }
  console.log(`${arm}: ${rs.length} outputs, ${ch} changed;  rule  +✅${t.rule.gain} −✅${t.rule.loss} new❌${t.rule.newBad};  human  +✅${t.human.gain} −✅${t.human.loss} new❌${t.human.newBad}`);
}
