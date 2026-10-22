// E5 step 3: score every arm on the harmful errors (judge = wrong), the M-class errors, damage to correct tokens, and the traps.
import { readFileSync, existsSync } from 'node:fs';
import { ROOT, replay } from './replay.mjs';
import { has, normKey } from './lib.mjs';
const wins = new Map(JSON.parse(readFileSync(ROOT + 'e5-windows.json', 'utf8')).map((m) => [m.id, m]));
const tw = new Map(JSON.parse(readFileSync(ROOT + 'e5-traps-windows.json', 'utf8')).map((m) => [m.id, m]));
const load = (f) => (existsSync(ROOT + f) ? readFileSync(ROOT + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const picks = new Map(); for (const r of [...load('e5-llm.jsonl'), ...load('e5-traps-llm.jsonl')]) picks.set(`${r.id}|${r.i}|${r.arm}|${r.model}`, r);
const items = JSON.parse(readFileSync(ROOT + 'e4-items.json', 'utf8'));
const verdict = new Map(load('e4-judge.jsonl').filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '   -  ');
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const { recs } = replay({ name: 'e5', sources: new Set(['P', 'C', 'U']), variants: ['templates'] });
const tokRecs = recs.filter((x) => x.tok);

// L2a: silent shape repair (exact up to case / spaces / hyphens) from the 0.75 windows
const silentOf = (m) => m.w75.filter((w) => w.rank[0][0] !== w.text && normKey(w.rank[0][0]) === normKey(w.text)).map((w) => ({ start: w.start, end: w.end, to: w.rank[0][0], by: 'L2a' }));
const applyAll = (text, reps) => { let o = text; for (const r of [...reps].sort((a, b) => b.start - a.start)) o = o.slice(0, r.start) + r.to + o.slice(r.end); return o; };
const flaggedOf = (list, silent) => list.filter((w) => w.rank[0][0] !== w.text && w.rank[0][1] >= 0.5 && !silent.some((s) => overlap(s, w)));

const ARMS = [
  { name: 'L2a only (base)', extra: () => [] },
  { name: 'H0 D1 .75 flag only / applied top-1', flag: (m, sil) => flaggedOf(m.w75, sil), apply: true },
  { name: 'H1 D1 .60 flag only / applied top-1', flag: (m, sil) => flaggedOf(m.w60, sil), apply: true },
  ...[['H2', 'mistralai/ministral-3b-2512'], ['H2', 'qwen/qwen-2.5-7b-instruct'], ['H3', 'mistralai/ministral-3b-2512'], ['H3', 'qwen/qwen-2.5-7b-instruct'], ['H4', 'qwen/qwen3.8-27b']].map(([arm, model]) => ({ name: `${arm} ${model.split('/')[1]}`, arm, model })),
];
function systemExtra(a, m, sil, store) {
  if (a.name.startsWith('L2a')) return [];
  if (a.flag) return a.apply ? a.flag(m, sil).map((w) => ({ start: w.start, end: w.end, to: w.rank[0][0], by: 'top1' })) : [];
  const out = [];
  m.w60.forEach((w, i) => { if (!w.rows.length || sil.some((s) => overlap(s, w))) return; const p = store.get(`${m.id}|${i}|${a.arm}|${a.model}`); if (!p) return; if (p.pick > 0) out.push({ start: w.start, end: w.end, to: w.rows[p.pick - 1].word, by: a.arm }); });
  return out;
}
const harmfulItems = items.filter((i) => verdict.get(i.k) === 'wrong');
const mItems = items.filter((i) => i.cls === 'M' && !i.ruleTolerable);
console.log(`harmful errors (judge = wrong) ${harmfulItems.length}; M-class (not rule-tolerable) ${mItems.length}; correct tokens ${tokRecs.filter((x) => x.hitAsr).length}`);
const regionOf = (m, it) => { const s = it.heard ? m.text.indexOf(it.heard) : -1; return s < 0 ? null : { start: s, end: s + it.heard.length }; };
for (const a of ARMS) {
  const stat = { hFix: 0, hFixList: 0, h3: 0, mFix: 0, dmg: 0, base: 0, off: 0, repl: 0, chars: 0, hList: 0 };
  const post = new Map();
  for (const m of wins.values()) {
    const sil = silentOf(m); const extra = systemExtra(a, m, sil, picks);
    const P = applyAll(m.text, [...sil, ...extra]); post.set(m.id, P); stat.chars += m.text.length;
    stat.repl += extra.length;
  }
  for (const it of harmfulItems.concat([])) { const m = wins.get(it.id), P = post.get(it.id); if (!m) continue; const reg = regionOf(m, it);
    if (has(P, it.tok)) stat.hFix++;
    if (reg) { const ws = m.w60.filter((w) => overlap(w, reg)); if (ws.some((w) => w.rows.some((r) => r.word === it.tok))) stat.hList++; if ((a.flag ? a.flag(m, silentOf(m)) : []).concat(a.flag ? [] : []).some((w) => overlap(w, reg) && w.rank.slice(0, 3).some(([x]) => x === it.tok))) stat.h3++; } }
  for (const it of mItems) { const P = post.get(it.id); if (P && has(P, it.tok)) stat.mFix++; }
  const errRegs = new Map(); for (const it of items) { const m = wins.get(it.id); const r = m && regionOf(m, it); if (r) (errRegs.get(it.id) ?? errRegs.set(it.id, []).get(it.id)).push(r); }
  for (const x of tokRecs.filter((y) => y.hitAsr)) { const P = post.get(x.id); if (P && !has(P, x.tok)) stat.dmg++; }
  for (const m of wins.values()) { const extra = systemExtra(a, m, silentOf(m), picks); for (const e of extra) if (!(errRegs.get(m.id) ?? []).some((r) => overlap(r, e))) stat.off++; }
  const nOk = tokRecs.filter((x) => x.hitAsr).length;
  // traps
  let trap = 0, trapN = 0, neu = 0, neuN = 0;
  for (const m of tw.values()) { const sil = silentOf(m); const extra = a.name.startsWith('L2a') ? [] : a.flag ? (a.apply ? a.flag(m, sil).map((w) => ({ start: w.start, end: w.end, to: w.rank[0][0] })) : []) : (() => { const o = []; m.w60.forEach((w, i) => { const p = picks.get(`${m.id}|${i}|${a.arm}|${a.model}`); if (p && p.pick > 0 && !sil.some((s) => overlap(s, w))) o.push({ start: w.start, end: w.end, to: w.rows[p.pick - 1].word }); }); return o; })(); const P = applyAll(m.text, [...sil, ...extra]);
    if (/^tr[1-7]$/.test(m.id)) { trapN++; if (P !== m.text) trap++; } else { neuN++; if (P !== m.text) neu++; } }
  const llm = a.arm ? [...picks.values()].filter((p) => p.arm === a.arm && p.model === a.model) : [];
  console.log(`\n${a.name}\n  harmful fixed(applied) ${pct(stat.hFix, harmfulItems.length)} | in candidate list@15 ${pct(stat.hList, harmfulItems.length)}${a.flag ? ` | flagged + gold in top-3 ${pct(stat.h3, harmfulItems.length)}` : ''} | M-class fixed ${pct(stat.mFix, mItems.length)}`);
  console.log(`  correct tokens broken ${pct(stat.dmg, nOk)} | extra replacements ${stat.repl} (${(100 * stat.repl / stat.chars).toFixed(2)}/100ch), off-error ${stat.off} | traps replaced ${pct(trap, trapN)} neutral changed ${pct(neu, neuN)}${llm.length ? ` | parse ok ${pct(llm.filter((p) => p.parsed).length, llm.length)}` : ''}`);
}
