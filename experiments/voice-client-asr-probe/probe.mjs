// Client-side ASR feasibility probe — SenseVoice-Small int8 on onnxruntime-web (WASM).
//
// The front end (fbank 80 / LFR 7:6 / CMVN / CTC greedy + log-softmax) is a faithful port of the
// project's server-side reference `experiments/voice-index-loop/sv/svlib.py`; it is validated
// frame-for-frame against that reference before any reading is taken (see README §验证).
//
// This file is pure logic + `createProbe`; the page wiring lives in index.html, the static server
// in serve.mjs. Nothing here touches product code (src/ server/ shared/).

const FLOOR = 1.1920928955078125e-7; // std::numeric_limits<float>::epsilon(), Kaldi fbank floor
export const PROBE_VERSION = 'v1';

// ---------------------------------------------------------------- WAV (16-bit PCM)

export function parseWav(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, dataOff = -1, dataLen = 0, sampleRate = 16000, bits = 16, ch = 1;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      ch = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('wav: no data chunk');
  if (bits !== 16) throw new Error(`wav: only 16-bit PCM supported (got ${bits})`);
  const n = Math.floor(dataLen / 2 / ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2 * ch, true);
  return { samples: out, sampleRate, channels: ch };
}

// ---------------------------------------------------------------- fbank (Kaldi-compatible)

function hamming(n) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)); return w; }
const melScale = (f) => 1127.0 * Math.log(1.0 + f / 700.0);

export function makeMelBanks(numBins, fftLen, sampleRate, lowFreq, highFreq) {
  const fftBinWidth = sampleRate / fftLen;
  const numFftBins = fftLen / 2;
  if (highFreq <= 0) highFreq = sampleRate / 2;
  const melLow = melScale(lowFreq), melHigh = melScale(highFreq);
  const delta = (melHigh - melLow) / (numBins + 1);
  const banks = [];
  for (let m = 0; m < numBins; m++) {
    const left = melLow + m * delta, center = melLow + (m + 1) * delta, right = melLow + (m + 2) * delta;
    const w = new Float64Array(numFftBins);
    for (let i = 0; i < numFftBins; i++) {
      const mf = melScale(fftBinWidth * i);
      if (mf > left && mf < right) {
        const up = (mf - left) / (center - left), down = (right - mf) / (right - center);
        w[i] = Math.max(0, Math.min(up, down));
      }
    }
    banks.push(w);
  }
  return banks;
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

// Kaldi fbank defaults with dither=0, snip_edges=true, window=hamming, mel bins=80, low=20.
export function fbank(samples, {
  numBins = 80, frameLength = 400, frameShift = 160, sampleRate = 16000,
  lowFreq = 20, highFreq = 0, pad = 512, preemph = 0.97,
} = {}) {
  const win = hamming(frameLength);
  const banks = makeMelBanks(numBins, pad, sampleRate, lowFreq, highFreq);
  const numFrames = Math.floor((samples.length - frameLength) / frameShift) + 1;
  if (numFrames <= 0) return { data: new Float32Array(0), frames: 0, bins: numBins };
  const out = new Float32Array(numFrames * numBins);
  const re = new Float64Array(pad), im = new Float64Array(pad), frame = new Float64Array(frameLength);
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameShift;
    let mean = 0;
    for (let i = 0; i < frameLength; i++) mean += samples[start + i];
    mean /= frameLength;
    for (let i = 0; i < frameLength; i++) frame[i] = samples[start + i] - mean;
    for (let j = frameLength - 1; j >= 1; j--) frame[j] -= preemph * frame[j - 1];
    frame[0] -= preemph * frame[0]; // Kaldi: first sample uses itself, not the previous wave sample
    re.fill(0); im.fill(0);
    for (let i = 0; i < frameLength; i++) re[i] = frame[i] * win[i];
    fftInPlace(re, im);
    for (let m = 0; m < numBins; m++) {
      let e = 0; const w = banks[m];
      for (let i = 0; i < pad / 2; i++) { const pw = re[i] * re[i] + im[i] * im[i]; e += pw * w[i]; }
      out[f * numBins + m] = Math.log(e < FLOOR ? FLOOR : e);
    }
  }
  return { data: out, frames: numFrames, bins: numBins };
}

// LFR 7 / 6 with FunASR-style left padding (3 copies of the first frame), then per-dim CMVN.
export function lfrCmvn(F, T, bins, NEG, INV) {
  const Fp = new Float32Array((T + 3) * bins);
  Fp.set(F.subarray(0, bins), 0);
  Fp.set(F.subarray(0, bins), bins);
  Fp.set(F.subarray(0, bins), 2 * bins);
  Fp.set(F.subarray(0, T * bins), 3 * bins);
  const n = Math.floor((T + 5) / 6);
  const D = bins * 7;
  const out = new Float32Array(n * D);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 7; j++) {
      const src = i * 6 + j < T + 3 ? i * 6 + j : T + 2;
      for (let d = 0; d < bins; d++) {
        const k = j * bins + d;
        out[i * D + k] = (Fp[src * bins + d] + NEG[k]) * INV[k];
      }
    }
  }
  return { data: out, frames: n, dim: D };
}

// ---------------------------------------------------------------- ONNX metadata_props (minimal protobuf walk)

