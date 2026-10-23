// Round 6 readings on the patched engine: R1 (confidence, CTC), R2 (provenance, scale rule), R4 (acoustic aliases).
//   ASR_FILE=asr-sv2.jsonl npx tsx experiments/voice-index-loop/sim/sv-eval2.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ROOT, replay } from './replay.mjs';
import { buildLookup, analyseEnts } from './match.mjs';
import { idsWithPos, alignRegion, widenToWords, has, normKey, heardKey } from './lib.mjs';
const rd = (f) => (existsSync(ROOT + f) ? readFileSync(ROOT + f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const stream = new Map(JSON.parse(readFileSync(ROOT + 'stream.json', 'utf8')).filter((s) => s.selected).map((s) => [s.id, s]));
const sv = new Map(rd('sv2/sv.jsonl').filter((r) => r.tokens && /^v3:\d+$/.test(r.id)).map((r) => [Number(r.id.slice(3)), r]));
const ctcOf = (f) => new Map(rd('sv2/' + f).map((r) => [Number(r.id.slice(3)), r]));
const C = { full: ctcOf('ctc-full.jsonl'), k200: ctcOf('ctc-k200.jsonl'), k500: ctcOf('ctc-k500.jsonl'), alias: ctcOf('ctc-alias.jsonl') };
const items = JSON.parse(readFileSync(ROOT + 'e4-items-sv2.json', 'utf8'));
const verdict = new Map(rd('e4-judge-sv2.jsonl').filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const harmfulSet = new Set(items.filter((i) => verdict.get(i.k) === 'wrong').map((i) => `${i.id}|${i.tok}`));
const ruleTolSet = new Set(items.filter((i) => i.ruleTolerable).map((i) => `${i.id}|${i.tok}`));
const aliases = existsSync(ROOT + 'aliases2L-v3.json') ? JSON.parse(readFileSync(ROOT + 'aliases2L-v3.json', 'utf8')) : {};
const d1 = new Map();
replay({ name: 'd1', sources: new Set(['P', 'C', 'U']), onEnts: ({ m, asr, ents }) => { const lk = buildLookup(ents); d1.set(m.id, analyseEnts(asr, lk, { minSim: 0.6, K: 15 }).spans); } });
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '   -  ');
function tokSpans(r) { let raw = '', pos = []; for (const k of r.tokens) { pos.push(raw.length); raw += k.tok.replace('▁', ' '); } const lead = raw.length - raw.trimStart().length; return r.tokens.map((k, i) => ({ start: Math.max(0, pos[i] - lead), end: Math.max(0, pos[i] + k.tok.replace('▁', ' ').length - lead), p: k.p })); }
const recs = [];
for (const [id, r] of sv) {
  const m = stream.get(id); if (!m) continue; const own = r.own_text; const ts = tokSpans(r);
  for (const t of idsWithPos(m.text)) {
    const hit = has(own, t.tok); let reg = null;
    if (!hit) { const a = alignRegion(m.text, own, t.start, t.end); if (a) reg = widenToWords(own, a); } else { const k = own.indexOf(t.tok); if (k >= 0) reg = { start: k, end: k + t.tok.length, text: t.tok }; }
    if (!reg || reg.end <= reg.start) continue; const cov = ts.filter((x) => overlap(x, reg)); if (!cov.length) continue;
    recs.push({ id, tok: t.tok, hit, reg, minp: Math.min(...cov.map((x) => x.p)), harmful: !hit && harmfulSet.has(`${id}|${t.tok}`), ruleTol: !hit && ruleTolSet.has(`${id}|${t.tok}`) });
  }
}
const err = recs.filter((x) => !x.hit), ok = recs.filter((x) => x.hit), harm = recs.filter((x) => x.harmful);
console.log(`R1 tokens with a usable region ${recs.length} (errors ${err.length}, correct ${ok.length}); harmful (judge on this engine's text) ${harm.length}`);
function auroc(pos, neg) { const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]); let rs = 0, i = 0; while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (all[k][1] === 1) rs += avg; i = j + 1; } const nP = pos.length, nN = neg.length; return (rs - nP * (nP + 1) / 2) / (nP * nN); }
const sc = (x) => 1 - x.minp;
console.log(`  AUROC (low confidence => error): all errors ${auroc(err.map(sc), ok.map(sc)).toFixed(3)} | harmful ${auroc(harm.map(sc), ok.map(sc)).toFixed(3)} | rule-tolerable ${auroc(recs.filter((x) => x.ruleTol).map(sc), ok.map(sc)).toFixed(3)}`);
const chars = [...sv].reduce((a, [, r]) => a + r.own_text.length, 0);
for (const th of [0.5, 0.6, 0.7, 0.8]) for (const latin of [false, true]) {
  const fl = []; for (const [id, r] of sv) { const ts = tokSpans(r); let i = 0; while (i < ts.length) { if (ts[i].p < th) { let j = i; while (j + 1 < ts.length && ts[j + 1].p < th) j++; const seg = r.own_text.slice(ts[i].start, ts[j].end); if (!latin || /[A-Za-z0-9]/.test(seg)) fl.push({ id, start: ts[i].start, end: ts[j].end }); i = j + 1; } else i++; } }
  const by = new Map(); for (const f of fl) (by.get(f.id) ?? by.set(f.id, []).get(f.id)).push(f); const cov = (x) => (by.get(x.id) ?? []).some((f) => overlap(f, x.reg));
  console.log(`  theta ${th}${latin ? ' (Latin/digit runs only)' : '                      '}: flags/100ch ${(100 * fl.length / chars).toFixed(2)} | recall errors ${pct(err.filter(cov).length, err.length)} harmful ${pct(harm.filter(cov).length, harm.length)} | correct tokens flagged ${pct(ok.filter(cov).length, ok.length)}`);
}
const winOf = (C_, id) => C_.get(id)?.windows ?? [];
const covered = (C_, x) => winOf(C_, x.id).filter((w) => overlap({ start: w.cs, end: w.ce }, x.reg));
const inTop = (C_, x, key, k) => covered(C_, x).some((w) => w[key].slice(0, k).some(([t]) => t === x.tok));
const d1top = (x, k) => (d1.get(x.id) ?? []).some((w) => overlap(w, x.reg) && w.rows.slice(0, k).some((r) => r.word === x.tok));
console.log('\nR1 CTC candidate scoring, full pool (windows: p<0.85, +-1 token)');
for (const [label, set] of [['harmful', harm], ['all errors', err]]) console.log(`  ${label} (n=${set.length}): in a window ${pct(set.filter((x) => covered(C.full, x).length).length, set.length)} | CTC-LLR top1 ${pct(set.filter((x) => inTop(C.full, x, 'llr', 1)).length, set.length)} top3 ${pct(set.filter((x) => inTop(C.full, x, 'llr', 3)).length, set.length)} top15 ${pct(set.filter((x) => inTop(C.full, x, 'llr', 15)).length, set.length)} | +prior top15 ${pct(set.filter((x) => inTop(C.full, x, 'pri', 15)).length, set.length)} | phonetic D1 top15 ${pct(set.filter((x) => d1top(x, 15)).length, set.length)} | union ${pct(set.filter((x) => inTop(C.full, x, 'pri', 15) || d1top(x, 15)).length, set.length)}`);
console.log('\nR2 provenance: where the gold candidate came from (harmful errors found in CTC+prior top-15, full pool)');
const foundH = harm.filter((x) => inTop(C.full, x, 'pri', 15));
const tally = {}, tyT = {}; for (const x of foundH) { const meta = C.full.get(x.id)?.meta?.[x.tok]; if (!meta) continue; const s = meta[1]; tally[s] = (tally[s] ?? 0) + 1; tyT[meta[0]] = (tyT[meta[0]] ?? 0) + 1; }
console.log('  by source set:', JSON.stringify(tally), '| by type:', JSON.stringify(tyT));
let tomb = 0, listed = 0; for (const [, r] of C.full) for (const w of r.windows) for (const [t] of w.pri.slice(0, 15)) { listed++; if (r.meta?.[t]?.[2]) tomb++; }
console.log(`  tombstone (deleted-name) candidates in the top-15 lists: ${tomb}/${listed}`);
console.log('\nR2 scale rule (harmful errors, CTC+prior top-15 recall) and pool size');
for (const k of ['full', 'k500', 'k200']) { const pools = [...C[k].values()].map((r) => r.pool).sort((a, b) => a - b); console.log(`  ${k.padEnd(5)}: ${pct(harm.filter((x) => inTop(C[k], x, 'pri', 15)).length, harm.length)} | all errors ${pct(err.filter((x) => inTop(C[k], x, 'pri', 15)).length, err.length)} | pool median ${pools[Math.floor(pools.length / 2)]} max ${pools[pools.length - 1]}`); }
console.log('\nR4 acoustic aliases: errors whose canonical already had a confirmed alias (new heard writing), recall with / without alias readings');
const repeatNew = harm.filter((x) => (aliases[x.id] ?? []).some(([canon, heard]) => canon === x.tok && heardKey(heard) !== heardKey(x.reg.text)));
const repeatAll = err.filter((x) => (aliases[x.id] ?? []).some(([canon, heard]) => canon === x.tok && heardKey(heard) !== heardKey(x.reg.text)));
for (const [label, set] of [['harmful, new writing', repeatNew], ['all errors, new writing', repeatAll], ['all harmful', harm]]) console.log(`  ${label} (n=${set.length}): no alias top1/3/15 ${['1', '3', '15'].map((k) => pct(set.filter((x) => inTop(C.full, x, 'pri', +k)).length, set.length)).join(' ')} | with alias ${['1', '3', '15'].map((k) => pct(set.filter((x) => inTop(C.alias, x, 'pri', +k)).length, set.length)).join(' ')}`);
// displacement: correct tokens whose window now lists an alias-added candidate first
let disp = 0, dispN = 0; for (const x of ok) { const w = covered(C.alias, x)[0]; if (!w) continue; dispN++; const top = w.pri[0]?.[0]; const meta = C.alias.get(x.id)?.meta?.[top]; if (top && top !== x.tok && meta && meta[1] === 'A') disp++; }
console.log(`  windows over correct tokens whose top candidate is an alias-only entity: ${disp}/${dispN}`);
