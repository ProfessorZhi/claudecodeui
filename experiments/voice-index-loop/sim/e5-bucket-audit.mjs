// E5 limitation 5: does bucketing (first skeleton letter, length ± 3) lose candidates? For every harmful error, rescore the
// windows over its heard region against ALL entities (no bucket) and compare with the bucketed top-15 at the same threshold.
import { readFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
import { buildLookup, analyseEnts } from './match.mjs';
import { sound } from '../../voice-context-asr/pilot/phon.mjs';
import { normKey } from './lib.mjs';
const items = JSON.parse(readFileSync(ROOT + 'e4-items.json', 'utf8'));
const verdict = new Map(readFileSync(ROOT + 'e4-judge.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const harmful = items.filter((i) => verdict.get(i.k) === 'wrong' && i.heard && /[A-Za-z]/.test(i.heard));
const byMsg = new Map(); for (const i of harmful) (byMsg.get(i.id) ?? byMsg.set(i.id, []).get(i.id)).push(i);
let n = 0, inB = 0, inU = 0, differ = 0;
replay({ name: 'a', sources: new Set(['P', 'C', 'U']), variants: ['templates'], onEnts: ({ m, asr, ents }) => {
  for (const it of byMsg.get(m.id) ?? []) {
    const lk = buildLookup(ents); const B = analyseEnts(asr, lk, { minSim: 0.6, K: 15 }).spans;
    const s0 = asr.indexOf(it.heard); if (s0 < 0) continue; const reg = { start: s0, end: s0 + it.heard.length };
    n++;
    const bucketed = B.filter((s) => s.start < reg.end && reg.start < s.end).some((s) => s.rows.some((r) => r.word === it.tok));
    // unbucketed: every window of 1-4 words that overlaps the region, all entities, same threshold; keep top-15 by similarity
    const toks = [...asr.matchAll(/[A-Za-z']+/g)].map((x) => ({ s: x.index, e: x.index + x[0].length })); let unb = false;
    for (let i = 0; i < toks.length; i++) for (let k = 1; k <= 4 && i + k <= toks.length; k++) { const w = { start: toks[i].s, end: toks[i + k - 1].e }; if (!(w.start < reg.end && reg.start < w.end)) continue; const wt = asr.slice(w.start, w.end); const sc = [];
      for (const e of ents.values()) { if (normKey(e.term) === normKey(wt)) continue; const sim = sound(wt, e.term, e.p?.pron, e.p?.skel); if (sim >= 0.6) sc.push({ term: e.term, sim }); }
      sc.sort((a, b) => b.sim - a.sim); if (sc.slice(0, 15).some((x) => x.term === it.tok)) unb = true; }
    inB += bucketed; inU += unb; differ += bucketed !== unb;
  }
} });
console.log(`harmful errors with a Latin heard form: ${n}; gold in bucketed top-15: ${inB}; gold in unbucketed top-15: ${inU}; windows where they differ: ${differ}`);
