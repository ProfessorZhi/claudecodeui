/**
 * 扩展集（`n01`…`n05`）上 E 组 × 上下文的读数。
 *
 * 两条轴，与 `e-ctx-an.mts` 同构：rubric 轴（`judge-ext.mts`，新片段自己的判据）与插入轴
 * （名单里有、音频没说的名字）。**判据不同源于片段不同**——`judge.mts` 的规则逐片段写死，
 * 不可能覆盖新片段——所以新旧两集的对比只在计数层面成立，逐条规则不可比。
 *
 * 用法：npx tsx experiments/voice-omni-written/raw/e-ctx-ext-an.mts [texts]
 */
import { readFileSync } from 'node:fs';
import { judgeExt } from './judge-ext.mts';
import { instructionOf, CONDS } from './written.mts';
import { ARMS } from './e-ctx.mts';

const rows = readFileSync(new URL('./e-ctx-ext.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const refs: Record<string, string> = Object.fromEntries(
  (JSON.parse(readFileSync(new URL('../fixtures/ext-refs.json', import.meta.url), 'utf8')) as { clips: { id: string; text: string }[] }).clips.map((c) => [c.id, c.text]),
);
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const CLIPS = [...new Set(rows.map((r) => r.clip))].sort();
const LONG = (list: string[]) => list.filter((t) => t.length >= 6);

/**
 * Names a clip LEGITIMATELY yields, because the speaker spelled them aloud.
 *
 * Without this the insertion axis is wrong on this set in the obvious way: `n04`'s reference
 * contains "use voice input" and `n01`'s contains "ChatComposer 点 t s x", so a model that
 * correctly ASSEMBLES the identifier would be scored as if it had invented a name the audio never
 * carried. The axis exists to catch names the clip is not about; on a corpus whose ground truth is
 * spoken, "is it in the reference string" cannot decide that, so each clip declares what it owes.
 */
const EXPECTED: Record<string, string[]> = {
  'n01-o65': ['ChatComposer.tsx', 'composer', 'pill', 'blob'],
  'n02-o65': ['resend', 'message id'],
  'n03-o65': [],
  'n04-o65': ['useVoiceInput', 'use voice input'],
  'n05-o65': ['dev server', 'HMR'],
};
const invented = (clip: string, text: string, list: string[]) =>
  list.filter((t) => t.length >= 6 && text.includes(t) && !refs[clip].includes(t)
    && !(EXPECTED[clip] ?? []).some((e) => t.toLowerCase().startsWith(e.toLowerCase()) || e.toLowerCase().startsWith(t.toLowerCase())));

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
    const [v] = judgeExt(r.clip, o.instruction) as [string, string];
    tally[v]++; (perClip[r.clip] ??= { '✅': 0, '◐': 0, '❌': 0 })[v]++;
    ms.push(r.ms);
    for (const name of invented(r.clip, o.instruction, arm.injected)) { ins.push({ clip: r.clip, name, out: o.instruction }); break; }
  }
  ms.sort((a, b) => a - b);
  return { arm, ok, tally, perClip, ins, parsed, p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1) };
}

const R = ARMS.map((a) => read(a.key));

console.log('臂'.padEnd(20), 'n', '✅', '◐', '❌', '误插', 'json', 'p50', 'max', 'ctx字符');
for (const r of R) {
  console.log(
    r.arm.key.padEnd(20), String(r.ok.length).padStart(3),
    String(r.tally['✅']).padStart(3), String(r.tally['◐']).padStart(3), String(r.tally['❌']).padStart(3),
    String(r.ins.length).padStart(4), `${r.parsed}/${r.ok.length}`.padStart(6),
    String(r.p50).padStart(6), String(r.max).padStart(6), String(r.arm.context.length).padStart(7),
  );
}

console.log('\n══ 逐片段 × 臂（✅/◐/❌，n=10）══');
console.log('片段'.padEnd(10) + R.map((r) => r.arm.key.replace('e-ctx-', '').replace('e-', '').slice(0, 9).padStart(12)).join(''));
for (const clip of CLIPS) {
  console.log(clip.replace('-o65', '').padEnd(10) + R.map((r) => {
    const c = r.perClip[clip] ?? { '✅': 0, '◐': 0, '❌': 0 };
    return `${c['✅']}/${c['◐']}/${c['❌']}`.padStart(12);
  }).join(''));
}

console.log('\n══ 插入轴 ══');
for (const r of R) {
  if (!r.arm.injected.length || !r.ins.length) continue;
  const by: Record<string, number> = {};
  for (const i of r.ins) by[`${i.clip.replace('-o65', '')}:${i.name}`] = (by[`${i.clip.replace('-o65', '')}:${i.name}`] ?? 0) + 1;
  console.log(`  ${r.arm.key}: ` + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `×${n} ${k}`).join('  '));
}

if (process.argv[2] === 'texts') {
  for (const clip of CLIPS) {
    console.log(`\n#### ${clip}\n参考: ${refs[clip]}`);
    for (const r of R) {
      const v: Record<string, number> = {};
      for (const row of r.ok.filter((x) => x.clip === clip)) {
        const o = instructionOf(E, row.text);
        const [verdict, why] = judgeExt(clip, o.instruction) as [string, string];
        const k = `${verdict}${why ? `[${why}]` : ''} ${JSON.stringify(o.instruction)}`;
        v[k] = (v[k] ?? 0) + 1;
      }
      console.log(`   ${r.arm.key.padEnd(19)} ${Object.entries(v).sort((a, b) => b[1] - a[1]).map(([k, n]) => `×${n} ${k}`).join('\n' + ' '.repeat(23))}`);
    }
  }
}

// ── 失败原因分解：每个臂在每条片段上「为什么」掉了分 ──────────────────────────────────────
// 合计的 ✅/◐/❌ 分不出「判据里的哪一条被触发」，而这一轮真正要看的正是那一条（n04 上
// 「把结论写成工单」与「把指示性引用解析成具体名字」是两种不同的错，值不同的处置）。
if (process.argv[2] === 'why') {
  const tally: Record<string, Record<string, number>> = {};
  for (const r of R) {
    for (const row of r.ok) {
      const o = instructionOf(E, row.text);
      const [v, why] = judgeExt(row.clip, o.instruction) as [string, string];
      if (v === '✅') continue;
      const k = `${r.arm.key}|${row.clip.replace('-o65', '')}|${why}`;
      tally[k] = tally[k] ?? {};
      tally[k][v] = (tally[k][v] ?? 0) + 1;
    }
  }
  for (const k of Object.keys(tally).sort()) {
    const t = tally[k];
    console.log(`  ${k.padEnd(42)} ${Object.entries(t).map(([v, n]) => `${v}×${n}`).join(' ')}`);
  }
}
