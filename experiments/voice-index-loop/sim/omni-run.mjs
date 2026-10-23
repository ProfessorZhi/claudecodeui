// S4: the v3 clips through the shipped dashscope-omni request (frozen prompt, no context). Records transcript, instruction,
// client-side latency and usage.   set -a; . ./.env.test; set +a; npx tsx experiments/voice-index-loop/sim/omni-run.mjs
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import '../../../shared/asr/asrRegistry.ts';
import { buildChatRequestBody, readAnswerContent, extractJsonObject, readUsage, DEFAULT_MODEL } from '../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const RES = ROOT + 'omni-v3.jsonl';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const stream = JSON.parse(readFileSync(ROOT + 'stream.json', 'utf8')).filter((s) => s.selected);
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200).map((r) => r.id) : []);
const todo = stream.filter((s) => !done.has(s.id) && existsSync(ROOT + 'wav/' + s.id + '.wav')); let i = 0;
console.log('todo', todo.length);
async function one(s) {
  const b64 = readFileSync(ROOT + 'wav/' + s.id + '.wav').toString('base64');
  const body = buildChatRequestBody({ audio: { mimeType: 'audio/wav' } }, b64, DEFAULT_MODEL);
  let row = { id: s.id, status: 0 };
  for (let a = 0; a < 3; a++) {
    const t0 = Date.now();
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const text = await res.text(); const ms = Date.now() - t0;
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); row = { id: s.id, status: res.status, ms }; continue; }
      const content = readAnswerContent(text); const obj = content ? extractJsonObject(content) : null;
      row = { id: s.id, status: res.status, ms, transcript: obj?.transcript ?? null, instruction: obj?.instruction ?? null, raw: obj ? undefined : content?.slice(0, 200), usage: readUsage(text) }; break;
    } catch (e) { row = { id: s.id, status: 0, err: e.name, ms: Date.now() - t0 }; await new Promise((r) => setTimeout(r, 1500)); }
  }
  appendFileSync(RES, JSON.stringify(row) + '\n');
}
await Promise.all(Array.from({ length: Number(process.env.CONC ?? 6) }, async () => { while (i < todo.length) { await one(todo[i++]); if (i % 50 === 0) console.log(i); } }));
console.log('finished');
