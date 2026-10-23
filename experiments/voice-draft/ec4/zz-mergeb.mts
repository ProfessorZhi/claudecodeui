import { readFileSync } from 'node:fs';
/** 只修语法：逐行解析；整行不能解析时，把 invented / note 里未转义的内部引号还原。判定内容不改。 */
function lenient(path: string) {
  const text = readFileSync(path, 'utf8'); try { return { rows: JSON.parse(text) as any[], repaired: [] as number[] }; } catch { /* fall through */ }
  const rows: any[] = []; const repaired: number[] = [];
  for (const line of text.split('\n')) { const l = line.trim().replace(/,$/, ''); if (!l.startsWith('{')) continue; try { rows.push(JSON.parse(l)); continue; } catch { /* repair */ }
    const m = l.match(/^(\{"k":\d+,"ret":\{[^}]*\},"reask":\{[^}]*\},"mis":\[[^\]]*\],"read":"[^"]*",)"invented":\[(.*)\],"note":"(.*)"\}$/); if (!m) throw new Error('无法修复: ' + l.slice(0, 80));
    const head = JSON.parse(m[1] + '"x":0}'); const inner = m[2]; const items = inner === '' ? [] : inner.replace(/^"/, '').replace(/"$/, '').split('","'); rows.push({ ...head, x: undefined, invented: items, note: m[3] }); repaired.push(head.k); }
  return { rows, repaired };
}
const key = JSON.parse(readFileSync('/tmp/ec4b-audit-key.json', 'utf8')); const parts: any[] = [], out: any[] = []; const rep: Record<string, number[]> = {};
for (let i = 0; i < 3; i++) { parts.push(...JSON.parse(readFileSync(`/tmp/ec4b-audit-part${i}.json`, 'utf8'))); const r = lenient(`/tmp/ec4b-audit-out${i}.json`); out.push(...r.rows); if (r.repaired.length) rep[`out${i}`] = r.repaired; }
console.log('语法修复的行(k):', JSON.stringify(rep));
const P = Object.fromEntries(parts.map((p) => [p.k, p])), H = Object.fromEntries(out.map((o) => [o.k, o]));
let bad = 0; for (const k of key) { const h = H[k.k], p = P[k.k]; if (!h) { bad++; console.log('MISSING', k.k); continue; } const want = (o: any) => Object.keys(o).map((x) => x.replace('段', '')).sort().join(','); if (Object.keys(h.ret ?? {}).sort().join(',') !== want(p.expect_units)) { bad++; console.log('RET KEY MISMATCH', k.k); } if (Object.keys(h.reask ?? {}).sort().join(',') !== [...p.answered_units].map(String).sort().join(',')) { bad++; console.log('REASK KEY MISMATCH', k.k); } }
console.log('reviewed', Object.keys(H).length, 'of', key.length, 'problems', bad);
const f = (x: number) => (Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%'); const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
const stat = (ver: string, who: 'asr' | 'gold' | 'all') => { const ks = key.filter((k: any) => k.version === ver && (who === 'all' || (who === 'gold' ? k.voice === 'gold' : k.voice !== 'gold'))); const ret = ks.flatMap((k: any) => Object.values(H[k.k].ret)); const rs = ks.flatMap((k: any) => Object.values(H[k.k].reask)); const rd = (v: string) => ks.filter((k: any) => H[k.k].read === v).length / ks.length; const pairsN = ks.reduce((s: number, k: any) => s + ((P[k.k].system_output.prompt.match(/（问）/g) ?? []).length), 0); const mis = ks.reduce((s: number, k: any) => s + H[k.k].mis.length, 0);
  return { n: ks.length, ret: ret.filter((x) => x === '是').length / ret.length, retP: ret.filter((x) => x === '部分').length / ret.length, retL: ret.filter((x) => x === '丢失').length / ret.length, nRet: ret.length, reask: rs.filter((x) => x === '是').length / rs.length, nRe: rs.length, good: rd('好'), ok: rd('可接受'), bad: rd('差'), pairsN, mis, inv: mean(ks.map((k: any) => H[k.k].invented.length)) }; };
console.log('\n版本  路径   ret是  部分  丢失 | reask是 | 错配/配对 | 可读 好/可接受/差 | 编造/份 | n (ret, reask)');
for (const ver of ['v1', 'v2', 'v3']) for (const who of ['asr', 'gold', 'all'] as const) { const s = stat(ver, who); console.log(`${ver}   ${who.padEnd(4)}  ${f(s.ret).padStart(6)} ${f(s.retP).padStart(6)} ${f(s.retL).padStart(6)} | ${f(s.reask).padStart(6)}  | ${s.mis}/${s.pairsN}       | ${f(s.good)}/${f(s.ok)}/${f(s.bad)} | ${s.inv.toFixed(2)} | ${s.n} (${s.nRet}, ${s.nRe})`); }
console.log('\n按链 ret是（ASR 路径；v1 → v2 → v3）:'); for (const id of ['EH5', 'EH6', 'EH7', 'EH8']) { const g = (ver: string) => { const ks = key.filter((k: any) => k.version === ver && k.chain === id && k.voice !== 'gold'); const r = ks.flatMap((k: any) => Object.values(H[k.k].ret)); return f(r.filter((x) => x === '是').length / r.length); }; console.log(`  ${id}: ${g('v1')} → ${g('v2')} → ${g('v3')}`); }
console.log('\nv3 的错配对:'); for (const k of key.filter((x: any) => x.version === 'v3')) for (const m of H[k.k].mis) console.log(' ', k.chain, k.voice.slice(6, 12), m);
console.log('\nv3 中 ret 不是「是」的:'); for (const k of key.filter((x: any) => x.version === 'v3')) for (const [u, v] of Object.entries(H[k.k].ret)) if (v !== '是') console.log(' ', k.chain, k.voice.slice(6, 12), '段' + u, v, '|', String(H[k.k].note).slice(0, 90));
console.log('\nv3 中 reask=是:'); const re: Record<string, number> = {}; for (const k of key.filter((x: any) => x.version === 'v3')) for (const [u, v] of Object.entries(H[k.k].reask)) if (v === '是') re[`${k.chain} 段${u}`] = (re[`${k.chain} 段${u}`] ?? 0) + 1; console.log(' ', JSON.stringify(re));
console.log('\nv3 评为「差」的:'); for (const k of key.filter((x: any) => x.version === 'v3' && H[x.k].read === '差')) console.log(' ', k.chain, k.voice.slice(6, 12), String(H[k.k].note).slice(0, 130));
