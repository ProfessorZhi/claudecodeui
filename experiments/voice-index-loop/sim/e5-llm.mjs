// E5 step 2: closed-set selection. The model sees the recognised text, one span, and a numbered list (0 = keep as is);
// it may only answer a number, so nothing outside the vocabulary can be produced.
//   set -a; . ./.env.test; set +a; node experiments/voice-index-loop/sim/e5-llm.mjs [windowsFile] [outFile]
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/';
const WIN = process.argv[2] ?? 'e5-windows.json', RES = ROOT + (process.argv[3] ?? 'e5-llm.jsonl');
export const ARMS = [['H2', 'mistralai/ministral-3b-2512', 'plain'], ['H2', 'qwen/qwen-2.5-7b-instruct', 'plain'], ['H3', 'mistralai/ministral-3b-2512', 'label'], ['H3', 'qwen/qwen-2.5-7b-instruct', 'label'], ['H4', 'qwen/qwen3.8-27b', 'label']];
export function prompt(text, w, fmt) {
  const lab = (r) => (fmt === 'label' ? `  (${[r.recent ? 'mentioned in the recent conversation' : null, /U/.test(r.srcs) ? 'you have written it before' : null, /P/.test(r.srcs) ? `a project ${r.type}` : null].filter(Boolean).join('; ') || 'known term'})` : '');
  const opts = [`0 = keep "${w.text}" as it is`, ...w.rows.map((r, i) => `${i + 1} = ${r.word}${lab(r)}`)];
  return `Speech-recognition output from a developer dictating to a coding agent (Chinese and English mixed):
${text}

The span "${w.text}" may be a project term the recogniser misheard. Which option did the speaker most likely say?
${opts.join('\n')}
Answer with the option number only.`;
}
if (process.argv[1]?.endsWith('e5-llm.mjs')) {
  const msgs = JSON.parse(readFileSync(ROOT + WIN, 'utf8'));
  const jobs = []; for (const m of msgs) for (const [arm, model, fmt] of ARMS) for (const [i, w] of m.w60.entries()) if (w.rows.length) jobs.push({ id: m.id, i, arm, model, fmt, text: m.text, w });
  const key = (j) => `${j.id}|${j.i}|${j.arm}|${j.model}`;
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.pick != null).map((r) => `${r.id}|${r.i}|${r.arm}|${r.model}`) : []);
  const todo = jobs.filter((j) => !done.has(key(j))); console.log('jobs', jobs.length, 'todo', todo.length); let n = 0, i = 0;
  const one = async (j) => {
    for (let a = 0; a < 4; a++) {
      try {
        const body = { model: j.model, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: prompt(j.text, j.w, j.fmt) }] }; if (j.model.includes('qwen3.8')) body.reasoning = { enabled: false };
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const x = await res.json().catch(() => null);
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue; }
        const c = x?.choices?.[0]?.message?.content ?? ''; const mm = c.match(/\d+/);
        appendFileSync(RES, JSON.stringify({ id: j.id, i: j.i, arm: j.arm, model: j.model, pick: mm ? Math.min(+mm[0], j.w.rows.length) : 0, parsed: !!mm, raw: mm ? undefined : c.slice(0, 40), cost: x?.usage?.cost }) + '\n'); return;
      } catch { await new Promise((r) => setTimeout(r, 1500)); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < todo.length) { await one(todo[i++]); if (++n % 500 === 0) console.log(n); } }));
  console.log('finished');
}
