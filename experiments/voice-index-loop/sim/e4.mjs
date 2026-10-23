// E4: split the v3 errors into tolerable / harmful. Rule first (form or spoken-form template), then a judge model on ALL errors
// (so the rule's "tolerable" claim is itself checked), then a blind audit sample for a second opinion.
//   set -a; . ./.env.test; set +a; npx tsx experiments/voice-index-loop/sim/e4.mjs build | judge | report
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
const stream = JSON.parse(readFileSync(ROOT + 'stream.json', 'utf8'));
const byId = new Map(stream.map((m) => [m.id, m]));
const asr = new Map(readFileSync(ROOT + (process.env.ASR_FILE ?? 'asr-v3.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.asr != null).map((r) => [r.id, r.asr]));
const TAG = process.env.TAG ? '-' + process.env.TAG : '';
const OUT = ROOT + `e4-items${TAG}.json`, RES = ROOT + `e4-judge${TAG}.jsonl`;
const mode = process.argv[2];
export const MODEL = 'qwen/qwen3.8-27b';
function ctxTokens(m) { return Object.entries(m.conv).filter(([t]) => /[a-z][A-Z]|[_\-]|\d|^[A-Z]{2,}$/.test(t)).sort((a, b) => a[1] - b[1]).slice(0, 60).map(([t]) => t); }
export function judgePrompt(it) {
  return `A developer dictated an instruction to a coding agent (Claude Code). The agent has the repository and the recent conversation.

Intended text: ${it.gold}
What speech recognition produced: ${it.asr}
Identifiers mentioned recently in the conversation (nearest first): ${it.ctx.join(', ') || '(none)'}

Focus on the intended identifier "${it.tok}". After reading the recognised text, could the agent still act on that same object?
- same: the recognised text still names it; differences are only spacing, case, hyphens, or spoken forms such as "下划线" for "_" or "零零二" for "002".
- recoverable: spelled differently, but the agent can resolve it to the intended object without ambiguity from the recent context or from how it sounds.
- wrong: the agent would point at another thing, or could not tell what was meant.
Answer with JSON only: {"verdict":"same|recoverable|wrong","reason":"<= 12 words"}`;
}
if (mode === 'build') {
  const r = replay({ name: 'e4', sources: new Set(['P', 'C', 'U']), variants: ['templates'] });
  const items = r.recs.filter((x) => x.tok && x.wrongAsr).map((x, k) => { const m = byId.get(x.id); return { k, id: x.id, tok: x.tok, gold: m.text, asr: asr.get(x.id), ctx: ctxTokens(m), ruleTolerable: x.cls === 'S' || x.hitPost, cls: x.cls, heard: x.reg ?? null }; });
  writeFileSync(OUT, JSON.stringify(items));
  console.log('errors', items.length, 'rule-tolerable', items.filter((i) => i.ruleTolerable).length);
}
if (mode === 'judge') {
  const items = JSON.parse(readFileSync(OUT, 'utf8'));
  const done = new Set(existsSync(RES) ? readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict).map((r) => r.k) : []);
  const todo = items.filter((i) => !done.has(i.k)); let n = 0;
  const one = async (it) => {
    for (let a = 0; a < 4; a++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 200, reasoning: { enabled: false }, messages: [{ role: 'user', content: judgePrompt(it) }] }), signal: AbortSignal.timeout(90000) });
        const j = await res.json().catch(() => null);
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); continue; }
        const c = j?.choices?.[0]?.message?.content ?? ''; const mm = c.match(/\{[\s\S]*\}/); let v = null; try { v = JSON.parse(mm[0]); } catch {}
        appendFileSync(RES, JSON.stringify({ k: it.k, verdict: v?.verdict ?? null, reason: v?.reason ?? null, raw: v ? undefined : c.slice(0, 200), cost: j?.usage?.cost }) + '\n'); return;
      } catch { await new Promise((r) => setTimeout(r, 1500)); }
    }
  };
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < todo.length) { await one(todo[i++]); if (++n % 100 === 0) console.log(n); } }));
  console.log('judged', todo.length);
}
if (mode === 'report') {
  const items = JSON.parse(readFileSync(OUT, 'utf8'));
  const j = new Map(readFileSync(RES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
  const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}% (${k}/${n})` : '-');
  const rule = items.filter((i) => i.ruleTolerable), rest = items.filter((i) => !i.ruleTolerable);
  const dist = (l) => ['same', 'recoverable', 'wrong'].map((v) => `${v} ${pct(l.filter((i) => j.get(i.k) === v).length, l.length)}`).join(' | ');
  console.log(`errors ${items.length}; judged ${items.filter((i) => j.has(i.k)).length}`);
  console.log('rule-tolerable (form / spoken-form):', rule.length, '->', dist(rule));
  console.log('the rest (misheard etc.):          ', rest.length, '->', dist(rest));
  const harmful = items.filter((i) => j.get(i.k) === 'wrong');
  console.log('HARMFUL (judge = wrong), all errors:', pct(harmful.length, items.length), '| inside rule-tolerable:', pct(rule.filter((i) => j.get(i.k) === 'wrong').length, rule.length));
}
