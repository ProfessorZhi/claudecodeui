import { readFileSync } from 'node:fs';
import { allClips } from './clips.mjs';
import { POOL, OTHER_PROJECT, others } from './cases.mjs';
export const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-context-asr/';
export const clips = new Map(allClips().map((c) => [c.id, c]));
export const asr = readFileSync(ROOT + 'asr-text.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200 && r.text != null);
const stem = (s) => s.split('-')[0].toLowerCase();
export function vocabFor(cond, targets) {
  const recent6 = [...targets, ...others(targets, 6 - targets.length)];
  if (cond === 'V1') return POOL.map((t) => ({ term: t, recent: recent6.includes(t) }));
  const bad = new Set(targets.map(stem));
  if (cond === 'V5') { const r = others(targets, 6); return POOL.filter((t) => !bad.has(stem(t))).map((t) => ({ term: t, recent: r.includes(t) })); }
  if (cond === 'V4') return OTHER_PROJECT.map((t) => ({ term: t, recent: true }));
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const has = (text, term) => !!text && new RegExp(`(?<![A-Za-z0-9_-])${esc(term)}(?![A-Za-z0-9_]|-[A-Za-z])`).test(text.replace(/`/g, ''));
export const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// error region of an ASR text against gold, in whitespace-stripped coordinates (single slot clips only)
export function region(asrText, gold) {
  const strip = (s) => { const idx = []; let o = ''; for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { o += s[i]; idx.push(i); } return { o, idx }; };
  const a = strip(asrText), g = strip(gold);
  let p = 0; while (p < a.o.length && p < g.o.length && a.o[p].toLowerCase() === g.o[p].toLowerCase()) p++;
  let q = 0; while (q < a.o.length - p && q < g.o.length - p && a.o[a.o.length - 1 - q].toLowerCase() === g.o[g.o.length - 1 - q].toLowerCase()) q++;
  const s = p, e = a.o.length - q; if (e <= s) return null;
  return { start: a.idx[s], end: a.idx[e - 1] + 1, text: asrText.slice(a.idx[s], a.idx[e - 1] + 1), goldPart: g.o.slice(p, g.o.length - q) };
}
