// Offline what-if over A2 data (NOT part of PREREG): use conversation context only when the no-context output
// contains an identifier-looking fragment that has a close, not-identical name in the context.
//   npx tsx experiments/voice-omni-written/a2/conditional.mts
import { readFileSync } from 'node:fs';
import { CONDS, instructionOf } from '../raw/written.mts';
import { judge } from '../raw/judge.mts';
import { judgeExt } from '../raw/judge-ext.mts';
import { idsOf, has } from './strata.mjs';
import { semantic } from './semantic.mts';
const E = CONDS.find((c) => c.key === 'E-twostep-low')!;
const rows = readFileSync(new URL('./results.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200);
const CTX: Record<string, string> = Object.fromEntries(JSON.parse(readFileSync(new URL('../fixtures/a2-contexts.json', import.meta.url), 'utf8')).contexts.map((c: any) => [c.key, c.text]));
const ins = (r: any) => instructionOf(E, r.text).instruction;
const SEM = process.env.JUDGE === 'semantic';
const V = (set: string, clip: string, text: string) => SEM ? semantic({ set, clip, text: JSON.stringify({ transcript: '', instruction: text }) })[0] : (set === 'base' ? judge(clip, text) : judgeExt(clip, text))[0];
const low = (s: string) => s.toLowerCase();
function lev(a: string, b: string) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
// identifier-looking fragments in an output: backticked spans, dotted tokens, camelCase
const frags = (t: string) => [...new Set([...t.matchAll(/`([^`]{3,60})`/g)].map((m) => m[1]).concat([...t.matchAll(/[A-Za-z_][\w-]*(?:[.\/][\w-]+)+|[a-z]+[A-Z][A-Za-z0-9]*/g)].map((m) => m[0])))];
const key = (s: string) => low(s).replace(/[^a-z0-9]/g, '');
/** best close name in the context for one fragment, or null. Close = normalized distance on alnum-only keys <= 0.34, not identical. */
function closest(frag: string, names: string[]) {
  const k = key(frag); if (k.length < 5) return null;
  let best: { name: string; d: number } | null = null, tie = false;
  for (const n of names) { const kn = key(n); if (kn === k) return null; const d = lev(k, kn) / Math.max(k.length, kn.length); if (d > 0.34) continue; if (!best || d < best.d) { best = { name: n, d }; tie = false; } else if (d === best.d) tie = true; }
  return best && !tie ? best.name : null;
}
const out: Record<string, { n: number; ok: number; bad: number; trig: number }> = {};
const add = (k: string, v: string, trig = false) => { const o = (out[k] ??= { n: 0, ok: 0, bad: 0, trig: 0 }); o.n++; if (v === '✅') o.ok++; if (v === '❌') o.bad++; if (trig) o.trig++; };
const perSet: Record<string, Record<string, { n: number; ok: number; bad: number; trig: number }>> = {};
for (const ctx of Object.keys(CTX)) {
  const names = [...idsOf(CTX[ctx], ['file', 'camel']).keys()];
  for (const clip of [...new Set(rows.map((r) => r.clip))]) {
    const none = rows.filter((r) => r.cond === 'none' && r.clip === clip); const withCtx = rows.filter((r) => r.cond === ctx && r.clip === clip);
    if (!withCtx.length) continue; const set = none[0].set;
    const ctxOkRate = withCtx.filter((r) => V(set, clip, ins(r)) === '✅').length / withCtx.length;
    const ctxBadRate = withCtx.filter((r) => V(set, clip, ins(r)) === '❌').length / withCtx.length;
    for (const r of none) {
      const t = ins(r); const base = V(set, clip, t);
      const hits = frags(t).map((f) => [f, closest(f, names)] as const).filter(([, n]) => n);
      const trig = hits.length > 0;
      const rec = (k: string, v: string, tr = false) => { add(`${set}:${k}`, v, tr); add(`all:${k}`, v, tr); };
      rec('none', base);
      for (const r2 of withCtx) rec('always-context', V(set, clip, ins(r2)));
      // conditional second call: expected verdict mix when triggered
      const o = (out[`${set}:conditional-call`] ??= { n: 0, ok: 0, bad: 0, trig: 0 }), a = (out['all:conditional-call'] ??= { n: 0, ok: 0, bad: 0, trig: 0 });
      for (const x of [o, a]) { x.n++; if (trig) { x.trig++; x.ok += ctxOkRate; x.bad += ctxBadRate; } else { if (base === '✅') x.ok++; if (base === '❌') x.bad++; } }
      // local replacement: swap each hit fragment for its close name
      let rep = t; for (const [f, n] of hits) rep = rep.split(f).join(n!); rec('local-replace', V(set, clip, rep), trig);
    }
  }
}
const pct = (x: number, n: number) => `${((100 * x) / n).toFixed(1)}%`;
for (const k of Object.keys(out).sort()) { const o = out[k]; console.log(k.padEnd(28), `n=${o.n}`.padEnd(8), `✅ ${pct(o.ok, o.n)}`.padEnd(12), `❌ ${pct(o.bad, o.n)}`.padEnd(12), k.includes('none') || k.includes('always') ? '' : `triggered ${pct(o.trig, o.n)}`); }
