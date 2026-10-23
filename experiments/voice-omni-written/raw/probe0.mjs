import { readFileSync } from 'node:fs';
const URL_ = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const W = (c) => readFileSync(`experiments/voice-gemini-paired-quality/out/webm/${c}.webm`).toString('base64');
const WAV = (c) => readFileSync(`experiments/voice-provider-paired-quality/fixtures/${c}.wav`).toString('base64');
const INSTR = '逐字转写这段音频。只输出转写文本，不要解释。代码标识符、文件名保持原样。';
async function call(label, { data, format, stream = true, effort, instr = INSTR }) {
  const body = { model: 'qwen3.8-omni-flash', modalities: ['text'], stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...(effort ? { reasoning_effort: effort } : {}),
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data, format } }, ...(instr ? [{ type: 'text', text: instr }] : [])] }] };
  const t0 = Date.now(); let first = 0;
  const res = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }).catch((e) => e);
  if (!(res instanceof Response)) return console.log(`[${label}] THROW ${res.name}`);
  if (!res.ok || !stream) { const t = await res.text(); return console.log(`[${label}] ${res.status} ${Date.now() - t0}ms ${t.replace(/\s+/g, ' ').slice(0, 300)}`); }
  let text = '', reasoning = 0, usage = null; const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n').slice(0, -1)) { const m = line.match(/^data: (.*)$/); if (!m || m[1] === '[DONE]') continue; const j = JSON.parse(m[1]); const d = j.choices?.[0]?.delta; if (d?.content) { if (!first) first = Date.now() - t0; text += d.content; } if (d?.reasoning_content) reasoning += d.reasoning_content.length; if (j.usage) usage = j.usage; }
    buf = buf.split('\n').slice(-1)[0]; }
  console.log(`[${label}] 200 total=${Date.now() - t0}ms firstToken=${first}ms reasoningChars=${reasoning} usage=${JSON.stringify(usage)}\n    ${text}`);
}
console.log('d04 ref: 不要动 voice.service.ts，只改 voice.module.ts');
await call('webm/opus stream effort=default', { data: `data:audio/webm;base64,${W('d04-o65')}`, format: 'webm' });
await call('webm/opus stream effort=none', { data: `data:audio/webm;base64,${W('d04-o65')}`, format: 'webm', effort: 'none' });
await call('wav stream effort=none', { data: `data:audio/wav;base64,${WAV('d04-o65')}`, format: 'wav', effort: 'none' });
await call('webm NON-stream effort=none', { data: `data:audio/webm;base64,${W('d04-o65')}`, format: 'webm', effort: 'none', stream: false });
await call('webm no-instruction effort=none', { data: `data:audio/webm;base64,${W('d04-o65')}`, format: 'webm', effort: 'none', instr: null });
