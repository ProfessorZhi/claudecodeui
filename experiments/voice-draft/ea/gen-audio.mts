// E-A 音频：回复文字 → TTS → webm。可续跑。  npx tsx experiments/voice-draft/ea/gen-audio.mts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cases, LOCAL } from './common.mts';
const TC = '/data/home/yale/work/tc-verify';
const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`);
const { writeWav, RATE } = await import(`${TC}/tools/wav.mjs`);
const VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural'];
mkdirSync(`${LOCAL}/audio`, { recursive: true });
const manifest: any[] = [];
for (const [i, c] of cases().entries()) {
  const voice = VOICES[i % 2]; const wav = `${LOCAL}/audio/${c.id}.wav`; const webm = `${LOCAL}/audio/${c.id}.webm`;
  const text = c.reply.replace(/\s*\n+\s*/g, '。');
  if (!existsSync(webm)) {
    const clip = await buildClip({ id: `EA${String(i).padStart(2, '0')}`, kind: 'reply', text }, 'o75', { voice, seed: 20261004 });
    writeWav(wav, clip.samples, RATE); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '48k', webm]); manifest.push({ id: c.id, voice, seconds: +clip.seconds.toFixed(2) });
    console.log(c.id, voice.slice(6, 12), clip.seconds.toFixed(1) + 's');
  }
}
writeFileSync(`${LOCAL}/audio/manifest.json`, JSON.stringify(manifest));
console.log('GEN-DONE');