export function parseOnnxMetadata(buf) {
  const b = new Uint8Array(buf);
  let p = 0;
  const readVarint = () => { let r = 0, s = 0; for (;;) { const c = b[p++]; r += (c & 0x7f) * Math.pow(2, s); if (!(c & 0x80)) return r; s += 7; } };
  const readBytes = (len) => { const s = p; p += len; return b.subarray(s, s + len); };
  const readString = (len) => new TextDecoder().decode(readBytes(len));
  const skip = (wire) => {
    if (wire === 0) readVarint();
    else if (wire === 1) p += 8;
    else if (wire === 2) { const len = readVarint(); p += len; }
    else if (wire === 5) p += 4;
    else throw new Error(`protobuf: bad wire type ${wire}`);
  };
  const meta = {};
  while (p < b.length) {
    const tag = readVarint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 14 && wire === 2) { // metadata_props
      const len = readVarint();
      const end = p + len;
      let key = null, value = null;
      while (p < end) {
        const t2 = readVarint(), f2 = t2 >>> 3, w2 = t2 & 7;
        if (f2 === 1 && w2 === 2) key = readString(readVarint());
        else if (f2 === 2 && w2 === 2) value = readString(readVarint());
        else skip(w2);
      }
      if (key != null) meta[key] = value;
    } else skip(wire);
  }
  return meta;
}

// ---------------------------------------------------------------- CTC greedy

export function greedyDecode(lp, dim, TOKS) {
  const toks = [];
  let prev = -1;
  for (let t = 0; t < dim; t++) {
    let bi = 0, bp = lp[t * TOKS.length];
    for (let i = 1; i < TOKS.length; i++) { const v = lp[t * TOKS.length + i]; if (v > bp) { bp = v; bi = i; } }
    const pk = Math.exp(bp);
    if (bi !== prev && bi !== 0) toks.push({ tok: TOKS[bi], p: pk, t, id: bi });
    else if (bi === prev && bi !== 0 && toks.length) toks[toks.length - 1].p = Math.max(toks[toks.length - 1].p, pk);
    prev = bi;
  }
  return toks.filter((k) => !k.tok.startsWith('<|'));
}

export function logSoftmaxInPlace(lp, dim, n) {
  for (let t = 0; t < dim; t++) {
    const base = t * n;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) if (lp[base + i] > mx) mx = lp[base + i];
    let sum = 0;
    for (let i = 0; i < n; i++) { const e = Math.exp(lp[base + i] - mx); lp[base + i] = e; sum += e; }
    for (let i = 0; i < n; i++) lp[base + i] = Math.log(lp[base + i] / sum);
  }
}

export function tokensToText(toks) { return toks.map((k) => k.tok).join('').replace(/▁/g, ' ').trim(); }

// ---------------------------------------------------------------- probe

export async function createProbe({ ort, modelArrayBuffer, tokensText, buildId }) {
  const meta = parseOnnxMetadata(modelArrayBuffer);
  const NEG = Float32Array.from(meta.neg_mean.split(',').map(Number));
  const INV = Float32Array.from(meta.inv_stddev.split(',').map(Number));
  const TOKS = tokensText.split('\n').filter(Boolean).map((l) => l.slice(0, l.lastIndexOf(' ')));
  const numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
    ? Math.min(4, (navigator.hardwareConcurrency || 1)) : 1;
  ort.env.wasm.numThreads = numThreads;
  ort.env.wasm.simd = true;
  const t0 = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(modelArrayBuffer), {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  const loadMs = performance.now() - t0;

  async function runFromBytes(wavBuf) {
    const wav = parseWav(wavBuf);
    if (wav.sampleRate !== 16000) throw new Error(`probe expects 16 kHz mono (got ${wav.sampleRate})`);
    return runFromSamples(wav.samples);
  }

  async function runFromSamples(samples) {
    const t0 = performance.now();
    const F = fbank(samples);
    const L = lfrCmvn(F.data, F.frames, 80, NEG, INV);
    const nTok = TOKS.length;
    const lp = new Float32Array(L.frames * nTok);
    if (L.frames === 0) return { text: '', tokens: [], ms: 0, frames: 0, audioSec: samples.length / 16000 };
    const feeds = {};
    feeds.x = new ort.Tensor('float32', L.data, [1, L.frames, L.dim]);
    feeds.x_length = new ort.Tensor('int32', Int32Array.from([L.frames]), [1]);
    feeds.language = new ort.Tensor('int32', Int32Array.from([0]), [1]);
    feeds.text_norm = new ort.Tensor('int32', Int32Array.from([14]), [1]);
    return session.run(feeds).then((res) => {
      const logits = res[Object.keys(res)[0]].data; // [1, frames+4, vocab]
      const total = (L.frames + 4) * nTok;
      lp.set(logits.subarray(4 * nTok, total)); // drop the 4 prefix frames
      logSoftmaxInPlace(lp, L.frames, nTok);
      const toks = greedyDecode(lp, L.frames, TOKS);
      return { text: tokensToText(toks), tokens: toks, ms: performance.now() - t0, frames: L.frames, audioSec: samples.length / 16000 };
    });
  }

  return {
    meta, loadMs, numThreads,
    runFromSamples, runFromBytes,
    async run(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      const buf = await r.arrayBuffer();
      return { ...(await runFromBytes(await buf)), bytes: buf.byteLength };
    },
  };
}
