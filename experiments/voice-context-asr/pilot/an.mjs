// node an.mjs  — reads the cached results, scores them. No network.
import { readFileSync } from 'node:fs';
import { allClips } from './clips.mjs';
import { POOL } from './cases.mjs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-context-asr/';
const rows = readFileSync(ROOT + 'results-synth.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200 && r.raw != null);
const clips = new Map(allClips().map((c) => [c.id, c]));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const has = (text, term) => !!text && new RegExp(`(?<![A-Za-z0-9_-])${esc(term)}(?![A-Za-z0-9_]|-[A-Za-z])`).test(text.replace(/`/g, ''));
const pct = (a, n) => (n ? (100 * a / n).toFixed(0).padStart(3) + '%' : '  - ') + ` (${a}/${n})`;
const wilson = (k, n) => { if (!n) return ''; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return `[${Math.max(0, (c - m) / d * 100).toFixed(0)}–${Math.min(100, (c + m) / d * 100).toFixed(0)}]`; };
// self tests: known answers, incl. a Chinese one and the stem trap
const T = [[has('创建一个 quay 任务。', 'quay'), true], [has('创建一个 `quay` 任务', 'quay'), true], [has('quay-fleet 状态', 'quay'), false], [has('创建一个 key 任务', 'quay'), false], [has('Check quay-fleet', 'quay-fleet'), true], [has('fan in', 'fan-in'), false]];
if (T.some(([a, b]) => a !== b)) { console.log('SELFTEST FAIL', T); process.exit(1); }

const conds = ['C0', 'C1', 'C2', 'C4', 'C5'];
const cell = (filter, cond, field) => { let k = 0, n = 0; for (const r of rows) { const c = clips.get(r.id); if (r.cond !== cond || !filter(c)) continue; for (const t of c.targets) { n++; if (has(r[field], t)) k++; } } return [k, n]; };
function table(title, filter) {
  console.log(`\n${title}`);
  for (const f of ['transcript', 'instruction']) {
    console.log(`  ${f}:`);
    for (const cond of conds) { const [k, n] = cell(filter, cond, f); if (n) console.log(`    ${cond}  ${pct(k, n)} ${wilson(k, n)}`); }
  }
}
console.log('rows scored', rows.length, ' cells with errors/empty dropped');
table('TARGET sentences, class A, pron K (/kiː/ — audio is the word "key")', (c) => c.kind === 'target' && c.cls === 'A' && c.pron === 'K');
table('TARGET sentences, class A, pron W (/kweɪ/ — audio is "kway")', (c) => c.kind === 'target' && c.cls === 'A' && c.pron === 'W');
table('TARGET sentences, class A, pron N (cantus, archguard)', (c) => c.kind === 'target' && c.cls === 'A' && c.pron === 'N');
table('TARGET sentences, class B (split / form)', (c) => c.kind === 'target' && c.cls === 'B');
table('TARGET sentences, class C+D (acronym, numbered)', (c) => c.kind === 'target' && (c.cls === 'C' || c.cls === 'D'));
table('MULTI, pron K', (c) => c.kind === 'multi' && c.pron === 'K');
table('MULTI, pron W', (c) => c.kind === 'multi' && c.pron === 'W');

console.log('\nTRAPS (gold keeps the word "key"; FIR = output has quay instead / in addition):');
for (const cond of ['C0', 'C1', 'C2', 'C4']) for (const f of ['transcript', 'instruction']) {
  let keep = 0, inj = 0, n = 0;
  for (const r of rows) { const c = clips.get(r.id); if (r.cond !== cond || c.kind !== 'trap' || !c.keep) continue; n++; if (has(r[f], 'key')) keep++; if (has(r[f], 'quay')) inj++; }
  console.log(`  ${cond} ${f.padEnd(11)} kept-key ${pct(keep, n)}   injected-quay ${pct(inj, n)}`);
}
console.log('\nNEUTRAL (+ trap tr8): any project term appearing from nothing');
for (const cond of ['C0', 'C1', 'C2', 'C4']) for (const f of ['transcript', 'instruction']) {
  let bad = 0, n = 0; for (const r of rows) { const c = clips.get(r.id); if (r.cond !== cond || !(c.kind === 'neutral' || c.id === 'tr8')) continue; n++; if (POOL.some((t) => has(r[f], t))) bad++; }
  console.log(`  ${cond} ${f.padEnd(11)} ${pct(bad, n)}`);
}
// what did K / W audio come out as, per condition (class A quay only)
console.log('\nwhat "quay" came out as (transcript field), by pron × cond — first rep only, term=quay, 4 templates:');
for (const pron of ['K', 'W']) for (const cond of conds) {
  const outs = rows.filter((r) => r.rep === 0 && r.cond === cond && r.id.startsWith('t-quay-') && !r.id.startsWith('t-quay-fleet') && r.id.endsWith('-' + pron)).map((r) => r.transcript);
  console.log(`  ${pron} ${cond}: ${outs.join('  |  ')}`);
}
const lat = rows.map((r) => r.ms).sort((a, b) => a - b); console.log('\nlatency p50/p90 ms', lat[Math.floor(lat.length * .5)], lat[Math.floor(lat.length * .9)]);
