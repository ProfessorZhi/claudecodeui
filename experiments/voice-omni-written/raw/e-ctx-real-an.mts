/**
 * E 组 × 真实会话历史 的读数。
 *
 * 判据必须按集合分派：旧 8 条由 `judge.mts` 判（那是 C/E 定型读数的同一把尺子），扩展 5 条由
 * `judge-ext.mts` 判。**两套的数字不可相加**——一把尺子量不出另一把尺子的刻度。
 *
 * 插入轴在这里换了来源：这些臂没有名单，上下文是**一段真实助手回复**。所以问题变成"那段回复里的
 * 名字，有没有出现在说话人没提过它的片段上"。这是同一个病灶（用没被说过的名字替换/补全）在真实
 * 上下文上的形态，也是这一轮唯一能把"真实上下文是否也会污染"落成数字的地方。
 *
 * 用法：npx tsx experiments/voice-omni-written/raw/e-ctx-real-an.mts [texts|names]
 */
import { readFileSync } from 'node:fs';
import { judge } from './judge.mts';
import { judgeExt } from './judge-ext.mts';
import { instructionOf, CONDS } from './written.mts';
import { ARMS, CLIPS } from './e-ctx-real.mts';

const rows = readFileSync(new URL('./e-ctx-real.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const baseRef: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]),
);
const extRef: Record<string, string> = Object.fromEntries(
  (JSON.parse(readFileSync(new URL('../fixtures/ext-refs.json', import.meta.url), 'utf8')) as { clips: { id: string; text: string }[] }).clips.map((c) => [c.id, c.text]),
);
const refOf = (clip: string) => baseRef[clip] ?? extRef[clip];
const setOf = (clip: string) => (baseRef[clip] ? 'base' : 'ext');
const verdictOf = (clip: string, ins: string) =>
  (setOf(clip) === 'base' ? judge(clip, ins) : judgeExt(clip, ins)) as [string, string];

const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const ctxText = (JSON.parse(readFileSync(new URL('../fixtures/real-ctx.json', import.meta.url), 'utf8')) as { strings: Record<string, { text: string }> }).strings['r-asst-8k'].text;

/** 上下文里出现的、像标识符的名字（反引号里或含点/驼峰的拉丁串）。 */
const ctxNames = [...new Set(
  [...ctxText.matchAll(/`([^`\n]{3,60})`/g)].map((m) => m[1])
    .concat([...ctxText.matchAll(/\b[A-Za-z][A-Za-z0-9_]*(?:\.[a-z]{2,4})?\b/g)].map((m) => m[0])),
)].filter((n) => n.length >= 6 && /[A-Z._]/.test(n));

function read(armKey: string) {
  const arm = ARMS.find((a) => a.key === armKey)!;
  const rs = rows.filter((r) => r.cond === armKey && r.status === 200);
  const per = { base: { '✅': 0, '◐': 0, '❌': 0 }, ext: { '✅': 0, '◐': 0, '❌': 0 } } as Record<string, Record<string, number>>;
  const perClip: Record<string, Record<string, number>> = {};
  const ins: { clip: string; name: string }[] = [];
  const ms: number[] = [];
  for (const r of rs) {
    const o = instructionOf(E, r.text);
    const [v] = verdictOf(r.clip, o.instruction);
    per[setOf(r.clip)][v]++; (perClip[r.clip] ??= { '✅': 0, '◐': 0, '❌': 0 })[v]++;
    ms.push(r.ms);
    for (const n of ctxNames) if (o.instruction.includes(n) && !refOf(r.clip).includes(n)) { ins.push({ clip: r.clip, name: n }); break; }
  }
  ms.sort((a, b) => a - b);
  return { arm, rs, per, perClip, ins, p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1) };
}

const R = ARMS.map((a) => read(a.key));

console.log('臂'.padEnd(18), 'ctx', '│ 旧 8 条 ✅/◐/❌', '│ 扩展 5 条 ✅/◐/❌', '│ 误插', 'p50', 'max');
for (const r of R) {
  const b = r.per.base, e = r.per.ext;
  console.log(
    r.arm.key.padEnd(18), String(r.arm.context.length).padStart(5), '│',
    `${b['✅']}/${b['◐']}/${b['❌']}`.padStart(12), '│',
    `${e['✅']}/${e['◐']}/${e['❌']}`.padStart(13), '│',
    String(r.ins.length).padStart(5), String(r.p50).padStart(6), String(r.max).padStart(6),
  );
}

console.log('\n══ 逐片段（✅/◐/❌，n=10）══');
console.log('片段'.padEnd(12) + R.map((r) => r.arm.key.replace('r-', '').slice(0, 10).padStart(13)).join(''));
for (const c of CLIPS) {
  const clip = c.clip;
  console.log(clip.replace('-o65.wav', '').replace('-o65', '').padEnd(12) + R.map((r) => {
    const v = r.perClip[clip] ?? { '✅': 0, '◐': 0, '❌': 0 };
    return `${v['✅']}/${v['◐']}/${v['❌']}`.padStart(13);
  }).join(''));
}

console.log('\n══ 插入轴：上下文里的名字出现在没说它的片段上 ══');
for (const r of R) {
  if (!r.ins.length) { console.log(`  ${r.arm.key}: 0`); continue; }
  const by: Record<string, number> = {};
  for (const i of r.ins) by[`${i.clip.replace('-o65.wav', '').replace('-o65', '')}:${i.name}`] = (by[`${i.clip.replace('-o65.wav', '').replace('-o65', '')}:${i.name}`] ?? 0) + 1;
  console.log(`  ${r.arm.key}: ` + Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `×${n} ${k}`).join('  '));
}

if (process.argv[2] === 'names') {
  console.log(`\n上下文里抽出的候选名字 ${ctxNames.length} 个，前 30:`);
  console.log('  ' + ctxNames.slice(0, 30).join('、'));
}
if (process.argv[2] === 'texts') {
  for (const c of CLIPS) {
    console.log(`\n#### ${c.clip}  [${setOf(c.clip)}]\n参考: ${refOf(c.clip)}`);
    for (const r of R) {
      const v: Record<string, number> = {};
      for (const row of r.rs.filter((x: any) => x.clip === c.clip)) {
        const o = instructionOf(E, row.text);
        const [verdict, why] = verdictOf(c.clip, o.instruction);
        const k = `${verdict}${why ? `[${why}]` : ''} ${JSON.stringify(o.instruction)}`;
        v[k] = (v[k] ?? 0) + 1;
      }
      console.log(`   ${r.arm.key.padEnd(17)} ${Object.entries(v).sort((a, b) => b[1] - a[1]).map(([k, n]) => `×${n} ${k}`).join('\n' + ' '.repeat(21))}`);
    }
  }
}
