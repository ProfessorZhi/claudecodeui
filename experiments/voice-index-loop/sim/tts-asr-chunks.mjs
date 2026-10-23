// Speaks each selected message (Edge neural TTS) and transcribes it with Qwen3-ASR 1.7B via OpenRouter, no context.
//   set -a; . ./.env.test; set +a; node experiments/voice-index-loop/sim/tts-asr.mjs
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const TC = '/data/home/yale/work/tc-verify/tools/';
const { speak } = await import(TC + 'tts.mjs');
const { writeWav } = await import(TC + 'wav.mjs');
mkdirSync(ROOT + 'wav', { recursive: true });
const RES = ROOT + 'asr-chunks.jsonl';
const [SH, SN] = (process.env.SHARD ?? '0/1').split('/').map(Number);   // operational only: run several processes
const stream = JSON.parse(readFileSync(ROOT + 'stream-chunks.json', 'utf8')).filter((s) => s.cid.split('.').join('') % SN === SH);
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.asr != null).map((r) => r.id) : []);
const voiceFor = (s) => (/[一-鿿]/.test(s.text) ? (s.parent % 2 ? 'zh-CN-YunxiNeural' : 'zh-CN-XiaoxiaoNeural') : 'en-US-AriaNeural');
const pending = [];
async function asr(s, path) {
  const body = { model: 'qwen/qwen3-asr-1.7b', input_audio: { data: readFileSync(path).toString('base64'), format: 'wav' } };
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      const j = await res.json().catch(() => null);
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue; }
      appendFileSync(RES, JSON.stringify({ id: s.cid, status: res.status, asr: j?.text ?? null, cost: j?.usage?.cost, err: j?.error?.message ?? null }) + '\n'); return;
    } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  appendFileSync(RES, JSON.stringify({ id: s.cid, status: 0, asr: null, err: 'gave up' }) + '\n');
}
let n = 0;
for (const s of stream) {
  if (done.has(s.cid)) continue;
  const path = ROOT + 'wav/c' + s.cid + '.wav';
  if (!existsSync(path)) { try { writeWav(path, await speak(s.text, { voice: voiceFor(s) })); } catch (e) { appendFileSync(RES, JSON.stringify({ id: s.cid, status: 0, asr: null, err: 'tts: ' + e.message }) + '\n'); continue; } }
  pending.push(asr(s, path));
  if (pending.length >= 6) await Promise.race(pending.map((p, i) => p.then(() => i))).then((i) => pending.splice(i, 1));
  if (++n % 50 === 0) console.log(n, '/', stream.length - done.size);
}
await Promise.all(pending);
console.log('finished');
