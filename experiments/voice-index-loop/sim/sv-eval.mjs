// S2 (confidence) and S3 (CTC candidate scoring) on the v3 clips, over SenseVoice's own CTC text.
//   ASR_FILE=asr-svown.jsonl TAG=svown npx tsx experiments/voice-index-loop/sim/sv-eval.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ROOT, replay } from './replay.mjs';
import { buildLookup, analyseEnts } from './match.mjs';
import { idsWithPos, alignRegion, widenToWords, has, normKey } from './lib.mjs';
const rd = (f) => readFileSync(ROOT + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const stream = new Map(JSON.parse(readFileSync(ROOT + 'stream.json', 'utf8')).filter((s) => s.selected).map((s) => [s.id, s]));
const sv = new Map(rd('sv/sv.jsonl').filter((r) => r.tokens && /^v3:\d+$/.test(r.id)).map((r) => [Number(r.id.slice(3)), r]));
const ctc = new Map(rd('sv/ctc-v3.jsonl').map((r) => [Number(r.id.slice(3)), r]));
const items = JSON.parse(readFileSync(ROOT + 'e4-items-svown.json', 'utf8'));
const verdict = new Map(rd('e4-judge-svown.jsonl').filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const harmful = new Set(items.filter((i) => verdict.get(i.k) === 'wrong').map((i) => `${i.id}|${i.tok}`));
const ruleTol = new Set(items.filter((i) => i.ruleTolerable).map((i) => `${i.id}|${i.tok}`));
// D1 spans on the same text (no templates, so coordinates are the raw own text)
const d1 = new Map();
replay({ name: 'd1', sources: new Set(['P', 'C', 'U']), onEnts: ({ m, asr, ents }) => { const lk = buildLookup(ents); d1.set(m.id, { w75: analyseEnts(asr, lk, { minSim: 0.75, K: 15 }).spans, w60: analyseEnts(asr, lk, { minSim: 0.6, K: 15 }).spans }); } });
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '   -  ');
// token char spans on the own text
function tokSpans(r) { let raw = '', pos = []; for (const k of r.tokens) { pos.push(raw.length); raw += k.tok.replace('▁', ' '); } const lead = raw.length - raw.trimStart().length; return r.tokens.map((k, i) => ({ start: Math.max(0, pos[i] - lead), end: Math.max(0, pos[i] + k.tok.replace('▁', ' ').length - lead), p: k.p })); }
const recs = [];
for (const [id, r] of sv) {
  const m = stream.get(id); if (!m) continue; const own = r.own_text; const ts = tokSpans(r);
  for (const t of idsWithPos(m.text)) {
    const hit = has(own, t.tok); let reg = null;
    if (!hit) { const a = alignRegion(m.text, own, t.start, t.end); if (a) reg = widenToWords(own, a); }
    else { const k = own.indexOf(t.tok); if (k >= 0) reg = { start: k, end: k + t.tok.length, text: t.tok }; }
    if (!reg || reg.end <= reg.start) continue;
    const cov = ts.filter((x) => overlap(x, reg)); if (!cov.length) continue;
    recs.push({ id, tok: t.tok, hit, reg, minp: Math.min(...cov.map((x) => x.p)), harmful: !hit && harmful.has(`${id}|${t.tok}`), ruleTol: !hit && ruleTol.has(`${id}|${t.tok}`) });
  }
}
const err = recs.filter((x) => !x.hit), ok = recs.filter((x) => x.hit), harm = recs.filter((x) => x.harmful);
console.log(`tokens with a usable region: ${recs.length} (errors ${err.length}, correct ${ok.length}); harmful (judge on own text) ${harm.length}`);
function auroc(pos, neg) { const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]); let rankSum = 0, i = 0; while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSum += avg; i = j + 1; } const nP = pos.length, nN = neg.length; return (rankSum - nP * (nP + 1) / 2) / (nP * nN); }
// positives score = 1 - confidence (higher = more suspicious)
const s = (x) => 1 - x.minp;
console.log(`S2 AUROC (low confidence => error): all errors ${auroc(err.map(s), ok.map(s)).toFixed(3)} | harmful ${auroc(harm.map(s), ok.map(s)).toFixed(3)} | rule-tolerable errors ${auroc(recs.filter((x) => x.ruleTol).map(s), ok.map(s)).toFixed(3)}`);
const chars = [...sv].reduce((a, [id, r]) => a + r.own_text.length, 0);
console.log('S2 flag budget: token runs with p < theta');
for (const th of [0.5, 0.6, 0.7, 0.8]) {
  let flags = 0, recAll = 0, recH = 0, offT = 0; const fl = [];
  for (const [id, r] of sv) { const ts = tokSpans(r); let i = 0; while (i < ts.length) { if (ts[i].p < th) { let j = i; while (j + 1 < ts.length && ts[j + 1].p < th) j++; fl.push({ id, start: ts[i].start, end: ts[j].end }); flags++; i = j + 1; } else i++; } }
  const byId = new Map(); for (const f of fl) (byId.get(f.id) ?? byId.set(f.id, []).get(f.id)).push(f);
  const covered = (x) => (byId.get(x.id) ?? []).some((f) => overlap(f, x.reg));
  recAll = err.filter(covered).length; recH = harm.filter(covered).length;
  console.log(`  theta ${th}: flags/100 chars ${(100 * flags / chars).toFixed(2)} | recall errors ${pct(recAll, err.length)} harmful ${pct(recH, harm.length)} | flags overlapping a correct identifier but no error ${pct(ok.filter(covered).length, ok.length)} of correct tokens`);
}
// combinations with D1 (0.75, p>=0.5): conf theta 0.6
console.log('S2 combination with D1 flags (theta 0.6): D1 flag alone / intersect (D1 flag overlapped by a low-confidence run) / union');
{
  const th = 0.6; let d1n = 0, ix = 0, un = 0, ixOnErr = 0, d1OnErr = 0, d1H = 0, ixH = 0;
  const lc = new Map(); for (const [id, r] of sv) { const ts = tokSpans(r); const runs = []; let i = 0; while (i < ts.length) { if (ts[i].p < th) { let j = i; while (j + 1 < ts.length && ts[j + 1].p < th) j++; runs.push({ start: ts[i].start, end: ts[j].end }); i = j + 1; } else i++; } lc.set(id, runs); }
  let d1Spans = 0, ixSpans = 0, d1Off = 0, ixOff = 0, errRegCount = 0;
  const found = (list, x) => list.some((w) => overlap(w, x.reg) && w.candidates.slice(0, 3).some(([c]) => c === x.tok));
  for (const x of err) { const D = (d1.get(x.id)?.w75 ?? []).filter((w) => w.topWord !== w.text && w.topP >= 0.5); const I = D.filter((w) => (lc.get(x.id) ?? []).some((r) => overlap(r, w))); d1OnErr += found(D, x); ixOnErr += found(I, x); if (x.harmful) { d1H += found(D, x); ixH += found(I, x); } }
  for (const [id] of sv) { const D = (d1.get(id)?.w75 ?? []).filter((w) => w.topWord !== w.text && w.topP >= 0.5); const I = D.filter((w) => (lc.get(id) ?? []).some((r) => overlap(r, w))); const regs = recs.filter((x) => x.id === id && !x.hit).map((x) => x.reg); d1Spans += D.length; ixSpans += I.length; d1Off += D.filter((w) => !regs.some((r) => overlap(r, w))).length; ixOff += I.filter((w) => !regs.some((r) => overlap(r, w))).length; }
  console.log(`  D1 alone:  flags ${d1Spans} (off-error ${pct(d1Off, d1Spans)}) | found errors ${pct(d1OnErr, err.length)}, harmful ${pct(d1H, harm.length)}`);
  console.log(`  intersect: flags ${ixSpans} (off-error ${pct(ixOff, ixSpans)}) | found errors ${pct(ixOnErr, err.length)}, harmful ${pct(ixH, harm.length)}`);
}
// ---- S3
console.log('\nS3 CTC candidate scoring over low-confidence windows (p < 0.85, +-1 token)');
const winOf = (id) => ctc.get(id)?.windows ?? [];
const covered = (x) => winOf(x.id).filter((w) => overlap({ start: w.cs, end: w.ce }, x.reg));
const inTop = (x, key, k) => covered(x).some((w) => w[key].slice(0, k).some(([t]) => t === x.tok));
const d1top = (x, k) => (d1.get(x.id)?.w60 ?? []).some((w) => overlap(w, x.reg) && w.rows.slice(0, k).some((r) => r.word === x.tok));
for (const [label, set] of [['harmful errors', harm], ['all errors', err], ['rule-tolerable errors', recs.filter((x) => x.ruleTol)]]) {
  console.log(`${label} (n=${set.length}): in a CTC window ${pct(set.filter((x) => covered(x).length).length, set.length)} | CTC-LLR top1 ${pct(set.filter((x) => inTop(x, 'llr', 1)).length, set.length)} top3 ${pct(set.filter((x) => inTop(x, 'llr', 3)).length, set.length)} top15 ${pct(set.filter((x) => inTop(x, 'llr', 15)).length, set.length)} | CTC+prior top1 ${pct(set.filter((x) => inTop(x, 'pri', 1)).length, set.length)} top3 ${pct(set.filter((x) => inTop(x, 'pri', 3)).length, set.length)} top15 ${pct(set.filter((x) => inTop(x, 'pri', 15)).length, set.length)}`);
  console.log(`   phonetic D1 (0.6, K=15) top15 ${pct(set.filter((x) => d1top(x, 15)).length, set.length)} | union CTC+prior top15 or D1 top15 ${pct(set.filter((x) => inTop(x, 'pri', 15) || d1top(x, 15)).length, set.length)}`);
}
// application at thresholds
const TAUS = process.env.EXPLORE ? [-2, -4, -6, -8, -10, -14] : [0, 2, 4];
for (const key of ['llr', 'pri']) for (const tau of TAUS) {
  let fixedH = 0, broken = 0, okN = ok.length, repl = 0, errFixed = 0; const post = new Map();
  for (const [id, r] of sv) { let t = r.own_text; const reps = []; for (const w of winOf(id)) { const top = w[key][0]; if (top && top[1] >= tau && normKey(top[0]) !== normKey(w.hyp)) reps.push({ start: w.cs, end: w.ce, to: top[0] }); } repl += reps.length; for (const x of [...reps].sort((a, b) => b.start - a.start)) t = t.slice(0, x.start) + x.to + t.slice(x.end); post.set(id, t); }
  fixedH = harm.filter((x) => has(post.get(x.id), x.tok)).length; errFixed = err.filter((x) => has(post.get(x.id), x.tok)).length; broken = ok.filter((x) => !has(post.get(x.id), x.tok)).length;
  console.log(`apply top-1 by ${key} when score >= ${tau}: replacements ${repl} | harmful fixed ${pct(fixedH, harm.length)} | all errors fixed ${pct(errFixed, err.length)} | correct tokens broken ${pct(broken, okN)}`);
}

if (process.env.EXPLORE) {
  console.log('\nEXPLORATORY (not pre-registered): flags only on runs that contain a Latin letter or digit');
  for (const th of [0.5, 0.6, 0.7, 0.8]) {
    const fl = []; for (const [id, r] of sv) { const ts = tokSpans(r); let i = 0; while (i < ts.length) { if (ts[i].p < th) { let j = i; while (j + 1 < ts.length && ts[j + 1].p < th) j++; const seg = r.own_text.slice(ts[i].start, ts[j].end); if (/[A-Za-z0-9]/.test(seg)) fl.push({ id, start: ts[i].start, end: ts[j].end }); i = j + 1; } else i++; } }
    const byId = new Map(); for (const f of fl) (byId.get(f.id) ?? byId.set(f.id, []).get(f.id)).push(f);
    const cov = (x) => (byId.get(x.id) ?? []).some((f) => overlap(f, x.reg));
    console.log(`  theta ${th}: flags/100 chars ${(100 * fl.length / chars).toFixed(2)} | recall errors ${pct(err.filter(cov).length, err.length)} harmful ${pct(harm.filter(cov).length, harm.length)} | correct tokens flagged ${pct(ok.filter(cov).length, ok.length)}`);
  }
}
