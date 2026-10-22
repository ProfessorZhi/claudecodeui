// E5 step 1: for every selected message, the windows and candidates each arm would see (relaxed similarity 0.6, top K = 15),
// computed with exactly the entities the replay offered at that moment. Written outside the repo.
import { writeFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
import { buildLookup, analyseEnts } from './match.mjs';
const out = [];
replay({ name: 'e5', sources: new Set(['P', 'C', 'U']), variants: ['templates'], onEnts: ({ m, asr, ents }) => {
  const lk = buildLookup(ents);
  const pack = (minSim) => analyseEnts(asr, lk, { minSim, K: 15 }).spans.map((s) => ({ start: s.start, end: s.end, text: s.text, n: s.n, rank: s.candidates.slice(0, 15), rows: s.rows.filter((r) => r.ent).slice(0, 15).map((r) => ({ word: r.word, sim: +r.sim.toFixed(2), recent: !!r.ent.recent, srcs: [...r.ent.sources].join(''), type: r.ent.type })) }));
  out.push({ id: m.id, text: asr, w75: pack(0.75), w60: pack(0.6) });
} });
writeFileSync(ROOT + 'e5-windows.json', JSON.stringify(out));
const c60 = out.reduce((a, x) => a + x.w60.length, 0), c75 = out.reduce((a, x) => a + x.w75.length, 0);
console.log('messages', out.length, 'windows@0.75', c75, 'windows@0.6', c60);
