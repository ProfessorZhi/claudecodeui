// Stage 1: plain transcription (no context) through OpenRouter's Qwen3-ASR 1.7B / 0.6B.
//   set -a; . ./.env.test; set +a; node experiments/voice-context-asr/pilot/asr-or.mjs
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { allClips } from './clips.mjs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-context-asr/';
const RES = ROOT + 'asr-text.jsonl';
const MODELS = ['qwen/qwen3-asr-1.7b', 'qwen/qwen3-asr-0.6b'];
const items = allClips().map((c) => ({ id: c.id, path: ROOT + 'wav/' + c.id + '.wav', fmt: 'wav', set: 'synth' }));
const d = process.env.HOME + '/.cloudcli/voice-capture/';
for (const f of readdirSync(d).filter((x) => x.endsWith('.bin')).sort()) {
  const riff = readFileSync(d + f).subarray(0, 4).toString() === 'RIFF';
  items.push({ id: 'real-' + f.replace('.bin', ''), path: d + f, fmt: riff ? 'wav' : 'webm', set: 'real' });
}
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return r.id + '|' + r.model; }) : []);
const jobs = items.flatMap((it) => MODELS.map((m) => ({ it, m }))).filter(({ it, m }) => !done.has(it.id + '|' + m));
console.log('jobs', jobs.length);
let i = 0;
async function one({ it, m }) {
  const body = { model: m, input_audio: { data: readFileSync(it.path).toString('base64'), format: it.fmt } };
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      const j = await res.json().catch(() => null);
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue; }
      appendFileSync(RES, JSON.stringify({ id: it.id, set: it.set, model: m, status: res.status, text: j?.text ?? null, err: j?.error?.message ?? null, cost: j?.usage?.cost }) + '\n');
      return;
    } catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
  }
  appendFileSync(RES, JSON.stringify({ id: it.id, set: it.set, model: m, status: 0, text: null, err: 'gave up' }) + '\n');
}
await Promise.all(Array.from({ length: 4 }, async () => { while (i < jobs.length) await one(jobs[i++]); }));
console.log('finished');
