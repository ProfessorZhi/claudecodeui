import sys, os, glob, re, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svlib
if len(sys.argv) > 1 and sys.argv[1] == 'orig':
    import sherpa_onnx; print('original', sherpa_onnx.__file__)
    r = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
    import json
    out = {}
    for f in sorted(glob.glob('/data/home/yale/work/tc-verify/corpus/voice-index-loop/wav/[0-9]*.wav'))[:60]:
        x = svlib.load(f); s = r.create_stream(); s.accept_waveform(16000, x); r.decode_stream(s); out[f] = s.result.text
    json.dump(out, open('/tmp/vk/orig-texts.json', 'w'), ensure_ascii=False); sys.exit()
os.environ['SHERPA_ONNX_DUMP_LOG_PROBS'] = '1'
import sherpa_onnx, json; print('patched', sherpa_onnx.__file__)
r = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
orig = json.load(open('/tmp/vk/orig-texts.json'))
same = 0; n = 0; diffp = []; tokmatch = 0; tokn = 0
for f, txt in orig.items():
    x = svlib.load(f); s = r.create_stream(); s.accept_waveform(16000, x); r.decode_stream(s); res = s.result
    same += res.text == txt; n += 1
    ys = np.array(res.ys_log_probs); fl = res.frame_log_probs
    mine = svlib.logsoftmax(svlib.logits(x))
    # same number of frames? and agreement of per-frame argmax / probability with my own pipeline
    if n == 1: print('frames sherpa', fl.shape, 'mine', mine.shape, 'tokens', len(res.tokens), 'ys', ys.shape, 'text', res.text[:40])
    m = min(fl.shape[0], mine.shape[0])
    if m: diffp.append(float(np.abs(np.exp(fl[:m].max(-1)) - np.exp(mine[:m].max(-1))).mean()))
print('patched text == original text:', same, '/', n)
print('mean |max-prob(sherpa) - max-prob(own)| per frame: median %.4f, p90 %.4f' % (np.median(diffp), np.quantile(diffp, .9)))
