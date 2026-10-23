// E-C4 分析。  npx tsx experiments/voice-draft/ec4/an-b.mts [sample]
import { writeFileSync } from 'node:fs';
import { CHAINS, EXPECT, ANSWERED } from './scripts-b.mts';
import { readJsonl } from '../ec/common.mts';
import { CONDS, instructionOf } from '../../voice-omni-written/raw/written.mts';
import { run as runBase, pairAnswers, renderV2, runV2, runV3 } from '../ec3/pipeline.mts';
const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ec4b'; const E = CONDS.find((c) => c.key === 'E-twostep-low')!; const SC = Object.fromEntries(CHAINS.map((c) => [c.id, c]));
const rows = readJsonl(`${LOCAL}/extract.jsonl`); const asr = readJsonl(`${LOCAL}/asr.jsonl`);
const parse = (t: string) => { const m = (t ?? '').match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN); const f = (x: number) => (Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%');
function render(r: any) { const raw = parse(r.text); if (!raw) return null; const T: Record<number, string> = {}; for (const u of SC[r.chain].units) { if (r.voice === 'gold') T[u.n] = u.text; else { const a = asr.find((x) => x.voice === r.voice && x.chain === r.chain && x.unit === u.n && x.rep === r.rep && x.status === 200); T[u.n] = a ? instructionOf(E, a.text).transcript ?? '' : ''; } } const v2 = runV2(raw, T, '', false), v3 = runV3(raw, T, '', false); return { v1: v2.prompt, v2: v2.promptV2, v3: v3.promptV3, items3: v3.items, pairs3: v3.pairs, items2: v2.items, pairs2: v2.pairs }; }
if (process.argv[2] !== 'sample') {
  console.log(`抽取 ${rows.length} 份；可解析 ${f(rows.filter((r) => parse(r.text)).length / rows.length)}`);
  for (const who of ['asr', 'gold']) for (const ver of ['2', '3']) { const rs = rows.filter((r) => (who === 'gold' ? r.voice === 'gold' : r.voice !== 'gold')); let ansQ = 0, paired = 0; const unexpected: string[] = []; let pairsN = 0, runs = 0;
    for (const r of rs) { const o: any = render(r); if (!o) continue; runs++; const items = o['items' + ver], pairs: Map<number, number> = o['pairs' + ver]; pairsN += pairs.size;
      for (const [q] of pairs) { const Q = items.find((x: any) => x.id === q)!; if (!(ANSWERED[r.chain] ?? []).includes(Q.unit) && !(r.chain === 'EH7' && Q.unit === 1)) unexpected.push(`${r.chain} 段${Q.unit}`); }
      for (const u of ANSWERED[r.chain] ?? []) for (const q of items.filter((x: any) => x.unit === u && ['问题', '探路', '假设'].includes(x.type) && /[？?]|要不要|是不是|能不能|行不行|对不对|会不会|有没有|吗/.test(x.span))) { ansQ++; if (pairs.has(q.id)) paired++; } }
    console.log(`${who === 'gold' ? '脚本原文' : 'ASR 路径'} v${ver}（${runs} 份）：已回答的问句被配对 ${paired}/${ansQ} = ${f(paired / ansQ)}；每份配对 ${(pairsN / runs).toFixed(2)}；非预期段的配对 ${unexpected.length}（${[...new Set(unexpected)].join(' ')}）`); }
} else {
  const pick: any[] = []; for (const c of CHAINS) for (const voice of ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'gold']) { const r = rows.find((x) => x.voice === voice && x.chain === c.id && x.rep === 0); const o = r ? render(r) : null; if (!o) continue; pick.push({ version: 'v1', voice, chain: c.id, prompt: o.v1 }); pick.push({ version: 'v2', voice, chain: c.id, prompt: o.v2 }); pick.push({ version: 'v3', voice, chain: c.id, prompt: o.v3 }); }
  let seed = 20261012; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; } pick.forEach((p, k) => (p.k = k));
  writeFileSync('/tmp/ec4b-audit-key.json', JSON.stringify(pick.map(({ k, version, voice, chain }) => ({ k, version, voice, chain }))));
  const blind = pick.map((p) => ({ k: p.k, chain: p.chain, spoken_units: SC[p.chain].units.map((u) => `[段${u.n}] ${u.text}`), expect_units: Object.fromEntries(Object.entries(EXPECT[p.chain]).map(([u, t]) => [`段${u}`, t])), answered_units: ANSWERED[p.chain], system_output: { prompt: p.prompt } }));
  const per = Math.ceil(blind.length / 3); for (let i = 0; i < 3; i++) writeFileSync(`/tmp/ec4b-audit-part${i}.json`, JSON.stringify(blind.slice(i * per, (i + 1) * per), null, 1)); console.log('wrote', blind.length, '每份', per);
}
