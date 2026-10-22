import sys, glob, time
sys.path.insert(0, '/data/home/yale/work/claudecodeui/experiments/voice-index-loop/sv')
import svlib, sherpa_onnx, numpy as np, re
r = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
norm = lambda s: re.sub(r'[\s,.!?;:，。！？；：、"\'-]', '', s).lower()
W = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/wav/'
fs = sorted(glob.glob(W + '*.wav'))[:40]
same = 0
for f in fs:
    x = svlib.load(f); lp = svlib.logsoftmax(svlib.logits(x)); own = svlib.to_text(svlib.greedy(lp))
    s = r.create_stream(); s.accept_waveform(16000, x); r.decode_stream(s); sh = s.result.text
    ok = norm(own) == norm(sh); same += ok
    if not ok: print('DIFF\n  own  ', own, '\n  sherp', sh)
print('same', same, '/', len(fs))
