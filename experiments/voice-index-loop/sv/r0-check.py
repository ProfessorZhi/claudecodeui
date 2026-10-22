"""R0: (a) the patched build is deterministic, (c) where patched and pip sherpa differ, are the tokens confident or not."""
import sys, os, re, json, glob, difflib
os.environ['SHERPA_ONNX_DUMP_LOG_PROBS'] = '0'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svlib, sherpa_onnx
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
norm = lambda s: re.sub(r'[\s,.!?;:，。！？；：、"\'-]', '', s).lower()
if sys.argv[1] == 'run':
    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
    out = {}
    for f in sorted(glob.glob(ROOT + 'wav/[0-9]*.wav'))[:150]:
        x = svlib.load(f); s = rec.create_stream(); s.accept_waveform(16000, x); rec.decode_stream(s); out[os.path.basename(f)] = s.result.text
    json.dump(out, open(sys.argv[2], 'w'), ensure_ascii=False); sys.exit()
a = json.load(open(sys.argv[2])); b = json.load(open(sys.argv[3]))
print('(a) patched build, two runs, identical text:', sum(norm(a[k]) == norm(b[k]) for k in a), '/', len(a))
# (c) patched (sv2) tokens vs pip text
new = {json.loads(l)['id']: json.loads(l) for l in open(ROOT + 'sv2/sv.jsonl')}; pip = {json.loads(l)['id']: json.loads(l) for l in open(ROOT + 'sv/sv.jsonl')}
conf = inn = 0; allt = 0; dif = 0
for cid, r in new.items():
    if 'tokens' not in r or cid not in pip: continue
    pos = 0; spans = []
    for k in r['tokens']: nk = norm(k['tok']); spans.append((pos, pos + len(nk), k['p'])); pos += len(nk)
    s1 = ''.join(norm(k['tok']) for k in r['tokens']); s2 = norm(pip[cid]['sherpa_text'])
    sm = difflib.SequenceMatcher(None, s1, s2, autojunk=False); indiff = set()
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op != 'equal':
            for idx, (x0, x1, p) in enumerate(spans):
                if x0 < max(i2, i1 + 1) and i1 < x1: indiff.add(idx)
    for idx, (x0, x1, p) in enumerate(spans):
        allt += 1; dif += idx in indiff
        if p >= 0.85: conf += 1; inn += idx in indiff
print('(c) patched vs pip: tokens in a differing span %.1f%% (%d/%d); confident tokens (p>=0.85) in a differing span %.2f%% (%d/%d)' % (100 * dif / allt, dif, allt, 100 * inn / conf, inn, conf))
