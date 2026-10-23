// E5 negative control: the `key` trap sentences and neutral sentences from the previous round, with the vocabulary V1
// (project terms, quay among them recent). Same window / candidate construction as e5-build.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLookup, analyseEnts } from './match.mjs';
import { vocabFor } from '../../voice-context-asr/pilot/common2.mjs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const asr = readFileSync('/data/home/yale/work/tc-verify/corpus/voice-context-asr/asr-text.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.model.endsWith('1.7b') && /^(tr|ne)\d/.test(r.id) && r.text);
const ents = new Map(vocabFor('V1', ['quay']).map((v) => [v.term, { term: v.term, sources: new Set(['P']), recent: v.recent, prior: true, count: 0, type: 'term' }]));
const lk = buildLookup(ents);
const out = asr.map((r) => { const pack = (minSim) => analyseEnts(r.text, lk, { minSim, K: 15 }).spans.map((s) => ({ start: s.start, end: s.end, text: s.text, n: s.n, rank: s.candidates.slice(0, 15), rows: s.rows.filter((x) => x.ent).slice(0, 15).map((x) => ({ word: x.word, sim: +x.sim.toFixed(2), recent: !!x.ent.recent, srcs: 'P', type: 'term' })) })); return { id: r.id, text: r.text, w75: pack(0.75), w60: pack(0.6) }; });
writeFileSync(ROOT + 'e5-traps-windows.json', JSON.stringify(out));
console.log('trap/neutral sentences', out.length, 'windows@0.6', out.reduce((a, x) => a + x.w60.length, 0));
