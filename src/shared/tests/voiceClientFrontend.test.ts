/**
 * The client-side ASR front end, against the probe's recorded readings.
 *
 * THE ORACLE. `experiments/voice-client-asr-probe/probe.mjs` was validated frame-for-frame against
 * the server-side Python reference before any reading was taken, and the readings were written into
 * `docs/experiments/2026-10-06-voice-client-asr-probe.md` §3. The probe deliberately kept no model
 * weights or audio in the tree (§12), so these tests pin the port against the readings themselves:
 * the token regression (`检/t=4 查/t=7 we/t=12 b/t=15 ▁server/t=18 进/t=25`) is encoded here as the
 * logits that produce it, and the fbank's three correctness-critical behaviours — per-frame mean
 * removal, pre-emphasis with the first sample using itself, no mel normalisation — are pinned as
 * properties that go red when one is removed.
 *
 * WHAT IS DELIBERATELY NOT HERE. An end-to-end assertion against a real model is impossible here —
 * there is no model in the tree and jsdom has no WASM SIMD — so nothing claims the model itself
 * works. What is pinned is the transform between the model's output and the seam's token shape,
 * which is the part this module owns.
 */

import { describe, expect, it } from 'vitest';

import {
  VOICE_CLIENT_PROBE_VERSION,
  decodeLogits,
  fbank,
  greedyDecode,
  lfrCmvn,
  logSoftmaxInPlace,
  makeMelBanks,
  parseOnnxMetadata,
  parseWav,
  tokensToText,
  type VoiceClientToken,
} from '@/shared/voiceClientFrontend';

/** The Kaldi silence floor, written out rather than imported so the value under test is the module's. */
const FLOOR = 1.1920928955078125e-7;

/** A frame's worth of a log-probability row, in the logits the decoder reads. */
const WINNER = Math.log(0.9);
/** The losing value every other vocabulary entry takes, far below the winner. */
const LOSER = -20;
/** The blank token's value on a frame that emits nothing — below the winner, above the losers. */
const BLANK = -0.5;

/** The vocabulary the regression reading was produced under; index 0 is the CTC blank. */
const REGRESSION_VOCAB = ['<blank>', '检', '查', 'we', 'b', '▁server', '进', '<|zh|>', 'x'];

/**
 * The clip-1 regression reading as logits: `检/t=4 查/t=7 we/t=12 b/t=15 ▁server/t=18 进/t=25`.
 *
 * `t=5` repeats `检` on purpose — the recorded reading lists `检` once, so the repeat must extend
 * the existing token rather than start a second one — and `t=9` is a `<|zh|>` special that the
 * decode must drop. Every other frame is blank. This is the exact matrix the recorded first six
 * tokens come out of, so a change to the argmax, the blank rule, the repeat merge or the special
 * filter moves a `t` here and reds.
 */
function regressionLogits(): Float32Array {
  const frames = 26;
  const vocab = REGRESSION_VOCAB.length;
  const lp = new Float32Array(frames * vocab).fill(LOSER);
  const put = (t: number, token: string, value: number) => {
    lp[t * vocab + REGRESSION_VOCAB.indexOf(token)] = value;
  };
  for (let t = 0; t < frames; t++) lp[t * vocab] = BLANK;
  put(4, '检', WINNER);
  put(5, '检', WINNER);
  put(7, '查', WINNER);
  put(9, '<|zh|>', WINNER);
  put(12, 'we', WINNER);
  put(15, 'b', WINNER);
  put(18, '▁server', WINNER);
  put(25, '进', WINNER);
  return lp;
}

/** Builds a little-endian 16-bit PCM WAV around `samples`. */
function makeWav(samples: number[], sampleRate = 16000, bits = 16, channels = 1): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) dv.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * (bits / 8), true);
  dv.setUint16(32, channels * (bits / 8), true);
  dv.setUint16(34, bits, true);
  ascii(36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return buf;
}

