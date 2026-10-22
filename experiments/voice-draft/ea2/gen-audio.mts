// E-A2 音频。  npx tsx experiments/voice-draft/ea2/gen-audio.mts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cases, LOCAL } from './common.mts';
const TC = '/data/home/yale/work/tc-verify';
const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`);
const { writeWav, RATE } = await import(`${TC}/tools/wav.mjs`);
const VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']; mkdirSync(`${LOCAL}/audio`, { recursive: true }); const failed: string[] = [];
for (const [i, c] of cases().entries()) { const voice = VOICES[i % 2]; const wav = `${LOCAL}/audio/${c.id}.wav`, webm = `${LOCAL}/audio/${c.id}.webm`; if (existsSync(webm)) continue;
  let clip: any; try { clip = await buildClip({ id: `EB${String(i).padStart(2, '0')}`, kind: 'reply', text: c.reply.replace(/\s*\n+\s*/g, '。') }, 'o75', { voice, seed: 20261007 }); } catch (e: any) { console.log('FAILED', c.id, String(e.message).slice(0, 120)); failed.push(c.id); continue; }
  writeWav(wav, clip.samples, RATE); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '48k', webm]); console.log(c.id, voice.slice(6, 12), clip.seconds.toFixed(1) + 's'); }
import('node:fs').then((fs) => fs.writeFileSync(`${LOCAL}/audio/failed.json`, JSON.stringify(failed))); console.log('GEN-DONE failed=' + failed.length);
