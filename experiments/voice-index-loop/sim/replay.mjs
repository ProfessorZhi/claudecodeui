// The replay engine: one pass over the user's whole history in time order. Everything a message may use was available
// before it (project snapshot at its time, the session's earlier turns, earlier sent text, earlier corrections).
import { readFileSync } from 'node:fs';
import { EntityIndex } from './index.mjs';
import { buildLookup, analyseEnts } from './match.mjs';
import { applyTemplates, knownPrefixes } from './templates.mjs';
import { idsWithPos, alignRegion, widenToWords, has, normKey, isId, heardKey, findHeard } from './lib.mjs';
import { repairIdentifiers } from '../../../src/shared/identifierRepair.ts';
export const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const stream = JSON.parse(readFileSync(ROOT + (process.env.STREAM_FILE ?? 'stream.json'), 'utf8'));
const snap = JSON.parse(readFileSync(ROOT + 'snap.json', 'utf8'));
const asrRows = new Map(readFileSync(ROOT + (process.env.ASR_FILE ?? 'asr-v3.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.asr != null).map((r) => [r.id, r.asr]));
export const T0 = Date.parse(stream[0].ts);
const days = (ts) => (Date.parse(ts) - T0) / 86400000;
const leftWord = (text, pos) => { const m = text.slice(0, pos).match(/([A-Za-z]+)\W*$/); return m ? m[1].toLowerCase() : ''; };

/** cfg: { name, sources:Set, baseline?:bool, learn?:{promoteAfter}|null, disable?:[] } */
export function replay(cfg, { limit = Infinity } = {}) {
  const SRC = cfg.sources ?? new Set();
  const V = new Set(cfg.variants ?? []);
  const idx = new EntityIndex({ promoteAfter: cfg.learn?.promoteAfter ?? 1, disable: cfg.disable, cPrior: V.has('cPrior'), aliasForms: V.has('aliasForms') });
  const recs = []; const seenGold = new Set(); const learnedPairs = new Set(); let maxScored = 0; const violations = [];
  let nSel = 0;
  for (const m of stream) {
    const now = days(m.ts);
    if (m.selected && asrRows.has(m.id) && nSel < limit) {
      nSel++;
      const asr0 = asrRows.get(m.id);
      let asr = asr0;
      const names = new Map(Object.entries(snap[m.proj][m.commit] ?? {}));
      idx.syncProject(m.proj, names, now);
      const conv = new Map(Object.entries(m.conv));
      const gold = m.text;
      if (V.has('templates') && !cfg.baseline) asr = applyTemplates(asr0, knownPrefixes(idx.entities(m.proj, conv, now, new Set(['P', 'C', 'U']))));
      // gold id tokens and where they went
      const toks = idsWithPos(gold).map((t) => {
        const hit = has(asr0, t.tok); let reg = null;
        if (!has(asr, t.tok)) { const r = alignRegion(gold, asr, t.start, t.end); if (r) reg = widenToWords(asr, r); }
        return { ...t, hitAsr: hit, reg };
      });
      // ── the system's output ──
      let post = asr, flagged = [], changes = [], spansAll = [];
      if (cfg.baseline) {
        const files = [...names].filter(([, t]) => t === 'file').map(([n]) => n);
        post = repairIdentifiers(asr, files);
        if (post !== asr) changes.push({ by: 'B', start: 0, end: asr.length, from: asr, to: post, whole: true });
      } else {
        const ents = idx.entities(m.proj, conv, now, SRC);
        const { spans, maxScored: ms } = analyseEnts(asr, buildLookup(ents), { maxWin: V.has('longWindow') ? 9 : 4 });
        if (cfg.onEnts) cfg.onEnts({ m, asr, ents, now, conv, idx }); maxScored = Math.max(maxScored, ms); spansAll = spans;
        // L1 learned aliases first
        const l1 = [];
        if (cfg.learn) {
          const keyFn = V.has('legacyKeys') ? normKey : heardKey;
          for (const [key, list] of idx.aliases.get(m.proj) ?? []) {
            if (!list.some((x) => x.state === 'active')) continue;
            const occs = V.has('legacyKeys') ? [...asr.matchAll(/[A-Za-z']+/g)].filter((x) => normKey(x[0]) === key).map((x) => ({ start: x.index, end: x.index + x[0].length })) : findHeard(asr, key);
            for (const o of occs) { if (l1.some((x) => o.start < x.end && x.start < o.end)) continue; const a = idx.l1(m.proj, key, leftWord(asr, o.start), now); if (a) l1.push({ start: o.start, end: o.end, to: a.canonical, by: 'L1', alias: a, heard: key }); }
          }
        }
        for (const l of l1) changes.push({ ...l, from: asr.slice(l.start, l.end) });
        for (const sp of spans) {
          if (l1.some((x) => sp.start < x.end && x.start < sp.end)) continue;
          if (sp.topWord !== sp.text && sp.silent && !idx.isBlocked(m.proj, normKey(sp.text), sp.topWord)) changes.push({ by: 'D1-shape', start: sp.start, end: sp.end, from: sp.text, to: sp.topWord, heard: normKey(sp.text) });
          else if (sp.topWord !== sp.text && sp.topP >= 0.5 && !sp.silent) flagged.push(sp);
        }
        for (const c of [...changes].sort((a, b) => b.start - a.start)) post = post.slice(0, c.start) + c.to + post.slice(c.end);
      }
      // ── score per gold token ──
      for (const t of toks) {
        const wrongPost = !has(post, t.tok);
        const r = { id: m.id, proj: m.proj, tok: t.tok, type: undefined, hitAsr: t.hitAsr, hitPost: !wrongPost, wrongAsr: !t.hitAsr, cls: null, flagged: false, rank: null, scoredHit: false };
        const lower = t.tok.toLowerCase();
        r.inP = [...(idx.P.get(m.proj) ?? [])].some(([n, e]) => n.toLowerCase() === lower && e.present) ; // exact (case-insens) presence in the current snapshot
        r.inC = [...conv].some(([k, d]) => k.toLowerCase() === lower && d <= 8);
        r.inU = idx.U.has(lower);
        r.seenBefore = seenGold.has(lower) || r.inP || r.inC || r.inU;
        if (t.hitAsr === false) {
          r.cls = t.reg && normKey(t.reg.text) === normKey(t.tok) ? 'S' : 'M';
          if (t.reg) {
            const sp = flagged.find((s) => s.start < t.reg.end && t.reg.start < s.end) ?? spansAll.find((s) => s.start < t.reg.end && t.reg.start < s.end && s.topWord !== s.text);
            if (sp) { r.flagged = flagged.includes(sp) || changes.some((c) => c.start < t.reg.end && t.reg.start < c.end); const k = sp.candidates.findIndex(([w]) => w === t.tok); r.rank = k < 0 ? null : k + 1; }
            r.reg = t.reg.text;
          }
        }
        recs.push(r);
        r._t = t;
      }
      // ── noise / harm ──
      const errRegs = toks.filter((t) => !t.hitAsr && t.reg).map((t) => t.reg);
      const harm = changes.filter((c) => !c.whole && !errRegs.some((r) => c.start < r.end && r.start < c.end));
      const flagsOff = flagged.filter((s) => !errRegs.some((r) => s.start < r.end && r.start < s.end));
      recs.push({ id: m.id, msg: true, chars: asr.length, flags: flagged.length, flagsOff: flagsOff.length, changes: changes.length, harm: harm.length, nTok: toks.length });
      // ── the ideal user: correct what is still wrong, revert what the system broke ──
      if (cfg.learn) {
        for (const c of harm) {
          if (c.by === 'L1') idx.revert(m.proj, c.heard, c.to, leftWord(asr, c.start), now);
          else if (c.by === 'D1-shape') idx.blockSilent(m.proj, c.heard, c.to);
        }
        for (const r of recs.filter((x) => x.id === m.id && x._t)) {
          if (!r.hitPost && r._t.reg) {
            const heard = V.has('legacyKeys') ? normKey(r._t.reg.text) : heardKey(r._t.reg.text); if (!heard) continue;
            const key = `${m.proj}|${heard}|${r.tok}`; r.repeat = learnedPairs.has(key);
            idx.confirm(m.proj, heard, r.tok, leftWord(asr, r._t.reg.start), now, r._t.reg.text); learnedPairs.add(key);
          }
        }
      }
      for (const r of recs.filter((x) => x.id === m.id && x._t)) { seenGold.add(r.tok.toLowerCase()); delete r._t; }
      const bad = idx.checkInvariants(m.proj, conv, now, SRC); if (bad.length) violations.push({ id: m.id, bad });
      idx.sweep(now);
    }
    if (!V.has('noImport') || m.selected) idx.observeSent(m.ids, now);   // every message the user sent becomes history; `noImport` = only the voice stream's own messages
  }
  return { recs, maxScored, violations, idx };
}