/** Encodes a protobuf length-delimited field's header plus payload length. */
function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  for (;;) {
    const byte = v & 0x7f;
    v >>>= 7;
    if (v === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

/** A `metadata_props` entry: field 1 = key, field 2 = value, both length-delimited. */
function metadataProp(key: string, value: string): number[] {
  const enc = (text: string) => Array.from(new TextEncoder().encode(text));
  const keyBytes = enc(key);
  const valueBytes = enc(value);
  return [
    0x0a, ...varint(keyBytes.length), ...keyBytes,
    0x12, ...varint(valueBytes.length), ...valueBytes,
  ];
}

describe('the client ASR front end', () => {
  it('reproduces the probe token regression, item for item', () => {
    const decoded = greedyDecode(regressionLogits(), 26, REGRESSION_VOCAB);

    expect(decoded.map((token) => [token.tok, token.t])).toEqual([
      ['检', 4],
      ['查', 7],
      ['we', 12],
      ['b', 15],
      ['▁server', 18],
      ['进', 25],
    ]);
    // The repeat at t=5 extended the t=4 token rather than adding one, and the `<|zh|>` at t=9 was
    // dropped — together these are why the list is exactly six long.
    expect(decoded).toHaveLength(6);
    for (const token of decoded) {
      expect(token.p).toBeGreaterThan(0);
      expect(token.p).toBeLessThanOrEqual(1);
    }
    // The merged token carries the maximum of its run's two softmax values.
    expect(decoded[0].p).toBeCloseTo(0.9, 6);
  });

  it('skips the blank, merges repeats and drops specials, on their own', () => {
    const vocab = ['<blank>', 'a', 'b', '<|en|>'];
    // a, a (merge), blank (skip), b, <|en|> (drop), b again after a blank (new token).
    const lp = new Float32Array([
      LOSER, WINNER, LOSER, LOSER,
      LOSER, WINNER, LOSER, LOSER,
      BLANK, LOSER, LOSER, LOSER,
      LOSER, LOSER, WINNER, LOSER,
      LOSER, LOSER, LOSER, WINNER,
      LOSER, LOSER, WINNER, LOSER,
    ]);
    const decoded = greedyDecode(lp, 6, vocab);

    expect(decoded.map((token) => [token.tok, token.t])).toEqual([
      ['a', 0],
      ['b', 3],
      ['b', 5],
    ]);
  });

  it('joins tokens with the word boundary as a space', () => {
    const tokens: VoiceClientToken[] = [
      { tok: 'we', p: 1, t: 0 },
      { tok: 'b', p: 1, t: 1 },
      { tok: '▁server', p: 1, t: 2 },
    ];
    expect(tokensToText(tokens)).toBe('web server');
    expect(tokensToText([])).toBe('');
  });

  it('normalises each row to a probability distribution in place', () => {
    const lp = new Float32Array([0, 1, 2, 0, 0, 0]);
    logSoftmaxInPlace(lp, 2, 3);

    for (let row = 0; row < 2; row++) {
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += Math.exp(lp[row * 3 + i]);
      expect(sum).toBeCloseTo(1, 5);
    }
    // The argmax is preserved (`[0,1,2]` stays ordered) and a uniform row stays uniform.
    expect(lp[2]).toBeGreaterThan(lp[1]);
    expect(lp[1]).toBeGreaterThan(lp[0]);
    expect(lp[3]).toBeCloseTo(Math.log(1 / 3), 5);
  });

  it('drops the four prefix frames when decoding the model output', () => {
    const vocab = REGRESSION_VOCAB.length;
    const tail = regressionLogits();
    // The model emits `frames + 4` rows; the first four are a decodable lie that must not surface.
    const logits = new Float32Array((26 + 4) * vocab).fill(LOSER);
    logits.fill(WINNER, 0, vocab * 4);
    logits.set(tail, 4 * vocab);

    const decoded = decodeLogits(logits, 26, REGRESSION_VOCAB);

    expect(decoded.tokens.map((token) => [token.tok, token.t])).toEqual([
      ['检', 4],
      ['查', 7],
      ['we', 12],
      ['b', 15],
      ['▁server', 18],
      ['进', 25],
    ]);
    expect(decoded.text).toBe('检查web server进');
  });

  it('reads a 16-bit PCM WAV and refuses another bit depth', () => {
    const wav = parseWav(makeWav([0, 100, -100, 32767, -32768]));

    expect(wav.sampleRate).toBe(16000);
    expect(wav.channels).toBe(1);
    expect(Array.from(wav.samples)).toEqual([0, 100, -100, 32767, -32768]);
    expect(() => parseWav(makeWav([0, 1], 16000, 8))).toThrow(/16-bit/);
  });

  it('builds a filterbank whose rows and weights are well formed', () => {
    const banks = makeMelBanks(80, 512, 16000, 20, 0);

    expect(banks).toHaveLength(80);
    let nonZero = 0;
    for (const bank of banks) {
      expect(bank).toHaveLength(256);
      for (const weight of bank) {
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
        if (weight > 0) nonZero++;
      }
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('floors a silent frame at the Kaldi epsilon, for every bin', () => {
    const frames = 3;
    const silence = fbank(new Float32Array(720));

    expect(silence.frames).toBe(frames);
    expect(silence.bins).toBe(80);
    expect(silence.data).toHaveLength(frames * 80);
    for (const value of silence.data) expect(value).toBeCloseTo(Math.log(FLOOR), 6);
  });

  it('removes each frame mean: a constant offset does not move the fbank', () => {
    const samples = new Float32Array(720);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.1) * 1000;
    const shifted = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) shifted[i] = samples[i] + 500;

    const base = fbank(samples);
    const moved = fbank(shifted);

    expect(moved.frames).toBe(base.frames);
    let maxDelta = 0;
    for (let i = 0; i < base.data.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(base.data[i] - moved.data[i]));
    }
    // Mean removal makes the two identical; without it, a DC offset dominates every bin.
    expect(maxDelta).toBeLessThan(1e-3);
    // A pure-tone frame is not silent, so the floor is not what is being compared.
    expect(base.data.some((value) => value > Math.log(FLOOR) + 1)).toBe(true);
  });

  it('left-pads the LFR window with three copies of the first frame, then applies CMVN', () => {
    const bins = 2;
    const F = new Float32Array([0.5, 0.25]);
    const NEG = Float32Array.from({ length: 14 }, (_, k) => -k);
    const INV = Float32Array.from({ length: 14 }, (_, k) => 1 + k * 0.1);

    const features = lfrCmvn(F, 1, bins, NEG, INV);

    expect(features.frames).toBe(1);
    expect(features.dim).toBe(14);
    // Position j draws Fp[j]; with one real frame the first four positions are all that frame, and
    // the CMVN vector is indexed by the stacked window position, not by the bin alone.
    for (let j = 0; j < 7; j++) {
      for (let d = 0; d < bins; d++) {
        const expected = (F[d] + NEG[j * bins + d]) * INV[j * bins + d];
        // Five places, not six: the result is stored in a `Float32Array`, so a value near 25 carries
        // a float32 rounding of about 1e-6 — the same rounding the probe recorded as `max|Δ| = 1.7e-5`
        // against the Python oracle.
        expect(features.data[j * bins + d]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('reads ONNX metadata_props by field number and skips what it does not know', () => {
    // `metadata_props` is a REPEATED field 14, one key/value pair per entry — not one entry holding
    // several pairs — which is exactly the shape the model carries and the walker must survive.
    const props: number[] = [];
    for (const [key, value] of [
      ['lfr_window_size', '7'],
      ['lfr_window_shift', '6'],
      ['vocab_size', '25055'],
    ]) {
      const entry = metadataProp(key, value);
      props.push(0x72, ...varint(entry.length), ...entry);
    }
    // An unrelated field (7, varint) before the metadata block, to exercise the wire-type skip.
    const bytes = [...varint(7 << 3), ...varint(1234), ...props];
    const meta = parseOnnxMetadata(new Uint8Array(bytes).buffer);

    expect(meta.lfr_window_size).toBe('7');
    expect(meta.lfr_window_shift).toBe('6');
    expect(meta.vocab_size).toBe('25055');
    expect(VOICE_CLIENT_PROBE_VERSION).toBe('v1');
  });
});
