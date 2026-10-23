// EXPLORATORY (not pre-registered): what the first run's failure taxonomy suggests. Each variant is a labelled change
// to the system; the numbers here motivate the next pre-registration, they do not replace the pre-registered readings.
import { replay } from './replay.mjs';
import { shapeType } from './lib.mjs';
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '  -  ');
const S = (s) => new Set(s.split(''));
const variants = [['base (pre-registered)', []], ['X1 recent counts as prior', ['cPrior']], ['X1+X2 long windows for exact names', ['cPrior', 'longWindow']], ['X1+X2+X3 spoken-form templates', ['cPrior', 'longWindow', 'templates']], ['X4 learned heard forms as sound-alikes (on base)', ['aliasForms']], ['X1+X2+X3+X4', ['cPrior', 'longWindow', 'templates', 'aliasForms']]];
for (const [name, v] of variants) {
  const a1 = replay({ name, sources: S('PCU'), variants: v }), a2 = replay({ name, sources: S('PCU'), learn: { promoteAfter: 1 }, variants: v });
  const rep = (r) => { const toks = r.recs.filter((x) => x.tok), msgs = r.recs.filter((x) => x.msg); const err = toks.filter((x) => x.wrongAsr); const found = (x) => x.hitPost || (x.flagged && x.rank && x.rank <= 3);
    const order = [...new Set(msgs.map((m) => m.id))]; const k = Math.ceil(order.length / 3); const part = (lo, hi) => { const ids = new Set(order.slice(lo, hi)); const t = toks.filter((x) => ids.has(x.id)); return t.filter((x) => !x.hitPost).length / Math.max(1, t.length); };
    const byS = {}; for (const x of err) { const c = shapeType(x.tok); (byS[c] ??= [0, 0])[1]++; if (found(x)) byS[c][0]++; }
    const rem = toks.filter((x) => !x.hitPost); const first = part(0, k), last = part(order.length - k, order.length);
    return { err: err.length, found: err.filter(found).length, silent: err.filter((x) => x.hitPost).length, damaged: toks.filter((x) => x.hitAsr && !x.hitPost).length, ok: toks.filter((x) => x.hitAsr).length, flags: msgs.reduce((s, m) => s + m.flags, 0), chars: msgs.reduce((s, m) => s + m.chars, 0), harm: msgs.reduce((s, m) => s + m.harm, 0), changes: msgs.reduce((s, m) => s + m.changes, 0), first, last, repeat: rem.filter((x) => x.repeat).length / Math.max(1, rem.length), byS, burdenAll: rem.length / Math.max(1, toks.length) }; };
  const r1 = rep(a1), r2 = rep(a2);
  console.log(`\n### ${name}`);
  console.log(`  A1 (no learning)  FOUND ${pct(r1.found, r1.err)}  silent-fixed ${pct(r1.silent, r1.err)}  damaged-correct ${pct(r1.damaged, r1.ok)}  flags/100ch ${(100 * r1.flags / r1.chars).toFixed(2)}  harmful changes ${r1.harm}/${r1.changes}  burden overall ${(100 * r1.burdenAll).toFixed(1)}%`);
  console.log(`  A2 (learn, 1)     burden first third ${(100 * r2.first).toFixed(1)}% -> last ${(100 * r2.last).toFixed(1)}%  ratio ${(r2.last / r2.first).toFixed(2)}  repeat-share of remaining errors ${(100 * r2.repeat).toFixed(1)}%  overall burden ${(100 * r2.burdenAll).toFixed(1)}%`);
  console.log('  found by shape (A1): ' + Object.entries(r1.byS).map(([k, [f, n]]) => `${k} ${f}/${n}`).join('  '));
}
