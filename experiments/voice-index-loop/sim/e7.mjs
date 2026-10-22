// E7: convergence counted in HARMFUL errors (judge = wrong) and in M-class errors (not rule-tolerable), with L2a + templates in the base.
import { readFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
const items = JSON.parse(readFileSync(ROOT + `e4-items${process.env.TAG ? '-' + process.env.TAG : ''}.json`, 'utf8'));
const verdict = new Map(readFileSync(ROOT + `e4-judge${process.env.TAG ? '-' + process.env.TAG : ''}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const harmful = new Set(items.filter((i) => verdict.get(i.k) === 'wrong').map((i) => `${i.id}|${i.tok}`));
const mclass = new Set(items.filter((i) => i.cls === 'M' && !i.ruleTolerable).map((i) => `${i.id}|${i.tok}`));
const S = (s) => new Set(s.split(''));
const arms = [['T1 sources + L2a', { sources: S('PCU'), variants: ['templates'] }], ['T2 + learn(1)', { sources: S('PCU'), learn: { promoteAfter: 1 }, variants: ['templates'] }], ['T3 + learn(2)', { sources: S('PCU'), learn: { promoteAfter: 2 }, variants: ['templates'] }], ['T4 = T2 without history import', { sources: S('PCU'), learn: { promoteAfter: 1 }, variants: ['templates', 'noImport'] }]];
const W = 50;
const pct = (v) => `${(100 * v).toFixed(1)}%`;
for (const [label, set] of [['HARMFUL errors (judge = wrong)', harmful], ['M-class errors (not rule-tolerable)', mclass]]) {
  console.log(`\n===== ${label}: still wrong after the system / all identifier tokens`);
  const out = [];
  for (const [name, c] of arms) {
    const { recs } = replay({ name, ...c });
    const toks = recs.filter((r) => r.tok); const order = [...new Set(recs.filter((r) => r.msg).map((r) => r.id))];
    const win = (id) => Math.floor(order.indexOf(id) / W); const nW = Math.ceil(order.length / W);
    const rows = Array.from({ length: nW }, () => ({ n: 0, bad: 0, rep: 0, any: 0 }));
    for (const r of toks) { const w = rows[win(r.id)]; w.n++; const isErr = set.has(`${r.id}|${r.tok}`); if (isErr && !r.hitPost) w.bad++; if (isErr && !r.hitPost && r.repeat) w.rep++; if (!r.hitPost) w.any++; }
    out.push({ name, rows, total: rows.reduce((a, w) => a + w.bad, 0), n: rows.reduce((a, w) => a + w.n, 0) });
  }
  console.log('arm'.padEnd(34) + out[0].rows.map((_, i) => `w${i + 1}`.padStart(5)).join('') + '   total   first3rd -> last3rd  ratio');
  for (const o of out) { const k = Math.floor(o.rows.length / 3); const sum = (a, f) => a.reduce((s, w) => s + w[f], 0); const f = sum(o.rows.slice(0, k), 'bad') / sum(o.rows.slice(0, k), 'n'), l = sum(o.rows.slice(-k), 'bad') / sum(o.rows.slice(-k), 'n');
    console.log(o.name.padEnd(34) + o.rows.map((w) => String(w.bad).padStart(5)).join('') + `   ${String(o.total).padStart(4)}/${o.n}  ${pct(f)} -> ${pct(l)}  ${(l / f).toFixed(2)}`); }
  const t2 = out[1], t4 = out[3]; console.log(`history import: first two windows, errors left T2 ${t2.rows[0].bad + t2.rows[1].bad} vs T4 ${t4.rows[0].bad + t4.rows[1].bad}  (tokens ${t2.rows[0].n + t2.rows[1].n})`);
}
