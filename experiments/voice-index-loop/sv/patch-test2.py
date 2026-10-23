import sys, os, glob, re, numpy as np, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ['SHERPA_ONNX_DUMP_LOG_PROBS'] = '1'
import svlib, sherpa_onnx
r = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
norm = lambda s: re.sub(r'[\s,.!?;:，。！？；：、"\'-]', '', s).lower()
orig = json.load(open('/tmp/vk/orig-texts.json')); same_own = same_orig = 0; pd = []; tokeq = 0
for f, txt in orig.items():
    x = svlib.load(f); s = r.create_stream(); s.accept_waveform(16000, x); r.decode_stream(s); res = s.result
    tk = svlib.greedy(svlib.logsoftmax(svlib.logits(x))); own = svlib.to_text(tk)
    same_own += norm(res.text) == norm(own); same_orig += norm(res.text) == norm(txt)
    if [t['tok'] for t in tk] == list(res.tokens): tokeq += 1; pd += [abs(t['p'] - float(np.exp(lp))) for t, lp in zip(tk, res.ys_log_probs)]
print('patched==own', same_own, '/60 | patched==pip-1.13.8', same_orig, '/60 | identical token sequences', tokeq, '/60 | per-token |p_own - p_sherpa| median %.4f max %.4f' % (np.median(pd), max(pd)))
