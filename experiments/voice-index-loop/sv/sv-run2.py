"""Round 6 engine: patched sherpa-onnx 1.13.8 (SHERPA_ONNX_DUMP_LOG_PROBS=1) — text, token log-probs and the frame log-prob matrix
all come out of the same runtime, so nothing is re-derived by a second front end.
   PYTHONPATH=<patched build> python sv-run2.py"""
import sys, os, json, glob, time
os.environ['SHERPA_ONNX_DUMP_LOG_PROBS'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svlib, sherpa_onnx, numpy as np
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
OUT = ROOT + 'sv2/'; os.makedirs(OUT + 'lp', exist_ok=True)
clips = []
for f in sorted(glob.glob(ROOT + 'wav/*.wav')): clips.append(('v3:' + os.path.basename(f)[:-4], f))
for f in sorted(glob.glob('/data/home/yale/work/tc-verify/corpus/voice-context-asr/wav/*.wav')): clips.append(('pilot:' + os.path.basename(f)[:-4], f))
for f in sorted(glob.glob(os.path.expanduser('~/.cloudcli/voice-capture/*.bin'))): clips.append(('real:' + os.path.basename(f)[:-4], f))
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
done = set(json.loads(l)['id'] for l in open(OUT + 'sv.jsonl')) if os.path.exists(OUT + 'sv.jsonl') else set()
n = 0
with open(OUT + 'sv.jsonl', 'a') as fo:
    for cid, path in clips:
        if cid in done: continue
        try: x = svlib.load(path)
        except Exception as e: fo.write(json.dumps({'id': cid, 'err': str(e)[:100]}) + '\n'); continue
        s = rec.create_stream(); s.accept_waveform(16000, x); t0 = time.time(); rec.decode_stream(s); dt = time.time() - t0
        r = s.result; ys = list(r.ys_log_probs); ts = list(r.timestamps); tk = list(r.tokens)
        lp = r.frame_log_probs
        np.save(OUT + 'lp/' + cid.replace(':', '_') + '.npy', lp.astype(np.float16))
        toks = [{'tok': t, 'p': round(float(np.exp(p)), 4), 't': int(round(tt / 0.06))} for t, p, tt in zip(tk, ys, ts)]
        toks = [k for k in toks if not k['tok'].startswith('<|')]
        fo.write(json.dumps({'id': cid, 'dur': len(x) / 16000, 'sherpa_text': r.text, 'own_text': r.text, 'sherpa_dt': dt, 'same': True, 'frames': int(lp.shape[0]), 'tokens': toks}, ensure_ascii=False) + '\n'); fo.flush()
        n += 1
        if n % 100 == 0: print(n, flush=True)
print('finished')
