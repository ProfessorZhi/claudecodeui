// S2 音频生成：每个发言单元一段（理想切段），另拼一条带 2–6 s 思考停顿的整段。可续跑。
//   npx tsx experiments/voice-draft/s2/gen-audio.mts
// 音频不入库（体积），落在 tc-verify/corpus/voice-draft/；仓库里只存 manifest.json（时长、sha256）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SCRIPTS, VOICES } from './scripts.mts';

const TC = '/data/home/yale/work/tc-verify';
const { buildClip } = await import(`${TC}/tools/dictation-corpus.mjs`);
const { writeWav, readWav, silence, concat, durationSec, RATE } = await import(`${TC}/tools/wav.mjs`);
export const OUT = `${TC}/corpus/voice-draft`;
const MAN = new URL('./manifest.json', import.meta.url);

const rngFor = (seed: number) => { let s = seed >>> 0; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32); };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (process.argv[1]?.endsWith('gen-audio.mts')) {
  const manifest: any[] = existsSync(MAN) ? JSON.parse(readFileSync(MAN, 'utf8')) : [];
  const have = (voice: string, sid: string, n: number) => manifest.find((m) => m.voice === voice && m.script === sid && m.unit === n);
  for (const voice of VOICES) for (const s of SCRIPTS) {
    const dir = `${OUT}/${voice}/${s.id}`; mkdirSync(dir, { recursive: true });
    const pieces: Float32Array[] = []; const rnd = rngFor(20261003 + s.id.charCodeAt(1) * 31 + voice.length);
    let cursor = 0; const spans: any[] = [];
    for (const u of s.units) {
      const base = `${dir}/u${String(u.n).padStart(2, '0')}`;
      let seconds: number;
      if (existsSync(`${base}.wav`) && have(voice, s.id, u.n)) {
        seconds = durationSec(readWav(`${base}.wav`).samples);
      } else {
        const clip = await buildClip({ id: `${s.id}u${String(u.n).padStart(2, '0')}`, kind: 'long', text: u.text }, 'o75', { voice, seed: 20261003 });
        writeWav(`${base}.wav`, clip.samples, RATE);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.wav`, '-c:a', 'libopus', '-b:a', '48k', `${base}.webm`]);
        seconds = clip.seconds;
        const rec = { voice, script: s.id, unit: u.n, role: u.role, text: u.text, seconds: +seconds.toFixed(3), wavSha256: sha(`${base}.wav`), webmSha256: sha(`${base}.webm`), webmBytes: readFileSync(`${base}.webm`).length };
        const i = manifest.findIndex((m) => m.voice === voice && m.script === s.id && m.unit === u.n);
        if (i >= 0) manifest[i] = rec; else manifest.push(rec);
        writeFileSync(MAN, JSON.stringify(manifest, null, 1));
        console.log(`${voice} ${s.id} u${u.n} ${seconds.toFixed(1)}s`);
      }
      const samples = readWav(`${base}.wav`).samples;
      const gap = 2 + rnd() * 4; // 2–6 s 的思考停顿
      spans.push({ unit: u.n, start: +cursor.toFixed(3), end: +(cursor + seconds).toFixed(3), gapAfter: +gap.toFixed(3) });
      pieces.push(samples, silence(gap)); cursor += seconds + gap;
    }
    writeWav(`${dir}/full.wav`, concat(...pieces), RATE);
    writeFileSync(`${dir}/spans.json`, JSON.stringify(spans, null, 1));
    console.log(`${voice} ${s.id} full ${cursor.toFixed(0)}s`);
  }
  console.log('GEN-DONE');
}
