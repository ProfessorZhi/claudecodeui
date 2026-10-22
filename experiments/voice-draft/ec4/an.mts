// E-C4 分析。  npx tsx experiments/voice-draft/ec4/an.mts [sample]
import { writeFileSync } from 'node:fs';
import { CHAINS, EXPECT, ANSWERED } from './scripts.mts';
import { readJsonl } from '../ec/common.mts';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { runV2 } from '../ec3/pipeline.mts';
const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ec4'; const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const SC = Object.fromEntries(CHAINS.map((c) => [c.id, c]));
const rows = readJsonl(`${LOCAL}/extract.jsonl`); const asr = readJsonl(`${LOCAL}/asr.jsonl`);
const parse = (t: string) => { const m = (t ?? '').match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN); const f = (x: number) => (Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%');
function render(r: any) { const raw = parse(r.text); if (!raw) return null; const T: Record<number, string> = {}; for (const u of SC[r.chain].units) { if (r.voice === 'gold') T[u.n] = u.text; else { const a = asr.find((x) => x.voice === r.voice && x.chain === r.chain && x.unit === u.n && x.rep === r.rep && x.status === 200); T[u.n] = a ? instructionOf(E, a.text).transcript ?? '' : ''; } } return runV2(raw, T, '', false); }
if (process.argv[2] !== 'sample') {
  console.log(`抽取 ${rows.length} 份；可解析 ${f(rows.filter((r) => parse(r.text)).length / rows.length)}`);
  for (const who of ['asr', 'gold']) { const rs = rows.filter((r) => (who === 'gold' ? r.voice === 'gold' : r.voice !== 'gold')); const os = rs.map(render).filter(Boolean) as any[]; let ansQ = 0, paired = 0, openQ = 0, openPaired = 0; const falsePairs: string[] = [];
    rs.forEach((r, i) => { const o = render(r); if (!o) return; for (const [q, a] of o.pairs) { const Q = o.items.find((x: any) => x.id === q)!; if (!(ANSWERED[r.chain] ?? []).includes(Q.unit) && !(r.chain === 'EH2' && Q.unit === 1)) { falsePairs.push(`${r.chain} 段${Q.unit}`); } }
      for (const u of ANSWERED[r.chain] ?? []) { const qs = o.items.filter((x: any) => x.unit === u && ['问题', '探路', '假设'].includes(x.type)); for (const q of qs) { ansQ++; if (o.pairs.has(q.id)) paired++; } }
      if (r.chain === 'EH3') for (const q of o.items.filter((x: any) => x.unit === 3 && ['问题', '探路'].includes(x.type))) { openQ++; if (o.pairs.has(q.id)) openPaired++; } });
    console.log(`\n${who === 'gold' ? '脚本原文' : 'ASR 路径'}（${os.length} 份）：已回答的问句被配对 ${paired}/${ansQ} = ${f(paired / ansQ)}；未决问句（EH3 段 3）被误配 ${openPaired}/${openQ}；配对在非预期段 ${falsePairs.length}（${[...new Set(falsePairs)].join(' ')}）；每份配对 ${mean(os.map((o) => o.pairs.size)).toFixed(2)}`); }
} else {
  const pick: any[] = []; for (const c of CHAINS) for (const voice of ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'gold']) { const r = rows.find((x) => x.voice === voice && x.chain === c.id && x.rep === 0); const o = r ? render(r) : null; if (!o) continue; pick.push({ version: 'v1', voice, chain: c.id, prompt: o.prompt }); pick.push({ version: 'v2', voice, chain: c.id, prompt: o.promptV2 }); }
  let seed = 20261011; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; } pick.forEach((p, k) => (p.k = k));
  writeFileSync('/tmp/ec4-audit-key.json', JSON.stringify(pick.map(({ k, version, voice, chain }) => ({ k, version, voice, chain }))));
  const blind = pick.map((p) => ({ k: p.k, chain: p.chain, spoken_units: SC[p.chain].units.map((u) => `[段${u.n}] ${u.text}`), expect_units: Object.fromEntries(Object.entries(EXPECT[p.chain]).map(([u, t]) => [`段${u}`, t])), answered_units: ANSWERED[p.chain], system_output: { prompt: p.prompt } }));
  const per = Math.ceil(blind.length / 2); for (let i = 0; i < 2; i++) writeFileSync(`/tmp/ec4-audit-part${i}.json`, JSON.stringify(blind.slice(i * per, (i + 1) * per), null, 1)); console.log('wrote', blind.length, '每份', per);
}
