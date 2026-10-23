// Offline extras on the cached stage-2 rows: (a) vocab-guarded LLM replacement, (b) hybrid = D1 proposes, LLM probability decides,
// (c) separability of the LLM's probability for "quay" on a `key` span: real K clips vs trap clips.
import { readFileSync } from 'node:fs';
import { clips, vocabFor, ROOT, normKey, has } from './common2.mjs';
import { parse, toSpans } from './llm2.mjs';
import { analyse, indexVocab, applyReplacements } from './phon.mjs';
import { score } from './eval2.mjs';
const rows = readFileSync(ROOT + 'llm2.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((r) => r.status === 200 && r.cond === 'V1');
const sel = (llm, variant, asrM) => rows.filter((r) => r.llm.includes(llm) && r.variant === variant && r.asrModel.includes(asrM));
const guardSpans = (spans, vocab) => spans.map((s) => ({ ...s, candidates: s.candidates.filter(([w], i) => w === s.text || vocab.some((v) => v.term === w)) })).filter((s) => s.candidates.length);
for (const asrM of ['1.7b', '0.6b']) for (const [llm, variant] of [['ministral', 'hint'], ['ministral', 'plain'], ['qwen-2.5', 'hint'], ['qwen-2.5', 'plain']]) for (const tau of [0.5, 0.7]) {
  const rs = sel(llm, variant, asrM);
  const mk = (mode) => rs.map((r) => {
    const c = clips.get(r.id); const vocab = vocabFor('V1', c.targets);
    let spans = toSpans(r.text, parse(r.content) ?? []).spans;
    if (mode === 'guard') spans = guardSpans(spans, vocab);
    if (mode === 'hybrid') {
      const d1 = analyse(r.text, indexVocab(vocab)).filter((s) => s.candidates[0][0] !== s.text);
      spans = d1.map((s) => { const cand = s.candidates[0][0]; const l = spans.find((x) => x.start <= s.start && x.end >= s.end || (x.text === s.text)); const p = l ? (l.candidates.find(([w]) => w === cand)?.[1] ?? 0) : 0; return { ...s, candidates: [[cand, p], [s.text, 1 - p]].sort((a, b) => b[1] - a[1]) }; });
    }
    return { id: r.id, pre: r.text, post: applyReplacements(r.text, spans, tau).text, spans };
  });
  for (const mode of ['raw', 'guard', 'hybrid']) score(mk(mode), `${asrM} ${llm} ${variant} ${mode} t${tau}`);
}
// (c) probability separability
const P = { quayK: [], trap: [] };
for (const r of sel('ministral', 'hint', '1.7b').concat(sel('qwen-2.5', 'hint', '1.7b'))) {
  const c = clips.get(r.id); if (!(c.kind === 'trap' || (c.kind === 'target' && c.term === 'quay' && c.pron === 'K'))) continue;
  const sp = toSpans(r.text, parse(r.content) ?? []).spans.find((s) => /^key$/i.test(s.text.trim()) || /\bkey\b/i.test(s.text));
  const pq = sp ? (sp.candidates.find(([w]) => w === 'quay')?.[1] ?? 0) : 0;
  (c.kind === 'trap' ? P.trap : P.quayK).push([r.llm.split('/')[1], pq]);
}
for (const m of ['ministral-3b-2512', 'qwen-2.5-7b-instruct']) { const a = P.quayK.filter((x) => x[0] === m).map((x) => x[1]), b = P.trap.filter((x) => x[0] === m).map((x) => x[1]); console.log(m, 'p(quay) on key span — true-quay clips', a.map((x) => x.toFixed(1)).join(' '), ' | trap clips', b.map((x) => x.toFixed(1)).join(' ')); }

// (d) composite: D1 applies only shape/case repairs it is certain of (the span equals a vocab term up to case/space/hyphen);
//     every sound-alike proposal is a flag, and the guarded LLM decides whether it becomes a replacement.
console.log('\n-- composite (D1 shape repair + vocab-guarded ministral-3b hint)');
for (const asrM of ['1.7b', '0.6b']) for (const tau of [0.5, 0.7]) {
  const rs = sel('ministral', 'hint', asrM);
  const out = rs.map((r) => {
    const c = clips.get(r.id); const vocab = vocabFor('V1', c.targets);
    const d1 = analyse(r.text, indexVocab(vocab));
    const shape = d1.filter((s) => s.candidates[0][0] !== s.text && normKey(s.candidates[0][0]) === normKey(s.text));
    const afterShape = applyReplacements(r.text, shape, 0).text;
    const llmSpans = guardSpans(toSpans(afterShape, parse(r.content) ?? []).spans, vocab);
    return { id: r.id, pre: r.text, post: applyReplacements(afterShape, llmSpans, tau).text, spans: [...d1, ...llmSpans.filter((s) => !d1.some((x) => x.text === s.text))] };
  });
  score(out, `${asrM} composite t${tau}`);
}
