// Round 6 candidate pool: every entity offered at the message's time WITH its type, its source set (P / C / U) and whether it is a
// tombstone, plus the learned aliases (confirmed heard forms) when the replay learns.
//   ASR_FILE=asr-sv2.jsonl [LEARN=1] [STREAM_FILE=...] npx tsx ents-dump2.mjs <out.json>
import { writeFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
const out = {}, ali = {};
const cfg = { name: 'ents2', sources: new Set(['P', 'C', 'U']), variants: ['templates'], onEnts: ({ m, ents, idx }) => {
  out[m.id] = [...ents.values()].map((e) => ({ t: e.term, r: e.recent ? 1 : 0, p: e.prior ? 1 : 0, c: e.count, ty: e.type, s: [...e.sources].join(''), tb: e.tomb ? 1 : 0 }));
  const list = []; for (const l of (idx.aliases.get(m.proj) ?? new Map()).values()) for (const a of l) if (a.confirms >= 1 && a.state !== 'archived') for (const raw of a.raws ?? []) list.push([a.canonical, raw]);
  ali[m.id] = list;
} };
if (process.env.LEARN) cfg.learn = { promoteAfter: 1 };
replay(cfg);
writeFileSync(ROOT + process.argv[2], JSON.stringify(out)); writeFileSync(ROOT + process.argv[2].replace('ents', 'aliases'), JSON.stringify(ali));
console.log(process.argv[2], Object.keys(out).length, 'messages; median entities', Object.values(out).map((v) => v.length).sort((a, b) => a - b)[Math.floor(Object.keys(out).length / 2)], '| messages with learned aliases', Object.values(ali).filter((l) => l.length).length);
