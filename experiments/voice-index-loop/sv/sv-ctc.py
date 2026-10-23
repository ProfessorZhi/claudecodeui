"""S3: score lexicon candidates against the audio with CTC likelihood over low-confidence windows.
   python sv-ctc.py <sv.jsonl> <ents.json> <out.jsonl> <id-prefix filter e.g. 'v3:' or 'v3:c'>"""
import sys, os, json, re, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, svlib
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
SVD = os.environ.get('SVDIR', 'sv'); KLIM = int(os.environ.get('CTC_K', '0')); ALIASES = os.environ.get('ALIASES')
TH = 0.85            # window = consecutive tokens with p < TH, padded by one token each side
PAD_FRAMES = 2
LAM = 1.0
V = {t: i for i, t in enumerate(svlib.TOKS)}
SEG = {}
def seg_word(w, first=True):
    """fewest-pieces segmentation of one word into vocabulary pieces ('▁' marks the word start); None if impossible"""
    s = ('▁' if first else '') + w; n = len(s); best = [None] * (n + 1); best[0] = []
    for i in range(n):
        if best[i] is None: continue
        for j in range(i + 1, min(n, i + 12) + 1):
            p = s[i:j]
            if p in V and (best[j] is None or len(best[i]) + 1 < len(best[j])): best[j] = best[i] + [V[p]]
    return best[n]
def variants(term):
    if term in SEG: return SEG[term]
    words = [w for w in re.split(r'[-_.\s]+|(?<=[a-z])(?=[A-Z])', term) if w]
    out = []
    for form in (lambda w: w.lower(), lambda w: w, lambda w: w.upper()):
        ids = []; ok = True
        for k, w in enumerate(words):
            sg = seg_word(form(w), True)
            if sg is None: ok = False; break
            ids += sg
        if ok and ids and ids not in out: out.append(ids)
    SEG[term] = out; return out
def ctc_ll(lp, seqs):
    """log-likelihood of each label sequence over lp[T, V], free leading / trailing blanks. seqs: list of id lists. Vectorised over sequences."""
    T = lp.shape[0]; N = len(seqs); L = max(len(s) for s in seqs); S = 2 * L + 1
    lab = np.zeros((N, S), dtype=np.int64); ln = np.array([len(s) for s in seqs])
    for i, s in enumerate(seqs):
        for k, t in enumerate(s): lab[i, 2 * k + 1] = t
    em = lp[:, lab]                                   # [T, N, S]
    NEG = -1e30; a = np.full((N, S), NEG); a[:, 0] = em[0, :, 0]; a[:, 1] = em[0, :, 1]
    skip = np.zeros((N, S), dtype=bool); skip[:, 3::2] = lab[:, 3::2] != lab[:, 1:-2:2][:, :skip[:, 3::2].shape[1]]
    for t in range(1, T):
        p1 = np.concatenate([np.full((N, 1), NEG), a[:, :-1]], 1); p2 = np.concatenate([np.full((N, 2), NEG), a[:, :-2]], 1); p2 = np.where(skip, p2, NEG)
        a = np.logaddexp(np.logaddexp(a, p1), p2) + em[t]
    end = 2 * ln                                       # last label state index = 2*len-1, plus the trailing blank state 2*len
    return np.logaddexp(a[np.arange(N), end - 1], a[np.arange(N), end])
