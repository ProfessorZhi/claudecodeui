// E-C 音频：每条链的每个单元 × 两个音色。  npx tsx experiments/voice-draft/ec/gen-audio.mts
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CHAINS } from './scripts.mts';
import { LOCAL, VOICES } from './common.mts';
const TC = '/data/home/yale/work/tc-verify';
const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`);
const { writeWav, RATE } = await import(`${TC}/tools/wav.mjs`);
const failed: string[] = [];
for (const voice of VOICES) for (const c of CHAINS) { const dir = `${LOCAL}/audio/${voice}/${c.id}`; mkdirSync(dir, { recursive: true });
  for (const un of c.units) { const base = `${dir}/u${String(un.n).padStart(2, '0')}`; if (existsSync(`${base}.webm`)) continue;
    try { const clip = await buildClip({ id: `${c.id}u${String(un.n).padStart(2, '0')}`, kind: 'ec', text: un.text }, 'o75', { voice, seed: 20261008 });
      writeWav(`${base}.wav`, clip.samples, RATE); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.wav`, '-c:a', 'libopus', '-b:a', '48k', `${base}.webm`]); console.log(voice.slice(6, 12), c.id, un.n, clip.seconds.toFixed(1) + 's');
    } catch (e: any) { console.log('FAILED', voice, c.id, un.n, String(e.message).slice(0, 100)); failed.push(`${voice}|${c.id}|${un.n}`); } } }
console.log('GEN-DONE failed=' + failed.length, failed.join(','));
