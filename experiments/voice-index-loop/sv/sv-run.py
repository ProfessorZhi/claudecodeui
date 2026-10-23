"""S0 + S1 inputs: run every clip through sherpa-onnx (text, timing) and the own CTC pipeline (tokens, confidences, log-probs)."""
import sys, os, json, glob, time, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svlib, sherpa_onnx, numpy as np
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
OUT = ROOT + 'sv/'; os.makedirs(OUT + 'lp', exist_ok=True)
clips = []
for f in sorted(glob.glob(ROOT + 'wav/*.wav')): clips.append(('v3:' + os.path.basename(f)[:-4], f))      # v3 (digits) and chunks (c<cid>)
for f in sorted(glob.glob('/data/home/yale/work/tc-verify/corpus/voice-context-asr/wav/*.wav')): clips.append(('pilot:' + os.path.basename(f)[:-4], f))
for f in sorted(glob.glob(os.path.expanduser('~/.cloudcli/voice-capture/*.bin'))): clips.append(('real:' + os.path.basename(f)[:-4], f))
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
done = set(json.loads(l)['id'] for l in open(OUT + 'sv.jsonl')) if os.path.exists(OUT + 'sv.jsonl') else set()
norm = lambda s: re.sub(r'[\s,.!?;:，。！？；：、"\'-]', '', s).lower()
n = 0
with open(OUT + 'sv.jsonl', 'a') as fo:
    for cid, path in clips:
        if cid in done: continue
        try: x = svlib.load(path)
        except Exception as e: fo.write(json.dumps({'id': cid, 'err': str(e)[:100]}) + '\n'); continue
        dur = len(x) / 16000
        s = rec.create_stream(); s.accept_waveform(16000, x); t0 = time.time(); rec.decode_stream(s); dt = time.time() - t0
        sh = s.result
        t1 = time.time(); lp = svlib.logsoftmax(svlib.logits(x)); own_dt = time.time() - t1
        toks = svlib.greedy(lp); own = svlib.to_text(toks)
        np.save(OUT + 'lp/' + cid.replace(':', '_') + '.npy', lp.astype(np.float16))
        fo.write(json.dumps({'id': cid, 'dur': dur, 'sherpa_text': sh.text, 'sherpa_dt': dt, 'own_text': own, 'own_dt': own_dt, 'same': norm(own) == norm(sh.text), 'tokens': [{'tok': k['tok'], 'p': round(k['p'], 4), 't': k['t']} for k in toks]}, ensure_ascii=False) + '\n'); fo.flush()
        n += 1
        if n % 100 == 0: print(n, '/', len(clips) - len(done), flush=True)
print('finished')
