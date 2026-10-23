"""Punctuation post-processing experiment (PREREG-v7): does a punctuation model beat SenseVoice's own?

Run:
  PYTHONPATH=<patched sherpa build lib> python3 -I experiments/voice-index-loop/sv/punct-eval.py
Reads the corpus outside the repo (tc-verify/corpus/voice-index-loop/) and prints aggregates only —
no message text and no model output reach stdout.
"""
import ast
import difflib
import json
import os
import re
import statistics
import sys
import time

ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
MODEL = '/data/home/yale/work/sv-probe/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx'

import sherpa_onnx as so  # noqa: E402

cfg = so.OfflinePunctuationConfig(
    model=so.OfflinePunctuationModelConfig(ct_transformer=MODEL, num_threads=1, provider='cpu'),
)
punct = so.OfflinePunctuation(cfg)

CLASS_OF = {}
for ch in '，、；：,;:':
    CLASS_OF[ch] = 'comma'
for ch in '。':
    CLASS_OF[ch] = 'period'
for ch in '？?':
    CLASS_OF[ch] = 'question'
for ch in '！!':
    CLASS_OF[ch] = 'excl'
DOT = '.'
OTHER_PUNCT = set('()（）[]【】{}"“”‘’\'`~…—-_/\\<>《》「」』『·|@#$%^&*+=')
CJK = re.compile(r'[㐀-鿿]')


def is_sep(ch):
    return ch.isspace()


def gaps(text):
    """(stripped chars, labels): labels[i] is the punctuation class after chars[i]; labels[-1] is sentence end."""
    chars = []
    labels = []
    pending = None
    for i, ch in enumerate(text):
        if is_sep(ch):
            continue
        cls = CLASS_OF.get(ch)
        if ch == DOT:
            # a dot inside a number / file name / identifier is not punctuation
            prev = text[i - 1] if i > 0 else ''
            nxt = text[i + 1] if i + 1 < len(text) else ''
            cls = None if (prev.isalnum() and nxt.isalnum()) else 'period'
            if cls is None:
                chars.append(ch)
                labels.append(None)
                continue
        if cls is not None:
            if labels:
                labels[-1] = labels[-1] or cls
            continue
        if ch in OTHER_PUNCT:
            # brackets, quotes and joiners are kept as characters (they belong to identifiers/code).
            chars.append(ch)
            labels.append(None)
            continue
        chars.append(ch)
        labels.append(None)
    return ''.join(chars).lower(), labels


def strip_punct(text):
    out = []
    for i, ch in enumerate(text):
        if ch in CLASS_OF:
            continue
        if ch == DOT:
            prev = text[i - 1] if i > 0 else ''
            nxt = text[i + 1] if i + 1 < len(text) else ''
            if not (prev.isalnum() and nxt.isalnum()):
                continue
        out.append(ch)
    return ''.join(out)


def asr_like(text):
    """Gold with punctuation removed and spaces next to CJK removed (the shape a recogniser emits)."""
    t = strip_punct(text)
    t = re.sub(r'\s*([㐀-鿿])\s*', r'\1', t)
    return re.sub(r'\s+', ' ', t).strip()


class Tally:
    def __init__(self):
        self.tp = {}
        self.fp = {}
        self.fn = {}

    def add(self, gold, pred):
        for g, p in zip(gold, pred):
            if g and p == g:
                self.tp[g] = self.tp.get(g, 0) + 1
            else:
                if p:
                    self.fp[p] = self.fp.get(p, 0) + 1
                if g:
                    self.fn[g] = self.fn.get(g, 0) + 1

    def f1(self, classes=None):
        keys = classes or ['comma', 'period', 'question', 'excl']
        tp = sum(self.tp.get(k, 0) for k in keys)
        fp = sum(self.fp.get(k, 0) for k in keys)
        fn = sum(self.fn.get(k, 0) for k in keys)
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        return round(p, 3), round(r, 3), round(f, 3), tp + fn

    def report(self):
        out = {'micro(p,r,f1,gold)': self.f1()}
        for k in ('comma', 'period', 'question', 'excl'):
            out[k] = self.f1([k])
        return out


def load():
    stream = {int(s['id']): s for s in json.load(open(ROOT + 'stream.json')) if s.get('selected')}
    sv = {}
    for line in open(ROOT + 'sv2/sv.jsonl'):
        r = json.loads(line)
        if r.get('tokens') and re.fullmatch(r'v3:\d+', r['id']):
            sv[int(r['id'][3:])] = r
    return stream, sv


