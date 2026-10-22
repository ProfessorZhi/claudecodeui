import sys, glob, re, numpy as np
sys.path.insert(0, '.')
import svlib, sherpa_onnx, difflib
norm = lambda s: re.sub(r'[\s,.!?;:，。！？；：、"\'-]', '', s).lower()
W = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/wav/'
fs = sorted(glob.glob(W + '[0-9]*.wav'))[:60]
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
same_sh = same_shift = same_noise = 0; lowconf_at_diff = []; n = 0
for f in fs:
    x = svlib.load(f); lp = svlib.logsoftmax(svlib.logits(x)); tk = svlib.greedy(lp); own = svlib.to_text(tk)
    s = rec.create_stream(); s.accept_waveform(16000, x); rec.decode_stream(s); sh = s.result.text
    x2 = np.concatenate([np.zeros(1, dtype=np.float32), x]); own2 = svlib.to_text(svlib.greedy(svlib.logsoftmax(svlib.logits(x2))))      # 1-sample shift
    x3 = x + np.random.RandomState(0).normal(0, 1e-5, len(x)).astype(np.float32); own3 = svlib.to_text(svlib.greedy(svlib.logsoftmax(svlib.logits(x3))))  # -100 dB noise
    n += 1; same_sh += norm(own) == norm(sh); same_shift += norm(own) == norm(own2); same_noise += norm(own) == norm(own3)
    if norm(own) != norm(sh):
        a, b = norm(own), norm(sh); sm = difflib.SequenceMatcher(None, a, b)
        # confidence of own tokens whose characters fall in a differing span: use min p of the tokens overall in that region (approximate by position)
        chars = ''.join(norm(k['tok']) for k in tk); pos = 0; spans = []
        for k in tk: nk = norm(k['tok']); spans.append((pos, pos + len(nk), k['p'])); pos += len(nk)
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op != 'equal':
                ps = [p for a0, a1, p in spans if a0 < max(i2, i1 + 1) and i1 < a1]
                if ps: lowconf_at_diff.append(min(ps))
print('own vs sherpa identical', same_sh, '/', n, '| own vs own shifted by 1 sample', same_shift, '/', n, '| own vs own with -100 dB noise', same_noise, '/', n)
print('diff spans (own vs sherpa):', len(lowconf_at_diff), 'with min token p < 0.6:', sum(p < 0.6 for p in lowconf_at_diff), '| median p at diffs %.2f' % np.median(lowconf_at_diff))
