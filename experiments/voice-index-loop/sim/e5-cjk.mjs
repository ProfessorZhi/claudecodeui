// X5 on the harmful errors whose heard form has no Latin letter: is the gold in the top-15 of the pinyin-phoneme candidates?
import { readFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
import { buildLookup } from './match.mjs';
import { cjkCandidates, pinyinPhonemes } from './cjk.mjs';
const items = JSON.parse(readFileSync(ROOT + 'e4-items.json', 'utf8'));
const verdict = new Map(readFileSync(ROOT + 'e4-judge.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict).map((r) => [r.k, r.verdict]));
const H = items.filter((i) => verdict.get(i.k) === 'wrong' && i.heard && !/[A-Za-z]/.test(i.heard) && /[一-鿿]/.test(i.heard));
const by = new Map(); for (const i of H) (by.get(i.id) ?? by.set(i.id, []).get(i.id)).push(i);
let hit = 0, top1 = 0, n = 0; const rows = [];
replay({ name: 'x', sources: new Set(['P', 'C', 'U']), variants: ['templates'], onEnts: ({ m, ents }) => {
  for (const it of by.get(m.id) ?? []) { buildLookup(ents); const han = it.heard.replace(/[^一-鿿]/g, ''); const c = cjkCandidates(han, ents); n++; const k = c.findIndex((x) => x.term === it.tok); if (k >= 0) hit++; if (k === 0) top1++; rows.push(`${it.tok.padEnd(14)} ${it.heard.padEnd(8)} ph=${pinyinPhonemes(han).join(' ').padEnd(24)} rank=${k < 0 ? '-' : k + 1} top=${c.slice(0, 3).map((x) => x.term).join(',')}`); }
} });
console.log(`harmful errors heard only as Chinese characters: ${n}; gold in pinyin top-15: ${hit}; top-1: ${top1}`); console.log(rows.join('\n'));
