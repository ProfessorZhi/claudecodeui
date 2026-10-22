// Synthesises every clip to 16 kHz mono WAV (the format the app uploads) under the out-of-repo corpus dir.
import { mkdirSync, existsSync } from 'node:fs';
import { allClips } from './clips.mjs';
const TC = '/data/home/yale/work/tc-verify/tools/';
const { speak } = await import(TC + 'tts.mjs');
const { writeWav } = await import(TC + 'wav.mjs');
const OUT = '/data/home/yale/work/tc-verify/corpus/voice-context-asr/wav/';
mkdirSync(OUT, { recursive: true });
let n = 0;
for (const c of allClips()) {
  const p = OUT + c.id + '.wav';
  if (existsSync(p)) continue;
  const samples = await speak(c.spoken, { voice: c.voice });
  writeWav(p, samples); n++;
}
console.log('built', n);
