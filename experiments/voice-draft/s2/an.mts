// S2 分析，按 PREREG.md 的机械指标与判定 1–8。从仓库根运行：
//   npx tsx experiments/voice-draft/s2/an.mts              # 各臂指标与判定
//   npx tsx experiments/voice-draft/s2/an.mts sample       # 抽样 30 份写 /tmp/s2-audit-in.json（人读审计用）
//   npx tsx experiments/voice-draft/s2/an.mts show <arm> <script> [voice] [rep]
import { readFileSync, writeFileSync } from 'node:fs';
import { SCRIPTS, normalize } from './scripts.mts';
import { REPO_NAMES } from '../s1/run.mts';

const RW = process.env.REWRITE === '1'; // 补充 1：读 rewrite.jsonl，臂名 a2/r/r0/gr 对应 a/b/b0/gb
const TEST = process.env.TESTARM ?? 'r'; // REWRITE=1 时的被测臂：r（纯文本）或 rj（JSON）
const N = RW ? { a: 'a2', b: TEST, b0: TEST + '0', c: '', ga: '', gb: TEST === 'rj' ? 'gj' : 'gr' } : { a: 'a', b: 'b', b0: 'b0', c: 'c', ga: 'ga', gb: 'gb' };
const readJsonl = (f: string): any[] => { try { return readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const rows: any[] = RW ? [...readJsonl('./rewrite.jsonl'), ...readJsonl('./rewrite-json.jsonl')] : readJsonl('./drafts.jsonl');
const asr: any[] = readFileSync(new URL('./asr.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = Object.fromEntries(SCRIPTS.map((s) => [s.id, s]));
const FILE = /[A-Za-z_][\w-]*(?:\.[\w-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|sql|sh|yml|yaml)(?![\w])/g;
const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const mean = (xs: number[]) => { const v = xs.filter((x) => !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };

export function scoreRow(r: any) {
  const s = byId[r.script]; const t = normalize(r.final ?? '');
  const items = s.items.map((i) => ({ i, ok: i.ok(t) }));
  const forb = s.forbidden.map((f) => ({ f, hit: f.hit(t) }));
  const scriptText = s.units.map((u) => u.text).join(' ');
  const known = new Set<string>([...REPO_NAMES, ...(scriptText.match(FILE) ?? [])]);
  const unknown = [...new Set<string>(r.final?.match(FILE) ?? [])].filter((x) => !known.has(x) && !known.has(x.replace(/^.*\//, '')));
  const early = items.filter((x) => x.i.early); const ident = items.filter((x) => x.i.ident);
  return {
    recall: mean(items.map((x) => +x.ok)), leak: mean(forb.map((x) => +x.hit)), early: mean(early.map((x) => +x.ok)), ident: mean(ident.map((x) => +x.ok)),
    unknown, items, forb,
  };
}
const armRows = (arm: string) => rows.filter((r) => r.arm === arm);
const mark = (ok: boolean) => (ok ? 'PASS' : 'FAIL');

function summarize(arm: string) {
  const rs = armRows(arm); const sc = rs.map(scoreRow);
  const upd = rs.flatMap((r) => r.updates); const incr = upd.filter((u) => u.empty !== undefined || u.parsed !== undefined);
  return {
    arm, runs: rs.length, recall: mean(sc.map((x) => x.recall)), leak: mean(sc.map((x) => x.leak)), early: mean(sc.map((x) => x.early)), ident: mean(sc.map((x) => x.ident)),
    unknownRate: mean(sc.map((x) => +(x.unknown.length > 0))), opValid: incr.length ? mean(incr.map((u) => (u.parsed !== undefined && u.valid === undefined ? +u.parsed : RW && u.empty !== undefined ? +(u.status === 200 && !u.empty) : +(u.parsed && u.valid)))) : NaN,
    updP50: q(upd.map((u) => u.ms), 0.5), updP90: q(upd.map((u) => u.ms), 0.9), updates: upd.length,
    cmdLeak: mean(sc.flatMap((x) => x.forb.filter((f) => f.f.kind === 'command').map((f) => +f.hit))),
    nearmiss: mean(sc.flatMap((x) => x.items.filter((i) => i.i.kind === 'nearmiss').map((i) => +i.ok))),
  };
}
function breakdown(arm: string, key: (r: any) => string) {
  const out: Record<string, string> = {};
  for (const k of [...new Set(armRows(arm).map(key))].sort()) { const rs = armRows(arm).filter((r) => key(r) === k).map(scoreRow); out[k] = `recall ${pct(mean(rs.map((x) => x.recall)))} leak ${pct(mean(rs.map((x) => x.leak)))} n=${rs.length}`; }
  return out;
}
function byKind(arm: string) {
  const acc: Record<string, number[]> = {}; const leak: Record<string, number[]> = {};
  for (const r of armRows(arm)) { const x = scoreRow(r); for (const i of x.items) (acc[i.i.kind] ??= []).push(+i.ok); for (const f of x.forb) (leak[f.f.kind] ??= []).push(+f.hit); }
  return { recall: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, `${pct(mean(v))} (n=${v.length})`])), leak: Object.fromEntries(Object.entries(leak).map(([k, v]) => [k, `${pct(mean(v))} (n=${v.length})`])) };
}

const mode = process.argv[2];
if (mode === 'show') {
  const [, , , arm, script, voice, rep] = process.argv;
  for (const r of rows.filter((r) => r.arm === arm && r.script === script && (!voice || r.voice.startsWith(voice)) && (!rep || r.rep === +rep))) {
    const x = scoreRow(r); console.log(`\n=== ${r.arm} ${r.voice} ${r.script} rep${r.rep}  recall ${pct(x.recall)} leak ${pct(x.leak)}  missed: ${x.items.filter((i) => !i.ok).map((i) => i.i.id)}  leaked: ${x.forb.filter((f) => f.hit).map((f) => f.f.id)}  unknown: ${x.unknown}\n${r.final}`);
  }
} else if (mode === 'sample') {
  let seed = RW ? 20261005 : 20261003; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pool = rows.filter((r) => (RW ? ['a2', 'r', 'rj', 'rj0'] : ['a', 'b', 'b0', 'c']).includes(r.arm));
  // 每个脚本 6 份：a、b、b0、c 各一份 + 两份轮转的额外臂；全局每臂 ≥ 7 份、每脚本 6 份（audit.md：每臂 ≥ 6、每脚本 ≥ 4）。
  const ARMS = RW ? ['a2', 'r', 'rj', 'rj0'] : ['a', 'b', 'b0', 'c']; const pick: any[] = [];
  SCRIPTS.forEach((sc, si) => { const arms = RW ? ['r', 'r', 'rj', 'rj', 'rj0', 'rj0', 'a2', 'a2'] : [...ARMS, ARMS[(si * 2) % 4], ARMS[(si * 2 + 1) % 4]];
    for (const arm of arms) { const c = pool.filter((r) => r.arm === arm && r.script === sc.id && !pick.includes(r)); pick.push(c[Math.floor(rnd() * c.length)]); } });
  const out = pick.map((r, k) => ({ k, arm: r.arm, voice: r.voice, script: r.script, rep: r.rep, final: r.final, mech: (({ items, forb, unknown, ...m }) => ({ ...m, items: Object.fromEntries(items.map((i: any) => [i.i.id, i.ok])), forb: Object.fromEntries(forb.map((f: any) => [f.f.id, f.hit])), unknown }))(scoreRow(r)) }));
  writeFileSync(RW ? '/tmp/s2rw-audit-in.json' : '/tmp/s2-audit-in.json', JSON.stringify(out, null, 1)); console.log(`wrote ${out.length} samples; arms ${JSON.stringify(Object.fromEntries(ARMS.map((a) => [a, out.filter((o) => o.arm === a).length])))}; scripts ${JSON.stringify(Object.fromEntries(SCRIPTS.map((s) => [s.id, out.filter((o) => o.script === s.id).length])))}`);
} else {
  // 负控制：原始脚本文本不经任何处理
  const raw = SCRIPTS.map((s) => scoreRow({ script: s.id, final: s.units.map((u) => u.text).join('\n') }));
  console.log(`raw-script (negative control): recall ${pct(mean(raw.map((x) => x.recall)))} leak ${pct(mean(raw.map((x) => x.leak)))}\n`);
  const S: Record<string, ReturnType<typeof summarize>> = {};
  for (const arm of (RW ? ['a2', 'r', 'r0', 'gr', 'rj', 'rj0', 'gj'] : ['a', 'b', 'b0', 'c', 'ga', 'gb'])) { if (!armRows(arm).length) continue; S[arm] = summarize(arm); const x = S[arm];
    console.log(`${arm.padEnd(3)} runs=${x.runs}  recall ${pct(x.recall)}  leak ${pct(x.leak)}  early ${pct(x.early)}  ident ${pct(x.ident)}  unknown-name ${pct(x.unknownRate)}  opValid ${pct(x.opValid)}  upd p50/p90 ${x.updP50}/${x.updP90}ms  cmdLeak ${pct(x.cmdLeak)}  nearmiss ${pct(x.nearmiss)}`); }
  const a = S[N.a], b = S[N.b], b0 = S[N.b0], gb = S[N.gb];
  if (b && a) {
    console.log(`\nPREREG 判定（被测臂 ${N.b}，ASR 路径；基线 ${N.a}，无上下文对照 ${N.b0}，原文对照 ${N.gb}）`);
    console.log(`1 召回 ≥0.80 且 ≥ a−0.05      : ${pct(b.recall)} vs a ${pct(a.recall)}  ${mark(b.recall >= 0.8 && b.recall >= a.recall - 0.05)}`);
    console.log(`2 泄漏 ≤0.10 且 ≤ a          : ${pct(b.leak)} vs a ${pct(a.leak)}  ${mark(b.leak <= 0.1 && b.leak <= a.leak)}`);
    console.log(`3 早期存活 ≥0.85              : ${pct(b.early)}  ${mark(b.early >= 0.85)}`);
    console.log(`4 操作有效率 ≥95%             : ${pct(b.opValid)}  ${mark(b.opValid >= 0.95)}`);
    console.log(`5 每次更新 p90 ≤10s           : ${b.updP90}ms  ${mark(b.updP90 <= 10000)}`);
    console.log(`6 未知文件名 ≤2% 且 标识符召回 ≥ b0: ${pct(b.unknownRate)}; ident b ${pct(b.ident)} vs b0 ${b0 ? pct(b0.ident) : '—'}  ${mark(b.unknownRate <= 0.02 && (!b0 || b.ident >= b0.ident))}`);
    console.log(`7 召回 ≥ gb−0.10              : ${pct(b.recall)} vs gb ${gb ? pct(gb.recall) : '—'}  ${gb ? mark(b.recall >= gb.recall - 0.1) : 'n/a'}`);
    console.log(`8 命令泄漏 ≤0.10 且 近似句召回 ≥0.80: cmdLeak ${pct(b.cmdLeak)}; nearmiss ${pct(b.nearmiss)}  ${mark(b.cmdLeak <= 0.1 && b.nearmiss >= 0.8)}`);
  }
  for (const arm of Object.keys(S)) { console.log(`\n── ${arm}`); console.log(' 按脚本', JSON.stringify(breakdown(arm, (r) => r.script))); if (!arm.startsWith('g')) console.log(' 按音色', JSON.stringify(breakdown(arm, (r) => r.voice.replace('zh-CN-', '')))); console.log(' 按条目类型', JSON.stringify(byKind(arm))); }
}