def main():
    global AL
    AL = json.load(open(ROOT + ALIASES)) if ALIASES else {}
    svf, entf, outf, pref = sys.argv[1:5]
    ents = json.load(open(ROOT + entf)); rows = [json.loads(l) for l in open(ROOT + SVD + '/' + svf)]
    done = set(json.loads(l)['id'] for l in open(ROOT + SVD + '/' + outf)) if os.path.exists(ROOT + SVD + '/' + outf) else set()
    t0 = time.time(); n = 0; LIMIT = int(os.environ.get('LIMIT', '0'))
    with open(ROOT + SVD + '/' + outf, 'a') as fo:
        for r in rows:
            cid = r['id']
            if LIMIT and n >= LIMIT: break
            if 'tokens' not in r or not cid.startswith(pref) or cid in done: continue
            if pref == 'v3:' and cid.startswith('v3:c'): continue
            mid = cid.split(':', 1)[1]; mid = mid if mid.startswith('c') is False else mid[1:]
            if mid not in ents and str(mid) not in ents: continue
            terms = ents.get(str(mid)) ; lp = np.load(ROOT + SVD + '/lp/' + cid.replace(':', '_') + '.npy').astype(np.float32)
            toks = r['tokens']; pos = []; raw = ''
            for k in toks: pos.append(len(raw)); raw += k['tok'].replace('▁', ' ')
            lead = len(raw) - len(raw.lstrip()); text = raw.strip()
            # windows
            wins = []; i = 0
            while i < len(toks):
                if toks[i]['p'] < TH:
                    j = i
                    while j + 1 < len(toks) and toks[j + 1]['p'] < TH: j += 1
                    a, b = max(0, i - 1), min(len(toks) - 1, j + 1)
                    if wins and a <= wins[-1][1] + 1: wins[-1][1] = b
                    else: wins.append([a, b])
                    i = j + 1
                else: i += 1
            terms = list(terms)
            if KLIM and len(terms) > KLIM:   # scale rule: recent first, then the user's own words by count, then the rest
                terms = sorted(terms, key=lambda e: (-e['r'], -min(e['c'], 99) - (1000 if 'U' in e.get('s', '') else 0), -e['p']))[:KLIM]
            alias_extra = {}
            if ALIASES:
                for canon, heard in AL.get(str(mid), []):
                    ws = [w for w in re.split(r'\s+', re.sub(r'[^A-Za-z0-9\s]', ' ', heard.lower())) if w]
                    ids = []; ok = bool(ws)
                    for w in ws:
                        sg = seg_word(w, True)
                        if sg is None: ok = False; break
                        ids += sg
                    if ok and ids: alias_extra.setdefault(canon, []).append(ids)
                have = {e['t'] for e in terms}
                for canon in alias_extra:
                    if canon not in have: terms.append({'t': canon, 'r': 0, 'p': 1, 'c': 1, 'ty': 'term', 's': 'A', 'tb': 0})
            cand_seqs = []; cand_idx = []
            for ci, e in enumerate(terms):
                for s in variants(e['t']) + alias_extra.get(e['t'], []): cand_seqs.append(s); cand_idx.append(ci)
            out_w = []; META = {}
            for a, b in wins:
                f0 = max(0, toks[a]['t'] - PAD_FRAMES); f1 = min(lp.shape[0], (toks[b + 1]['t'] if b + 1 < len(toks) else lp.shape[0]) + PAD_FRAMES)
                seg = lp[f0:f1]
                if seg.shape[0] < 2: continue
                hyp = [svlib.V_ID if False else V.get(k['tok'], 0) for k in toks[a:b + 1]]
                ll_h = float(ctc_ll(seg, [hyp])[0])
                keep = [(s, ci) for s, ci in zip(cand_seqs, cand_idx) if 2 * len(s) + 1 <= 2 * seg.shape[0] + 1 and len(s) <= seg.shape[0]]
                best = {}
                if keep:
                    ll = ctc_ll(seg, [s for s, _ in keep])
                    for (s, ci), v in zip(keep, ll):
                        if ci not in best or v > best[ci]: best[ci] = float(v)
                scored = []
                for ci, v in best.items():
                    e = terms[ci]; prior = 0.25 * e['p'] + 0.20 * e['r'] + 0.10 * min(1.0, e['c'] / 5)
                    scored.append((e['t'], v - ll_h, v - ll_h + LAM * prior)); META[e['t']] = [e.get('ty', ''), e.get('s', ''), e.get('tb', 0)]
                top_llr = sorted(scored, key=lambda x: -x[1])[:50]; top_pri = sorted(scored, key=lambda x: -x[2])[:50]
                cs = max(0, pos[a] - lead); ce = min(len(text), pos[b] + len(toks[b]['tok'].replace('▁', ' ')) - lead)
                out_w.append({'a': a, 'b': b, 'cs': cs, 'ce': ce, 'f0': f0, 'f1': f1, 'minp': min(k['p'] for k in toks[a:b + 1]), 'hyp': text[cs:ce], 'll_h': ll_h, 'llr': [[t, round(x, 2)] for t, x, _ in top_llr], 'pri': [[t, round(x, 2)] for t, _, x in top_pri], 'n': len(scored)})
            fo.write(json.dumps({'id': cid, 'text': text, 'windows': out_w, 'meta': META, 'pool': len(terms)}, ensure_ascii=False) + '\n'); fo.flush(); n += 1
            if n % 50 == 0: print(n, round(time.time() - t0), 's', flush=True)
    print('finished', n)
main()
