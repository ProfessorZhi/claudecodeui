"""PREREG-v8: SenseVoice use_itn x language vs sentence segmentation. Aggregates only."""
import difflib, glob, importlib.util, os, re, sys, time
import numpy as np
import soundfile as sf
import sherpa_onnx

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('pe', os.path.join(here, 'punct-eval.py'))
pe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pe)

D = '/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
ROOT = pe.ROOT
stream, _ = pe.load()
ids = sorted(stream)

def run(use_itn, language):
    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=f'{D}/model.int8.onnx', tokens=f'{D}/tokens.txt', num_threads=4, use_itn=use_itn, language=language)
    out = {}
    for i in ids:
        path = f'{ROOT}wav/{i}.wav'
        if not os.path.exists(path):
            continue
        x, sr = sf.read(path, dtype='float32')
        if x.ndim > 1:
            x = x.mean(1)
        s = rec.create_stream()
        s.accept_waveform(sr, x)
        rec.decode_stream(s)
        out[i] = re.sub(r'<\|[^|]*\|>', '', s.result.text)
    return out

def evaluate(texts):
    bound = pe.Tally(); sent = pe.Tally(); comma = pe.Tally()
    matched_chars = gold_chars = 0
    for i, text in texts.items():
        g_chars, g_lab = pe.gaps(stream[i]['text'])
        a_chars, a_lab = pe.gaps(text)
        sm = difflib.SequenceMatcher(a=g_chars, b=a_chars, autojunk=False)
        pairs = []
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                pairs.append((blk.a + k, blk.b + k))
        matched_chars += len(pairs); gold_chars += len(g_chars)
        gl, al = [], []
        for n, (ga, ab) in enumerate(pairs):
            last = n + 1 == len(pairs)
            if last:
                ok = ga == len(g_chars) - 1 and ab == len(a_chars) - 1
            else:
                ng, nb = pairs[n + 1]
                ok = ng == ga + 1 and nb == ab + 1
            if ok:
                gl.append(g_lab[ga]); al.append(a_lab[ab])
        any_g = ['b' if v else None for v in gl]; any_a = ['b' if v else None for v in al]
        bound.add(any_g, any_a)
        se = lambda v: 's' if v in ('period', 'question', 'excl') else None
        sent.add([se(v) for v in gl], [se(v) for v in al])
        cm = lambda v: 'c' if v == 'comma' else None
        comma.add([cm(v) for v in gl], [cm(v) for v in al])
    f = lambda t, k: t.f1([k])
    return {
        'boundary(p,r,f1,gold)': f(bound, 'b'),
        'sentence-end': f(sent, 's'),
        'comma': f(comma, 'c'),
        'char-match': round(matched_chars / gold_chars, 4),
        'messages': len(texts),
    }

for use_itn in (True, False):
    for language in ('auto', 'zh'):
        t0 = time.time()
        texts = run(use_itn, language)
        r = evaluate(texts)
        print(f'use_itn={use_itn!s:5} language={language:4}', r, f'{time.time()-t0:.0f}s', flush=True)
