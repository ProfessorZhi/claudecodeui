import { readFileSync } from 'node:fs';
export const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ea2';
export type Case = { id: string; session: string; ts: string; prev: string; reply: string; terms: string[]; inPrev: string[] };
export const cases = (): Case[] => JSON.parse(readFileSync(`${LOCAL}/cases.json`, 'utf8'));
export const TERM = /[A-Za-z][A-Za-z0-9_.\-]{2,}|\d+(?:\.\d+)?/g;
export const low = (s: string) => s.toLowerCase().replace(/[^a-z0-9\p{L}]/gu, '');
export function lev(a: string, b: string) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
/** D 的四条校验。ctx = 该臂的上下文。 */
export function applyReplacements(text: string, reps: { from: string; to: string }[], ctx: string) {
  let out = text; const accepted: any[] = []; const rejected: any[] = []; const lc = ctx.toLowerCase();
  for (const r of reps) {
    const from = typeof r?.from === 'string' ? r.from.replace(/^`|`$/g, '') : ''; const to = typeof r?.to === 'string' ? r.to.replace(/^`|`$/g, '') : '';
    const why = !from || !to ? 'shape' : !out.includes(r.from) && !out.includes(from) ? 'from-not-substring' : lc.includes(from.toLowerCase()) ? 'from-in-context' : !ctx.includes(to) ? 'to-not-in-context' : lev(low(from), low(to)) / Math.max(low(from).length, low(to).length, 1) > 0.5 ? 'too-far' : '';
    if (why) { rejected.push({ from, to, why }); continue; }
    out = out.split(out.includes(r.from) ? r.from : from).join(to); accepted.push({ from, to });
  }
  return { out, accepted, rejected };
}
/** M：机械词表基线。 */
export function mechanical(text: string, ctx: string) {
  const vocab = [...new Set(ctx.match(/[A-Za-z][A-Za-z0-9_.\-]{3,}/g) ?? [])]; const vl = new Set(vocab.map((v) => v.toLowerCase())); let out = text; const accepted: any[] = [];
  for (const t of [...new Set(text.match(/[A-Za-z][A-Za-z0-9_.\-]{3,}/g) ?? [])]) { if (vl.has(t.toLowerCase())) continue; let best = '', bd = 1; for (const v of vocab) { const d = lev(low(t), low(v)) / Math.max(low(t).length, low(v).length); if (d < bd) { bd = d; best = v; } } if (best && bd <= 0.3) { out = out.split(t).join(best); accepted.push({ from: t, to: best }); } }
  return { out, accepted };
}
export function topParagraphs(ctx: string, said: string, k = 3) {
  const paras = ctx.split(/\n+/).map((p) => p.trim()).filter(Boolean); const bi = (s: string) => { const t = low(s); const m = new Map<string, number>(); for (let i = 0; i + 2 <= t.length; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1); return m; };
  const docs = paras.map(bi); const df = new Map<string, number>(); for (const d of docs) for (const x of d.keys()) df.set(x, (df.get(x) ?? 0) + 1); const w = (m: Map<string, number>) => { const o = new Map<string, number>(); for (const [x, v] of m) o.set(x, v * Math.log(1 + paras.length / (df.get(x) ?? 1))); return o; }; const nm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((a, b) => a + b * b, 0)) || 1;
  const qv = w(bi(said)); const qn = nm(qv); const sc = docs.map((d, i) => { const dv = w(d); let dot = 0; for (const [x, v] of qv) dot += v * (dv.get(x) ?? 0); return { i, s: dot / (qn * nm(dv)) }; }).sort((a, b) => b.s - a.s).slice(0, k).sort((a, b) => a.i - b.i);
  return sc.map((x) => paras[x.i]).join('\n');
}
