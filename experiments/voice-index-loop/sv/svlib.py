"""SenseVoice-Small (sherpa-onnx int8 export) with the CTC posteriors exposed.
Own front end (fbank 80, LFR 7/6, CMVN from the model metadata) + onnxruntime; the first 4 output frames are the
language / event / emotion / text-norm prefix and are dropped. Text for the engine comparison comes from sherpa-onnx itself."""
import numpy as np, soundfile as sf, onnxruntime as ort, kaldi_native_fbank as knf, os, re, subprocess, tempfile
D = '/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
_so = ort.SessionOptions(); _so.intra_op_num_threads = int(os.environ.get('SV_THREADS', '4')); _so.inter_op_num_threads = 1
sess = ort.InferenceSession(f'{D}/model.int8.onnx', providers=['CPUExecutionProvider'], sess_options=_so)
meta = sess.get_modelmeta().custom_metadata_map
NEG = np.array([float(v) for v in meta['neg_mean'].split(',')], dtype=np.float32)
INV = np.array([float(v) for v in meta['inv_stddev'].split(',')], dtype=np.float32)
TOKS = [l.rsplit(' ', 1)[0] for l in open(f'{D}/tokens.txt', encoding='utf8').read().split('\n') if l]
FRAME_MS = 60
LFR_PAD = os.environ.get('SV_LFR_PAD', '1') == '1'  # one LFR frame = 6 fbank frames x 10 ms

def load(path):
    try:
        x, sr = sf.read(path, dtype='float32')
    except Exception:
        with tempfile.NamedTemporaryFile(suffix='.wav') as t:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', '16000', t.name], check=True)
            x, sr = sf.read(t.name, dtype='float32')
    if x.ndim > 1: x = x.mean(1)
    if sr != 16000:
        with tempfile.NamedTemporaryFile(suffix='.wav') as a, tempfile.NamedTemporaryFile(suffix='.wav') as b:
            sf.write(a.name, x, sr); subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', a.name, '-ac', '1', '-ar', '16000', b.name], check=True)
            x, sr = sf.read(b.name, dtype='float32')
    return x

def feats(x):
    o = knf.FbankOptions(); o.frame_opts.dither = 0; o.frame_opts.snip_edges = os.environ.get('SV_SNIP', '1') == '1'; o.frame_opts.samp_freq = 16000
    o.mel_opts.num_bins = 80; o.frame_opts.window_type = 'hamming'
    if os.environ.get('SV_DC'): o.frame_opts.remove_dc_offset = os.environ['SV_DC'] == '1'
    if os.environ.get('SV_POW2'): o.frame_opts.round_to_power_of_two = os.environ['SV_POW2'] == '1'
    if os.environ.get('SV_WIN'): o.frame_opts.window_type = os.environ['SV_WIN']
    if os.environ.get('SV_LOW'): o.mel_opts.low_freq = float(os.environ['SV_LOW'])
    if os.environ.get('SV_HIGH'): o.mel_opts.high_freq = float(os.environ['SV_HIGH'])
    if os.environ.get('SV_PREEMPH'): o.frame_opts.preemph_coeff = float(os.environ['SV_PREEMPH'])
    f = knf.OnlineFbank(o); f.accept_waveform(16000, (x * float(os.environ.get('SV_SCALE', '32768'))).tolist()); f.input_finished()
    F = np.stack([f.get_frame(i) for i in range(f.num_frames_ready)])
    T = F.shape[0]
    if LFR_PAD:   # FunASR style: left-pad 3 copies of the first frame, right-pad by repetition
        F = np.concatenate([np.repeat(F[:1], 3, 0), F]); n = (T + 5) // 6
    else:         # sherpa-onnx style: no padding, T_lfr = (T - 7) // 6 + 1
        n = (T - 7) // 6 + 1
    out = []
    for i in range(n):
        w = F[i * 6:i * 6 + 7]
        if len(w) < 7: w = np.concatenate([w, np.repeat(F[-1:], 7 - len(w), 0)])
        out.append(w.reshape(-1))
    return ((np.stack(out) + NEG) * INV).astype(np.float32)

def logits(x):
    X = feats(x)[None]
    lg = sess.run(None, {'x': X, 'x_length': np.array([X.shape[1]], np.int32), 'language': np.array([0], np.int32), 'text_norm': np.array([14], np.int32)})[0][0]
    return lg[4:]  # drop the 4 prefix frames

def logsoftmax(lg):
    m = lg.max(-1, keepdims=True); z = lg - m
    return z - np.log(np.exp(z).sum(-1, keepdims=True))

def greedy(lp):
    ids = lp.argmax(-1); pm = np.exp(lp.max(-1))
    toks = []; prev = -1
    for t, (i, p) in enumerate(zip(ids, pm)):
        if i != prev and i != 0:
            toks.append({'tok': TOKS[i], 'p': float(p), 't': int(t), 'id': int(i)})
        elif i == prev and i != 0 and toks: toks[-1]['p'] = max(toks[-1]['p'], float(p))
        prev = i
    return [k for k in toks if not k['tok'].startswith('<|')]

def to_text(toks):
    return ''.join(k['tok'] for k in toks).replace('▁', ' ').strip()
