// E-C 分析。  npx tsx experiments/voice-draft/ec/an.mts [sample]
import { writeFileSync } from 'node:fs';
import { CHAINS } from './scripts.mts';
import { LOCAL, gold, readJsonl } from './common.mts';
const rows = readJsonl(`${LOCAL}/compose.jsonl`); const G = Object.fromEntries(gold().map((c: any) => [c.id, c])); const SC = Object.fromEntries(CHAINS.map((c) => [c.id, c]));
const parse = (t: string) => { const m = t.match(/\{[\s\S]*\}/); try { return JSON.parse(m ? m[0] : t); } catch { return null; } };
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN); const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; }; const pct = (x: number) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
const out = (r: any) => (r.status === 200 ? parse(r.text) : null); const monoLen = (id: string) => SC[id].units.reduce((a, u) => a + u.text.length, 0);
if (process.argv[2] !== 'sample') {
  console.log('臂   n    可解析   core_ask字数  prompt字数  压缩比(prompt/口述)  dropped条数  premises条数  p50/p90 ms');
  for (const arm of ['C0', 'C1', 'CW', 'G0']) { const rs = rows.filter((r) => r.arm === arm); const ok = rs.map((r) => ({ r, o: out(r) })).filter((x) => x.o && typeof x.o.prompt === 'string'); const ms = rs.map((r) => r.ms);
    console.log(`${arm.padEnd(4)} ${String(rs.length).padStart(3)}  ${pct(ok.length / rs.length).padStart(6)}   ${mean(ok.map((x) => String(x.o.core_ask ?? '').length)).toFixed(0).padStart(6)}      ${mean(ok.map((x) => x.o.prompt.length)).toFixed(0).padStart(6)}        ${mean(ok.map((x) => x.o.prompt.length / monoLen(x.r.chain))).toFixed(2).padStart(6)}            ${mean(ok.map((x) => (x.o.dropped ?? []).length)).toFixed(1)}        ${mean(ok.map((x) => (x.o.premises ?? []).length)).toFixed(1)}       ${q(ms, 0.5)}/${q(ms, 0.9)}`); }
} else {
  const pick: any[] = [];
  for (const c of CHAINS) for (const voice of ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']) for (const arm of ['C0', 'C1', 'CW']) { const r = rows.find((x) => x.arm === arm && x.voice === voice && x.chain === c.id && x.rep === 0); if (r && out(r)) pick.push({ arm, voice, chain: c.id, o: out(r) }); }
  for (const c of CHAINS) { const r = rows.find((x) => x.arm === 'G0' && x.chain === c.id && x.rep === 0); if (r && out(r)) pick.push({ arm: 'G0', voice: 'gold', chain: c.id, o: out(r) }); }
  let seed = 20261008; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
  pick.forEach((p, k) => (p.k = k)); writeFileSync('/tmp/ec-audit-key.json', JSON.stringify(pick.map(({ k, arm, voice, chain }) => ({ k, arm, voice, chain }))));
  const blind = pick.map((p) => ({ k: p.k, chain: p.chain, spoken_units: SC[p.chain].units.map((u) => `[段${u.n}] ${u.text}`), gold: { core: G[p.chain].core, must_keep: G[p.chain].must_keep, scaffolding: G[p.chain].scaffolding }, required_must_keep_count: G[p.chain].must_keep.length, system_output: { core_ask: p.o.core_ask, premises: p.o.premises, dropped: p.o.dropped, prompt: p.o.prompt } }));
  const per = Math.ceil(blind.length / 3); for (let i = 0; i < 3; i++) writeFileSync(`/tmp/ec-audit-part${i}.json`, JSON.stringify(blind.slice(i * per, (i + 1) * per), null, 1)); console.log('wrote', blind.length, '(每份', per, ')');
}
