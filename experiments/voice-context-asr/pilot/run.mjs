// Runs the pilot through the SHIPPED dashscope-omni request builder; only the context text part is added,
// at the position the multimodal adapter's `hints.context` convention uses (before the task turn).
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-context-asr/pilot/run.mjs synth
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { allClips } from './clips.mjs';
import { context } from './cases.mjs';
import '../../../shared/asr/asrRegistry.ts';
import { buildChatRequestBody, readAnswerContent, extractJsonObject, DEFAULT_MODEL } from '../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';

const MODE = process.argv[2] ?? 'synth';
const REPS = Number(process.env.REPS ?? 2);
const CONC = Number(process.env.CONC ?? 6);
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-context-asr/';
const RES = ROOT + `results-${MODE}.jsonl`;
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';

let clips;
if (MODE === 'synth') {
  clips = allClips().map((c) => ({ ...c, path: ROOT + 'wav/' + c.id + '.wav', mime: 'audio/wav' }));
} else {
  const d = process.env.HOME + '/.cloudcli/voice-capture/';
  clips = readdirSync(d).filter((f) => f.endsWith('.bin')).sort().map((f) => ({ id: f.replace('.bin', ''), kind: 'real', targets: ['quay'], path: d + f,
    mime: readFileSync(d + f).subarray(0, 4).toString() === 'RIFF' ? 'audio/wav' : 'audio/webm' }));
}
const condsFor = (c) => (c.kind === 'target' ? ['C0', 'C1', 'C2', 'C4', 'C5'] : ['C0', 'C1', 'C2', 'C4']);
const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const c of clips) for (const cond of condsFor(c)) jobs.push({ c, cond, rep });
const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}|${r.cond}|${r.rep}`; }) : []);
const todo = jobs.filter((j) => !done.has(`${j.c.id}|${j.cond}|${j.rep}`)).slice(0, Number(process.env.LIMIT ?? 1e9));
console.log(`jobs ${jobs.length}, todo ${todo.length}`);

async function one({ c, cond, rep }) {
  const b64 = readFileSync(c.path).toString('base64');
  const body = buildChatRequestBody({ audio: { mimeType: c.mime } }, b64, DEFAULT_MODEL);
  const ctx = context(cond, c.targets);
  if (ctx) { const parts = body.messages[1].content; parts.splice(parts.length - 1, 0, { type: 'text', text: ctx }); }
  const t0 = Date.now();
  let row = { id: c.id, cond, rep, kind: c.kind, ctxChars: ctx.length };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); row = { ...row, status: res.status, err: 'http', attempts: attempt + 1 }; continue; }
      const content = readAnswerContent(text);
      const obj = content ? extractJsonObject(content) : null;
      row = { ...row, status: res.status, ms: Date.now() - t0, attempts: attempt + 1, raw: content, transcript: obj?.transcript ?? null, instruction: obj?.instruction ?? null };
      break;
    } catch (e) { row = { ...row, status: 0, ms: Date.now() - t0, err: `${e.name}:${e.cause?.code ?? e.message}`, attempts: attempt + 1 }; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  appendFileSync(RES, JSON.stringify(row) + '\n');
}
let i = 0, fail = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < todo.length) { const j = todo[i++]; await one(j); if (i % 50 === 0) console.log(i, '/', todo.length); }
}));
console.log('finished');
