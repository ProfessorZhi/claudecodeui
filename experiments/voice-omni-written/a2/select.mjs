// Deterministic context selection for A2 from the local pool. Writes fixtures/a2-contexts.json (the chosen texts, verbatim).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPool, stratumOf, leaks, TARGETS } from './strata.mjs';
const root = new URL('../../../', import.meta.url);
const refs = [...JSON.parse(readFileSync(new URL('experiments/voice-provider-paired-quality/fixtures/paired.json', root), 'utf8')).entries.map((e) => e.reference), ...JSON.parse(readFileSync(new URL('experiments/voice-omni-written/fixtures/ext-refs.json', root), 'utf8')).clips.map((c) => c.text)];
const pool = buildPool().filter((p) => !leaks(p.text, refs)).sort((a, b) => (a.session + a.turn).localeCompare(b.session + String(b.turn)));
const cells = {}; for (const p of pool) for (const c of Object.keys(TARGETS)) { const s = stratumOf(p.text, c).stratum; if (s !== 'neither') cells[`${c}|${s}`] = 0; }
const K = 8, chosen = [], sessions = new Set();
while (chosen.length < K - 1) {
  let best = null, bestScore = 0;
  for (const p of pool) { if (chosen.includes(p)) continue;
    let score = 0; for (const c of Object.keys(TARGETS)) { const s = stratumOf(p.text, c).stratum; if (s !== 'neither' && cells[`${c}|${s}`] < 2) score += 1; }
    if (!sessions.has(p.session)) score += 0.5;
    if (score > bestScore) { best = p; bestScore = score; } }
  if (!best || bestScore < 1) break;
  chosen.push(best); sessions.add(best.session);
  for (const c of Object.keys(TARGETS)) { const s = stratumOf(best.text, c).stratum; if (s !== 'neither') cells[`${c}|${s}`]++; }
}
const offTopic = pool.find((p) => !chosen.includes(p) && Object.keys(TARGETS).every((c) => stratumOf(p.text, c).stratum === 'neither') && p.text.length >= 6000);
chosen.push(offTopic);
const out = { generatedAt: new Date().toISOString(), rule: 'greedy cover of (clip, stratum) cells to >=2, max 7 + 1 off-topic; pool = assistant-turn text from human sessions of this project, 1500..8000 chars (tail), leak-checked', cells,
  contexts: chosen.map((p, i) => ({ key: `c${i + 1}`, session: p.session, turn: p.turn, chars: p.text.length, strata: Object.fromEntries(Object.keys(TARGETS).map((c) => { const r = stratumOf(p.text, c); return [c, r.stratum + (r.competitors.length ? ` [${r.competitors.slice(0, 4).join(', ')}]` : '')]; })), text: p.text })) };
if (process.argv.includes('--write')) writeFileSync(new URL('experiments/voice-omni-written/fixtures/a2-contexts.json', root), JSON.stringify(out, null, 1) + '\n');
for (const c of out.contexts) console.log(c.key, c.session, `turn${c.turn}`, c.chars, JSON.stringify(c.strata));
console.log('cells', JSON.stringify(cells));
