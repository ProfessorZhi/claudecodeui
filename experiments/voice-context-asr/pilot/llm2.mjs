// Stage 2, small-model arms. Calls OpenRouter chat completions; results cached in llm2.jsonl.
//   set -a; . ./.env.test; set +a; node llm2.mjs run
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { clips, asr, vocabFor, ROOT } from './common2.mjs';
import { indexVocab, analyse } from './phon.mjs';
export const RES = ROOT + 'llm2.jsonl';
export const LLMS = ['meta-llama/llama-3.2-1b-instruct', 'meta-llama/llama-3.2-3b-instruct', 'mistralai/ministral-3b-2512', 'qwen/qwen-2.5-7b-instruct'];
export function prompt(text, vocab, variant) {
  const proj = vocab.map((v) => v.term).join(', ');
  const rec = vocab.filter((v) => v.recent).map((v) => v.term).join(', ');
  let hints = '';
  if (variant === 'hint') {
    const sp = analyse(text, indexVocab(vocab)).filter((s) => s.candidates.some(([w]) => w !== s.text));
    const lines = sp.map((s) => `- "${s.text}" sounds like the project term "${s.candidates.find(([w]) => w !== s.text)[0]}"`);
    hints = lines.length ? `\nSound-alike hints (they may be coincidences):\n${lines.join('\n')}\n` : '\nSound-alike hints: none.\n';
  }
  return `A speech recogniser transcribed a developer dictating to a coding agent. The speaker mixes Chinese and English and often says project-specific names. The recogniser has no knowledge of those names, so it may have written a common word or several words instead.

Project vocabulary: ${proj}
Mentioned recently in the conversation: ${rec}
${hints}
Transcript: ${text}

List the spans of the transcript that may be a misrecognised project term, each with candidate replacements and probabilities. Include the original span itself as one candidate. If the original is plausibly what was said (an ordinary word used in its ordinary sense), give it the higher probability. Probabilities for one span sum to 1. If nothing looks misrecognised, return an empty list.
Answer with JSON only, in this shape: {"spans":[{"span":"<exact text from the transcript>","candidates":[["<word>",0.0],["<word>",0.0]]}]}`;
}
export function parse(content) {
  if (!content) return null;
  const a = content.indexOf('{'), b = content.lastIndexOf('}'); if (a < 0 || b < a) return null;
  try {
    const j = JSON.parse(content.slice(a, b + 1)); if (!Array.isArray(j.spans)) return null;
    return j.spans.map((s) => ({ span: String(s.span ?? ''), candidates: (s.candidates ?? []).map((c) => Array.isArray(c) ? [String(c[0]), Number(c[1])] : [String(c?.word ?? c), Number(c?.p ?? c?.probability ?? 0)]).filter(([w, p]) => w && Number.isFinite(p)).sort((x, y) => y[1] - x[1]) })).filter((s) => s.span && s.candidates.length);
  } catch { return null; }
}
export function toSpans(text, parsed) {
  const out = []; let invalid = 0;
  for (const s of parsed) { const i = text.indexOf(s.span); if (i < 0) { invalid++; continue; } out.push({ start: i, end: i + s.span.length, text: s.span, candidates: s.candidates }); }
  return { spans: out, invalid };
}
export function jobs() {
  const js = [];
  for (const r of asr.filter((x) => x.set === 'synth')) {
    const conds = r.model.includes('1.7b') ? ['V1', 'V5', 'V4'] : ['V1'];
    for (const cond of conds) for (const llm of LLMS) for (const variant of ['plain', 'hint']) js.push({ id: r.id, asrModel: r.model, cond, llm, variant, text: r.text });
  }
  return js;
}
export const key = (j) => [j.id, j.asrModel, j.cond, j.llm, j.variant].join('|');
if (process.argv[2] === 'run') {
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200).map(key) : []);
  const todo = jobs().filter((j) => !done.has(key(j))).slice(0, Number(process.env.LIMIT ?? 1e9));
  console.log('todo', todo.length); let i = 0;
  const one = async (j) => {
    const vocab = vocabFor(j.cond, clips.get(j.id).targets);
    const body = { model: j.llm, temperature: 0, max_tokens: 500, messages: [{ role: 'user', content: prompt(j.text, vocab, j.variant) }] };
    const t0 = Date.now(); let row = { ...j, status: 0 };
    for (let a = 0; a < 4; a++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
        const jj = await res.json().catch(() => null);
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); row = { ...row, status: res.status }; continue; }
        row = { ...j, status: res.status, ms: Date.now() - t0, content: jj?.choices?.[0]?.message?.content ?? null, err: jj?.error?.message ?? null, cost: jj?.usage?.cost }; break;
      } catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
    }
    appendFileSync(RES, JSON.stringify(row) + '\n');
  };
  await Promise.all(Array.from({ length: Number(process.env.CONC ?? 8) }, async () => { while (i < todo.length) await one(todo[i++]); }));
  console.log('finished');
}
