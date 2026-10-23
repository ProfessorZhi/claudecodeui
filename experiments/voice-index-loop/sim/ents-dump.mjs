// S3 input: the entity terms offered at each message's time (PCU, the replay's own index), independent of any recogniser.
//   [STREAM_FILE=stream-e6.json ASR_FILE=asr-chunks.jsonl] npx tsx ents-dump.mjs <out.json>
import { writeFileSync } from 'node:fs';
import { replay, ROOT } from './replay.mjs';
const out = {};
replay({ name: 'ents', sources: new Set(['P', 'C', 'U']), variants: ['templates'], onEnts: ({ m, ents }) => { out[m.id] = [...ents.values()].map((e) => ({ t: e.term, r: e.recent ? 1 : 0, p: e.prior ? 1 : 0, c: e.count })); } });
writeFileSync(ROOT + process.argv[2], JSON.stringify(out));
console.log(process.argv[2], Object.keys(out).length, 'messages; median entities', Object.values(out).map((v) => v.length).sort((a, b) => a - b)[Math.floor(Object.keys(out).length / 2)]);
