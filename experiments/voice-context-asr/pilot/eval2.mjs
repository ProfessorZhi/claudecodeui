// Offline scorer for stage 2. `node eval2.mjs d` scores D0/D1; `node eval2.mjs llm` scores cached LLM spans.
import { readFileSync, existsSync } from 'node:fs';
import { clips, asr, vocabFor, has, normKey, region, ROOT } from './common2.mjs';
import { indexVocab, analyse, applyReplacements } from './phon.mjs';
import '../../../src/shared/identifierRepair.ts';
import { repairIdentifiers } from '../../../src/shared/identifierRepair.ts';
const TAUS = [0.5, 0.7, 0.9];
const pct = (k, n) => (n ? `${String(Math.round((100 * k) / n)).padStart(3)}% (${k}/${n})` : '   -  ');
// self test: gold as ASR → nothing may change; targets blanked → fix rate 0
for (const id of ['t-quay-en1-K', 'mu1-K', 'ne3']) { const c = clips.get(id); const sp = analyse(c.gold, indexVocab(vocabFor('V1', c.targets))); const r = applyReplacements(c.gold, sp, 0.7); if (r.text !== c.gold) { console.log('SELFTEST FAIL', id, r); process.exit(1); } }

export function score(rowsOut, label) {
  // rowsOut: [{ id, model, cond, pre, post, spans }]
  const S = { fix: { S: [0, 0], M: [0, 0] }, fixK: [0, 0], fixW: [0, 0], harm: [0, 0], trap: [0, 0], neut: [0, 0], flagRec: { S: [0, 0], M: [0, 0] }, cand3: [0, 0], flags: { neutral: [0, 0], trap: [0, 0] } };
  for (const r of rowsOut) {
    const c = clips.get(r.id);
    if (c.kind === 'target' || c.kind === 'multi') for (const t of c.targets) {
      const wasHit = has(r.pre, t), nowHit = has(r.post, t);
      if (wasHit) { S.harm[1]++; if (!nowHit) S.harm[0]++; continue; }
      const reg = c.kind === 'target' ? region(r.pre, c.gold) : null;
      const shapeOnly = c.kind === 'target' && !reg;   // text differs from gold only by spaces / hyphens / case
      const cls = shapeOnly || (reg && normKey(reg.text) === normKey(t)) ? 'S' : 'M';
      S.fix[cls][1]++; if (nowHit) S.fix[cls][0]++;
      if (c.pron === 'K') { S.fixK[1]++; if (nowHit) S.fixK[0]++; } if (c.pron === 'W') { S.fixW[1]++; if (nowHit) S.fixW[0]++; }
      if (shapeOnly) { S.flagRec.S[1]++; S.cand3[1]++; const hit = r.spans.find((sp) => sp.candidates.slice(0, 3).some(([w]) => w === t)); if (hit) { S.flagRec.S[0]++; S.cand3[0]++; } }
      else if (reg) {
        S.flagRec[cls][1]++;
        const cover = r.spans.find((s) => { const a = [...r.pre.slice(0, s.start)].filter((x) => !/\s/.test(x)).length, b = a + [...r.pre.slice(s.start, s.end)].filter((x) => !/\s/.test(x)).length; const ra = [...r.pre.slice(0, reg.start)].filter((x) => !/\s/.test(x)).length, rb = ra + [...reg.text].filter((x) => !/\s/.test(x)).length; return a < rb && ra < b; });
        if (cover) { S.flagRec[cls][0]++; S.cand3[1]++; if (cover.candidates.slice(0, 3).some(([w]) => w === t)) S.cand3[0]++; } else S.cand3[1]++;
      }
    }
    if (c.kind === 'trap' && c.keep) { S.trap[1]++; if (r.post !== r.pre) S.trap[0]++; S.flags.trap[0] += r.spans.filter((s) => s.candidates[0][0] !== s.text).length; S.flags.trap[1]++; }
    if (c.kind === 'neutral' || c.id === 'tr8') { S.neut[1]++; if (r.post !== r.pre) S.neut[0]++; S.flags.neutral[0] += r.spans.filter((s) => s.candidates[0][0] !== s.text).length; S.flags.neutral[1]++; }
  }
  console.log(`  ${label.padEnd(26)} fix S ${pct(...S.fix.S)}  fix M ${pct(...S.fix.M)} | K ${pct(...S.fixK)} W ${pct(...S.fixW)} | harm ${pct(...S.harm)} | trap-replaced ${pct(...S.trap)} | neutral-changed ${pct(...S.neut)} | flagRec S ${pct(...S.flagRec.S)} M ${pct(...S.flagRec.M)} cand@3 ${pct(...S.cand3)} | flags/clip neutral ${(S.flags.neutral[0] / S.flags.neutral[1]).toFixed(2)} trap ${(S.flags.trap[0] / S.flags.trap[1]).toFixed(2)}`);
}
if (process.argv[2] === 'd') {
  for (const model of ['qwen/qwen3-asr-1.7b', 'qwen/qwen3-asr-0.6b']) for (const cond of ['V1', 'V5', 'V4']) {
    if (model.includes('0.6b') && cond !== 'V1') continue;
    console.log(`\n${model}  ${cond}`);
    const rows = asr.filter((r) => r.set === 'synth' && r.model === model);
    // D0
    for (const tau of [0.7]) {
      const out0 = rows.map((r) => { const c = clips.get(r.id); const v = vocabFor(cond, c.targets); const post = repairIdentifiers(r.text, v.map((x) => x.term)); return { id: r.id, pre: r.text, post, spans: [] }; });
      score(out0, 'D0 repairIdentifiers');
    }
    for (const tau of TAUS) {
      const out1 = rows.map((r) => { const c = clips.get(r.id); const sp = analyse(r.text, indexVocab(vocabFor(cond, c.targets))); return { id: r.id, pre: r.text, post: applyReplacements(r.text, sp, tau).text, spans: sp }; });
      score(out1, `D1 phonetic tau=${tau}`);
    }
  }
}

if (process.argv[2] === 'llm') {
  const { RES, parse, toSpans } = await import('./llm2.mjs');
  const rows = readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const groups = new Map();
  for (const r of rows) { const k = [r.asrModel, r.cond, r.llm, r.variant].join(' | '); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
  const pctl = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN; };
  for (const tau of [0.7, 0.5]) {
    console.log(`\n===== tau=${tau}`);
    let last = '';
    for (const [k, rs] of [...groups].sort()) {
      const [asrM, cond, llm, variant] = k.split(' | ');
      const head = `${asrM.split('/')[1]} ${cond}`; if (head !== last) { console.log(`\n-- ${head}`); last = head; }
      const ok = rs.filter((r) => r.status === 200);
      let parsed = 0, invalid = 0, nSpans = 0;
      const out = ok.map((r) => { const p = parse(r.content); if (p) parsed++; const { spans, invalid: inv } = toSpans(r.text, p ?? []); invalid += inv; nSpans += spans.length; return { id: r.id, pre: r.text, post: applyReplacements(r.text, spans, tau).text, spans }; });
      score(out, `${llm.split('/')[1]} ${variant}`);
      if (tau === 0.7) console.log(`      parse ${pct(parsed, ok.length)}  http-fail ${rs.length - ok.length}  invalid-spans ${invalid}/${nSpans}  p50/p90 ms ${pctl(ok.map((r) => r.ms), .5)}/${pctl(ok.map((r) => r.ms), .9)}`);
    }
  }
}
