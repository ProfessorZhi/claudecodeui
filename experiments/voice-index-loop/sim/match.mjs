// Candidate generation over an entity map. The scoring is phon.mjs's, frozen; the only addition is the candidate
// bucket (first skeleton letter, skeleton length ± 3, then the same MIN_SIM cut) so thousands of names stay cheap.
import { createRequire } from 'node:module';
import { W, TEMP, MIN_SIM, sound, indexVocab, wordPron } from '../../voice-context-asr/pilot/phon.mjs';
import { normKey } from './lib.mjs';
const req = createRequire('/tmp/vk/npm/node_modules/');
const { doubleMetaphone } = await import(req.resolve('double-metaphone'));
const { dictionary } = await import(req.resolve('cmu-pronouncing-dictionary'));
const skelOf = (s) => doubleMetaphone(s.replace(/[^A-Za-z]/g, ''))[0] ?? '';
const memo = new Map();
const prep = (term) => { let p = memo.get(term); if (!p) { const [v] = indexVocab([{ term }]); p = { pron: v.pron, skel: v.skel, norm: normKey(term) }; memo.set(term, p); } return p; };
const softmax = (xs) => { const m = Math.max(...xs); const e = xs.map((x) => Math.exp((x - m) / TEMP)); const z = e.reduce((a, b) => a + b, 0); return e.map((v) => v / z); };
export const isCommon = (text) => text.split(/\s+/).every((x) => Object.hasOwn(dictionary, x.toLowerCase()));

/** build the lookup structures once per message */
export function buildLookup(ents) {
  const byNorm = new Map(), byFirst = new Map();
  for (const e of ents.values()) {
    const p = prep(e.matchTerm ?? e.term); e.p = p;
    (byNorm.get(p.norm) ?? byNorm.set(p.norm, []).get(p.norm)).push(e);
    if (p.skel) (byFirst.get(p.skel[0]) ?? byFirst.set(p.skel[0], []).get(p.skel[0])).push(e);
  }
  return { byNorm, byFirst };
}
/** spans: { start, end, text, n, candidates: [[word, p]...], top: entity|null, silent: bool, scored } */
export function analyseEnts(text, lookup, { minSim = MIN_SIM, K = 200, maxWin = 4 } = {}) {
  const toks = [...text.matchAll(/[A-Za-z']+/g)].map((m) => ({ s: m.index, e: m.index + m[0].length }));
  const spans = []; let maxScored = 0;
  for (let i = 0; i < toks.length; i++) for (let n = 1; n <= maxWin && i + n <= toks.length; n++) {
    const parts = toks.slice(i, i + n);
    if (n > 1 && parts.some((t, k) => k > 0 && /[^\sA-Za-z']/.test(text.slice(parts[k - 1].e, t.s)))) break;
    const s = parts[0].s, e = parts[n - 1].e, wt = text.slice(s, e), wn = normKey(wt);
    const cands = new Map();
    for (const ent of lookup.byNorm.get(wn) ?? []) if (ent.term !== wt) cands.set(ent.term, { ent, sim: 1, exact: true });
    const ws = n <= 4 ? skelOf(wt) : '';
    if (ws && !cands.size) {
      const pool = (lookup.byFirst.get(ws[0]) ?? []).filter((ent) => Math.abs(ent.p.skel.length - ws.length) <= 3);
      const scored = [];
      for (const ent of pool) { if (ent.p.norm === wn && !ent.matchTerm) continue; if (ent.p.norm === wn) continue; const sim = sound(wt, ent.term, ent.p.pron, ent.p.skel); if (sim >= minSim) scored.push({ ent, sim }); }
      scored.sort((a, b) => b.sim - a.sim); maxScored = Math.max(maxScored, pool.length);
      for (const c of scored.slice(0, K)) if (!cands.has(c.ent.term) || cands.get(c.ent.term).sim < c.sim) cands.set(c.ent.term, c);
    }
    if (!cands.size) continue;
    const common = isCommon(wt) ? 1 : 0;
    const rows = [...cands.values()].map((c) => ({ word: c.ent.term, ent: c.ent, exact: c.exact, sim: c.sim, sc: W.sound * c.sim + W.project * (c.ent.prior ? 1 : 0) + W.recent * (c.ent.recent ? 1 : 0) + W.history * Math.min(1, c.ent.count / 5) }));
    const inc = { word: wt, ent: null, sim: 1, sc: W.sound + W.project * common };
    const all = [inc, ...rows.sort((a, b) => b.sc - a.sc)];
    const probs = softmax(all.map((x) => x.sc));
    const ranked = all.map((x, k) => ({ ...x, p: probs[k] })).sort((a, b) => b.p - a.p);
    spans.push({ start: s, end: e, text: wt, n, candidates: ranked.map((x) => [x.word, +x.p.toFixed(3)]), top: ranked[0].ent, topWord: ranked[0].word, topP: ranked[0].p, silent: !!ranked[0].exact && ranked[0].word !== wt, rows: ranked });
  }
  const isRep = (x) => (x.topWord !== x.text ? 1 : 0);
  spans.sort((a, b) => isRep(b) - isRep(a) || b.topP - a.topP || b.n - a.n);
  const kept = []; for (const s of spans) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  return { spans: kept.sort((a, b) => a.start - b.start), maxScored };
}
