// EXPLORATORY X5: Chinese renderings of English words ("翻译" for fan-in, "梦" for OOM). A CJK run is turned into pinyin and
// approximated as English phonemes, then compared with the entities' pronunciations by the same weighted phoneme distance.
import { createRequire } from 'node:module';
import { sound } from '../../voice-context-asr/pilot/phon.mjs';
const req = createRequire('/tmp/vk/npm/node_modules/');
const { pinyin } = await import(req.resolve('pinyin-pro'));
const INIT = { b: 'B', p: 'P', m: 'M', f: 'F', d: 'D', t: 'T', n: 'N', l: 'L', g: 'G', k: 'K', h: 'HH', j: 'JH', q: 'CH', x: 'SH', zh: 'JH', ch: 'CH', sh: 'SH', r: 'R', z: 'Z', c: 'T S', s: 'S', y: 'Y', w: 'W' };
const FIN = { a: 'AA', o: 'AO', e: 'AH', i: 'IY', u: 'UW', v: 'UW', ai: 'AY', ei: 'EY', ao: 'AW', ou: 'OW', an: 'AE N', en: 'AH N', ang: 'AA NG', eng: 'AH NG', ong: 'AO NG', in: 'IH N', ing: 'IH NG', ia: 'Y AA', ie: 'Y EH', iu: 'Y UW', ian: 'Y AE N', iang: 'Y AA NG', iong: 'Y AO NG', ua: 'W AA', uo: 'W AO', ui: 'W EY', uai: 'W AY', uan: 'W AE N', un: 'W AH N', uang: 'W AA NG', ue: 'Y UW EH', van: 'Y UW AE N', vn: 'Y UW N', er: 'ER', ve: 'Y UW EH' };
export function pinyinPhonemes(han) {
  const syl = pinyin(han, { toneType: 'none', type: 'array', v: true });
  const out = [];
  for (const s of syl) {
    const m = /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(.*)$/.exec(s); const ini = m[1] ?? '', fin = m[2] ?? '';
    if (ini) out.push(...INIT[ini].split(' '));
    const f = FIN[fin] ?? FIN[fin.replace(/^[jqxy]u/, 'v')] ?? null;
    if (f) out.push(...f.split(' '));
  }
  return out;
}
/** best entities for a CJK run: by phoneme similarity of the pinyin approximation to the entity's pronunciation */
export function cjkCandidates(run, ents, minSim = 0.6, K = 15) {
  const ph = pinyinPhonemes(run); if (!ph.length) return [];
  const sc = [];
  for (const e of ents.values()) { if (!e.p?.pron) continue; const a = ph, b = e.p.pron; const d = (() => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 0; j <= b.length; j++) m[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 0.7)); return m[a.length][b.length]; })(); const sim = 1 - d / Math.max(a.length, b.length); if (sim >= minSim) sc.push({ term: e.term, sim }); }
  return sc.sort((x, y) => y.sim - x.sim).slice(0, K);
}
