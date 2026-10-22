/**
 * E 组 × 上下文 的读数分析。
 *
 * 两条轴，缺一不可：
 *   ① rubric 轴 —— 直接调 `judge.mts`，与 C/E 的 ✅/◐/❌ 同源，是唯一能和既有读数并排看的轴。
 *   ② 插入轴 —— rubric **看不见**的失败模式：输出里出现了名单里有、而音频没说的名字。
 *      已有先例：逐字臂的 `p3-terms` 把 `voice.routes.ts` 塞进了从未说它的 d01/d04，而 rubric
 *      对 d01 判 ✅（只查该出现的在不在）。所以只报 ① 会正好漏掉上下文最危险的那一面。
 *
 * 用法：npx tsx experiments/voice-omni-written/raw/e-ctx-an.mts [texts]
 */
import { readFileSync } from 'node:fs';
import { judge } from './judge.mts';
import { instructionOf, CONDS } from './written.mts';
import { ARMS } from './e-ctx.mts';

const rows = readFileSync(new URL('./e-ctx.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const refs: Record<string, string> = Object.fromEntries(
  JSON.parse(readFileSync('experiments/voice-provider-paired-quality/fixtures/paired.json', 'utf8')).entries.map((e: any) => [e.clip, e.reference]),
);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CLIPS = [...new Set(rows.map((r) => r.clip))].sort();
/** 名字短到 4 字符以下时子串匹配会假阳，插入轴只数 ≥6 字符的名字。 */
const LONG = (list: string[]) => list.filter((t) => t.length >= 6);

function read(armKey: string) {
  const arm = ARMS.find((a) => a.key === armKey)!;
  const rs = rows.filter((r) => r.cond === armKey);
  const ok = rs.filter((r) => r.status === 200);
  const tally = { '✅': 0, '◐': 0, '❌': 0 } as Record<string, number>;
  const perClip: Record<string, Record<string, number>> = {};
  const ins: { clip: string; name: string; out: string }[] = [];
  const ms: number[] = [];
  let parsed = 0;
  for (const r of ok) {
    const o = instructionOf(E, r.text);
    if (o.parsed) parsed++;
    const [v] = judge(r.clip, o.instruction) as [string, string];
    tally[v]++; (perClip[r.clip] ??= { '✅': 0, '◐': 0, '❌': 0 })[v]++;
    ms.push(r.ms);
    const ref = refs[r.clip];
    for (const name of LONG(arm.injected)) if (o.instruction.includes(name) && !ref.includes(name)) { ins.push({ clip: r.clip, name, out: o.instruction }); break; }
  }
  ms.sort((a, b) => a - b);
  return { arm, ok, rs, tally, perClip, ins, parsed, p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(0.9 * (ms.length - 1))], max: ms.at(-1) };
}

const R = ARMS.map((a) => read(a.key));

console.log('臂'.padEnd(20), 'n', '✅', '◐', '❌', '误插', 'json', 'p50', 'p90', 'max', 'ctx字符');
for (const r of R) {
  console.log(
    r.arm.key.padEnd(20), String(r.ok.length).padStart(3),
    String(r.tally['✅']).padStart(3), String(r.tally['◐']).padStart(3), String(r.tally['❌']).padStart(3),
    String(r.ins.length).padStart(4), `${r.parsed}/${r.ok.length}`.padStart(6),
    String(r.p50).padStart(6), String(r.p90).padStart(6), String(r.max).padStart(6),
    String(r.arm.context.length).padStart(7),
  );
}

console.log('\n══ 逐片段 × 臂（✅/◐/❌，n=10）══');
console.log('片段'.padEnd(14) + R.map((r) => r.arm.key.replace('e-ctx-', '').replace('e-', '').slice(0, 10).padStart(13)).join(''));
for (const clip of CLIPS) {
  console.log(clip.replace('-o65.wav', '').padEnd(14) + R.map((r) => {
    const c = r.perClip[clip] ?? { '✅': 0, '◐': 0, '❌': 0 };
    return `${c['✅']}/${c['◐']}/${c['❌']}`.padStart(13);
  }).join(''));
}

console.log('\n══ 插入轴：名单里有、音频没说的名字 ══');
for (const r of R) {
  if (!r.arm.injected.length) continue;
  console.log(`\n-- ${r.arm.key}  名单 ${r.arm.injected.length} 个，误插 ${r.ins.length} 条`);
  const byName: Record<string, number> = {};
  for (const i of r.ins) byName[`${i.clip.replace('-o65', '')}:${i.name}`] = (byName[`${i.clip.replace('-o65', '')}:${i.name}`] ?? 0) + 1;
  for (const [k, n] of Object.entries(byName).sort((a, b) => b[1] - a[1])) console.log(`   ×${n} ${k}`);
  for (const i of r.ins.slice(0, 4)) console.log(`     ${i.clip} → ${JSON.stringify(i.out)}`);
}

if (process.argv[2] === 'texts') {
  for (const clip of CLIPS) {
    console.log(`\n#### ${clip}   参考: ${refs[clip]}`);
    for (const r of R) {
      const v: Record<string, number> = {};
      for (const row of r.ok.filter((x) => x.clip === clip)) {
        const o = instructionOf(E, row.text);
        const [verdict, why] = judge(clip, o.instruction) as [string, string];
        v[`${verdict}${why ? `[${why}]` : ''}  ${JSON.stringify(o.instruction)}`] = (v[`${verdict}${why ? `[${why}]` : ''}  ${JSON.stringify(o.instruction)}`] ?? 0) + 1;
      }
      console.log(`   ${r.arm.key.padEnd(19)} ${Object.entries(v).sort((a, b) => b[1] - a[1]).map(([k, n]) => `×${n} ${k}`).join('\n' + ' '.repeat(23))}`);
    }
  }
}
