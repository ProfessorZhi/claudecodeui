// S0 (front-end fidelity, speed) and the ASR files the replay needs for S1 / S4:
//   asr-sv.jsonl (sherpa text), asr-svown.jsonl (own CTC greedy text), asr-omni-t.jsonl / asr-omni-i.jsonl (Omni transcript / instruction)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const rows = readFileSync(ROOT + 'sv/sv.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.tokens);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const group = (id) => (id.startsWith('v3:c') ? 'chunks' : id.startsWith('v3:') ? 'v3' : id.startsWith('pilot:') ? 'pilot' : 'real');
const by = {}; for (const r of rows) (by[group(r.id)] ??= []).push(r);
console.log('S0  own CTC greedy text vs sherpa-onnx text (normalised: no space / punctuation / case)');
for (const [g, l] of Object.entries(by)) console.log(`  ${g.padEnd(7)} identical ${l.filter((r) => r.same).length}/${l.length} (${Math.round(100 * l.filter((r) => r.same).length / l.length)}%)`);
const all = rows; console.log(`  all     identical ${all.filter((r) => r.same).length}/${all.length} (${(100 * all.filter((r) => r.same).length / all.length).toFixed(1)}%)`);
const rtf = all.map((r) => r.sherpa_dt / r.dur), dur = all.map((r) => r.dur);
console.log(`speed (sherpa-onnx, 4 threads, host load avg ~70 of 128 cores, so inflated): RTF p50 ${q(rtf, .5).toFixed(3)} p90 ${q(rtf, .9).toFixed(3)} max ${Math.max(...rtf).toFixed(3)}; audio length p50 ${q(dur, .5).toFixed(1)}s p90 ${q(dur, .9).toFixed(1)}s; decode time p50 ${q(all.map((r) => r.sherpa_dt), .5).toFixed(2)}s p90 ${q(all.map((r) => r.sherpa_dt), .9).toFixed(2)}s`);
const idOf = (cid) => (cid.startsWith('v3:c') ? cid.slice(4) : cid.startsWith('v3:') ? Number(cid.slice(3)) : null);
const w = (name, f) => writeFileSync(ROOT + name, f.map((o) => JSON.stringify(o)).join('\n') + '\n');
w('asr-sv.jsonl', rows.filter((r) => idOf(r.id) !== null && typeof idOf(r.id) === 'number').map((r) => ({ id: idOf(r.id), asr: r.sherpa_text })));
w('asr-svown.jsonl', rows.filter((r) => typeof idOf(r.id) === 'number').map((r) => ({ id: idOf(r.id), asr: r.own_text })));
w('asr-sv-chunks.jsonl', rows.filter((r) => typeof idOf(r.id) === 'string').map((r) => ({ id: idOf(r.id), asr: r.sherpa_text })));
if (existsSync(ROOT + 'omni-v3.jsonl')) {
  const om = readFileSync(ROOT + 'omni-v3.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200 && r.transcript != null);
  w('asr-omni-t.jsonl', om.map((r) => ({ id: r.id, asr: r.transcript }))); w('asr-omni-i.jsonl', om.filter((r) => r.instruction != null).map((r) => ({ id: r.id, asr: r.instruction })));
  console.log('omni rows', om.length);
}