def model(text):
    t0 = time.perf_counter()
    out = punct.add_punctuation(text)
    return out, (time.perf_counter() - t0) * 1000


def main():
    stream, sv = load()
    ids = sorted(set(stream) & set(sv))
    print(f'messages gold={len(stream)} sv={len(sv)} both={len(ids)}')

    # ---- E1: the model alone, on gold with the punctuation removed
    t1 = Tally()
    same = 0
    ends = {'gold': 0, 'pred': 0, 'both': 0}
    times = []
    id_total = 0
    id_intact = 0
    id_msgs = 0
    for i in ids:
        gold = stream[i]['text']
        src = asr_like(gold)
        out, ms = model(src)
        times.append(ms)
        g_chars, g_lab = gaps(gold)
        s_chars, _ = gaps(src)
        o_chars, o_lab = gaps(out)
        if o_chars == s_chars:
            same += 1
        if g_chars == o_chars:
            t1.add(g_lab, o_lab)
            ge = bool(g_lab and g_lab[-1])
            pe = bool(o_lab and o_lab[-1])
            ends['gold'] += ge
            ends['pred'] += pe
            ends['both'] += ge and pe
        try:
            idl = ast.literal_eval(stream[i]['ids']) if isinstance(stream[i]['ids'], str) else stream[i]['ids']
        except Exception:
            idl = []
        if idl:
            id_msgs += 1
            flat = re.sub(r'\s+', '', out)
            for ident in idl:
                id_total += 1
                if re.sub(r'\s+', '', ident) in flat:
                    id_intact += 1
    print('\nE1 model on punctuation-stripped gold')
    print(' content-unchanged:', same, '/', len(ids), round(same / len(ids), 4))
    print(' tally:', json.dumps(t1.report(), ensure_ascii=False))
    print(' sentence-end gold/pred/both:', ends)
    print(' identifier intact:', id_intact, '/', id_total, 'in', id_msgs, 'messages',
          round(id_intact / id_total, 4) if id_total else None)
    print(' ms median/p90:', round(statistics.median(times), 1), round(sorted(times)[int(len(times) * 0.9)], 1))

    # ---- E2: the pipeline on SenseVoice text, three arms
    arms = {'a_own': Tally(), 'b_strip_then_model': Tally(), 'c_own_plus_fill': Tally()}
    evaluable = 0
    total_gaps = 0
    own_has_punct = 0
    for i in ids:
        gold = stream[i]['text']
        sv_text = sv[i]['sherpa_text']
        sv_text = re.sub(r'<\|[^|]*\|>', '', sv_text)
        g_chars, g_lab = gaps(gold)
        a_chars, a_lab = gaps(sv_text)
        stripped_in = asr_like(sv_text) if False else strip_punct(sv_text)
        b_out, _ = model(stripped_in)
        b_chars, b_lab = gaps(b_out)
        if b_chars != a_chars:
            continue  # the model changed content; arm b/c not comparable for this message (counted below)
        # arm c: own labels where present, model labels elsewhere
        c_lab = [o or m for o, m in zip(a_lab, b_lab)]
        sm = difflib.SequenceMatcher(a=g_chars, b=a_chars, autojunk=False)
        pairs = []
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                pairs.append((blk.a + k, blk.b + k))
        # evaluable gap: this pair and the NEXT pair are consecutive in both strings (or the pair is the last char of both)
        gl, al, bl, cl = [], [], [], []
        for n, (ga, ab) in enumerate(pairs):
            total_gaps += 1
            last = n + 1 == len(pairs)
            if last:
                ok = ga == len(g_chars) - 1 and ab == len(a_chars) - 1
            else:
                ng, nb = pairs[n + 1]
                ok = ng == ga + 1 and nb == ab + 1
            if not ok:
                continue
            evaluable += 1
            gl.append(g_lab[ga])
            al.append(a_lab[ab])
            bl.append(b_lab[ab])
            cl.append(c_lab[ab])
            own_has_punct += bool(a_lab[ab])
        arms['a_own'].add(gl, al)
        arms['b_strip_then_model'].add(gl, bl)
        arms['c_own_plus_fill'].add(gl, cl)
    print('\nE2 pipeline on SenseVoice text (matched gaps only)')
    print(' evaluable gaps:', evaluable, 'of', total_gaps, 'matched chars; own-punct gaps among them:', own_has_punct)
    for name, t in arms.items():
        print(' ', name, json.dumps(t.report(), ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
