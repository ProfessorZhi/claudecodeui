// Reports E1 (flag + find, source ablation) and E3 (convergence).   npx tsx experiments/voice-index-loop/sim/run.mjs [e1|e3|all]
import { replay } from './replay.mjs';
import { shapeType } from './lib.mjs';
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '   -  ');
const SRC = (s) => new Set(s.split(''));
const LEGACY = process.env.LEGACY_KEYS ? ['legacyKeys'] : [];   // the pre-registered run used normKey for alias keys (drops CJK)
const which = process.argv[2] ?? 'all';

function e1() {
  const cfgs = [['B', { baseline: true }], ['P', { sources: SRC('P') }], ['C', { sources: SRC('C') }], ['U', { sources: SRC('U') }], ['PC', { sources: SRC('PC') }], ['PU', { sources: SRC('PU') }], ['CU', { sources: SRC('CU') }], ['PCU', { sources: SRC('PCU') }]];
  console.log('\n===== E1  flag + find (no learning; U = earlier sent text only)');
  let any = null;
  for (const [name, c] of cfgs) {
    const { recs, maxScored, violations } = replay({ name, ...c });
    const toks = recs.filter((r) => r.tok), msgs = recs.filter((r) => r.msg);
    const err = toks.filter((r) => r.wrongAsr);
    const reach = (r) => r.inP || r.inC || r.inU;
    const found = (r) => r.hitPost || (r.flagged && r.rank && r.rank <= 3);
    const chars = msgs.reduce((a, m) => a + m.chars, 0), flags = msgs.reduce((a, m) => a + m.flags, 0), off = msgs.reduce((a, m) => a + m.flagsOff, 0);
    const changes = msgs.reduce((a, m) => a + m.changes, 0), harm = msgs.reduce((a, m) => a + m.harm, 0);
    const damaged = toks.filter((r) => r.hitAsr && !r.hitPost).length;
    console.log(`\n-- ${name}   errors ${err.length} of ${toks.length} id tokens in ${msgs.length} msgs | invariant violations ${violations.length}`);
    console.log(`   fixed silently ${pct(err.filter((r) => r.hitPost).length, err.length)} | flagged ${pct(err.filter((r) => r.flagged).length, err.length)} | cand@1 ${pct(err.filter((r) => r.rank === 1).length, err.length)} @3 ${pct(err.filter((r) => r.rank && r.rank <= 3).length, err.length)} | FOUND (fixed or flagged+@3) ${pct(err.filter(found).length, err.length)}  | of reachable ${pct(err.filter((r) => reach(r) && found(r)).length, err.filter(reach).length)}`);
    console.log(`   noise: flags/100 chars ${(100 * flags / chars).toFixed(2)}  off-target flags ${pct(off, flags)} | silent changes ${changes}, harmful ${harm} | correct-in-ASR tokens damaged ${pct(damaged, toks.filter((r) => r.hitAsr).length)}`);
    if (name === 'PCU') any = { toks, err, found, reach };
    if (name === 'PCU') console.log(`   by class: S ${pct(err.filter((r) => r.cls === 'S' && found(r)).length, err.filter((r) => r.cls === 'S').length)}  M ${pct(err.filter((r) => r.cls === 'M' && found(r)).length, err.filter((r) => r.cls === 'M').length)}  | max candidates bucketed per window ${maxScored}`);
  }
  // attribution and type breakdown on PCU
  const { err, found, reach } = any;
  const fnd = err.filter(found);
  console.log('\n-- attribution among FOUND errors in PCU (a source "provides" a token if it contains it at that time)');
  for (const s of ['inP', 'inC', 'inU']) console.log(`   ${s}: provides ${pct(fnd.filter((r) => r[s]).length, fnd.length)}   sole provider ${pct(fnd.filter((r) => r[s] && ['inP', 'inC', 'inU'].filter((x) => r[x]).length === 1).length, fnd.length)}`);
  console.log(`   errors reachable by NO source (true new words, the ceiling): ${pct(err.filter((r) => !reach(r)).length, err.length)}`);
  console.log('\n-- why reachable errors were NOT found (PCU)');
  const miss = new Map(); for (const r of err.filter((x) => reach(x) && !found(x))) { const k = !r.reg ? 'no aligned region (deleted)' : !/[A-Za-z]/.test(r.reg) ? 'heard without Latin letters (Chinese / digits rendering)' : r.rank == null ? 'Latin heard, no candidate above the similarity cut' : 'candidate present but ranked > 3'; miss.set(k, (miss.get(k) ?? 0) + 1); }
  for (const [k, v] of [...miss].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(3)}  ${k}`);
  console.log('\n-- by shape (PCU): errors, found, unreachable');
  const by = new Map(); for (const r of err) { const k = shapeType(r.tok); const o = by.get(k) ?? { n: 0, f: 0, u: 0 }; o.n++; if (found(r)) o.f++; if (!reach(r)) o.u++; by.set(k, o); }
  for (const [k, o] of [...by].sort((a, b) => b[1].n - a[1].n)) console.log(`   ${k.padEnd(9)} n=${String(o.n).padStart(3)}  found ${pct(o.f, o.n)}  unreachable ${pct(o.u, o.n)}`);
}

function e3() {
  const arms = [['A0 shipped (file names)', { baseline: true }], ['A1 sources, no learning', { sources: SRC('PCU') }], ['A2 sources + learn(1)', { sources: SRC('PCU'), learn: { promoteAfter: 1 } }], ['A3 sources + learn(2)', { sources: SRC('PCU'), learn: { promoteAfter: 2 } }], ['A4 learning only', { sources: new Set(), learn: { promoteAfter: 1 } }]];
  console.log('\n===== E3  convergence (windows of 50 selected messages; burden = identifier tokens still wrong / identifier tokens)');
  const W = 50; const table = [];
  for (const [name, c] of arms) {
    const { recs, violations } = replay({ name, ...c, variants: LEGACY });
    const toks = recs.filter((r) => r.tok), msgs = recs.filter((r) => r.msg);
    const byMsg = []; const order = [...new Set(msgs.map((m) => m.id))];
    const win = (id) => Math.floor(order.indexOf(id) / W);
    const nW = Math.ceil(order.length / W); const rows = Array.from({ length: nW }, () => ({ n: 0, wrong: 0, rawWrong: 0, repeat: 0, newword: 0, harm: 0, changes: 0 }));
    for (const r of toks) { const w = rows[win(r.id)]; w.n++; if (!r.hitPost) { w.wrong++; if (r.repeat) w.repeat++; if (!r.seenBefore) w.newword++; } if (r.wrongAsr) w.rawWrong++; }
    for (const m of msgs) { const w = rows[win(m.id)]; w.harm += m.harm; w.changes += m.changes; }
    table.push({ name, rows, violations: violations.length });
  }
  const hdr = table[0].rows.map((_, i) => `w${i + 1}`.padStart(6)).join('');
  console.log('\nburden by window (tokens still wrong after the system, %)'.padEnd(34) + hdr);
  for (const t of table) console.log(t.name.padEnd(34) + t.rows.map((w) => `${(100 * w.wrong / Math.max(1, w.n)).toFixed(0)}%`.padStart(6)).join(''));
  console.log('raw ASR error rate'.padEnd(34) + table[0].rows.map((w) => `${(100 * w.rawWrong / Math.max(1, w.n)).toFixed(0)}%`.padStart(6)).join(''));
  console.log('\nrepeat-correction share of the remaining errors (%), and new-word share');
  for (const t of table) console.log(t.name.padEnd(34) + t.rows.map((w) => `${(100 * w.repeat / Math.max(1, w.wrong)).toFixed(0)}%`.padStart(6)).join('') + '   | new-word ' + t.rows.map((w) => `${(100 * w.newword / Math.max(1, w.wrong)).toFixed(0)}%`.padStart(5)).join(''));
  console.log('\nharm (system changes the user had to revert) per window');
  for (const t of table) console.log(t.name.padEnd(34) + t.rows.map((w) => String(w.harm).padStart(6)).join('') + `   | invariant violations ${t.violations}`);
  console.log('\nconvergence: last third / first third of the burden');
  for (const t of table) { const k = Math.max(1, Math.floor(t.rows.length / 3)); const f = t.rows.slice(0, k), l = t.rows.slice(-k); const rate = (a) => a.reduce((s, w) => s + w.wrong, 0) / Math.max(1, a.reduce((s, w) => s + w.n, 0)); const rep = (a) => a.reduce((s, w) => s + w.repeat, 0) / Math.max(1, a.reduce((s, w) => s + w.wrong, 0)); console.log(`${t.name.padEnd(34)} first ${(100 * rate(f)).toFixed(1)}%  last ${(100 * rate(l)).toFixed(1)}%  ratio ${(rate(l) / rate(f)).toFixed(2)}   repeat-share after window 2: ${(100 * rep(t.rows.slice(2))).toFixed(1)}%`); }
}
if (which === 'e1' || which === 'all') e1();
if (which === 'e3' || which === 'all') e3();
