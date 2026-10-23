#!/usr/bin/env python3
"""E6: the messages v3 left out (> 160 chars, or path-like) cut at sentence punctuation into <= 160-char segments,
the way a VAD cut would. Keeps segments with identifier-shaped tokens; drops path-like / secret-like segments and
anything already selected in v3. Appends `stream-chunks.json` (outside the repo) and snapshots for new commits are
reused from snap.json (same project / commit mapping as the parent message)."""
import json, re, collections, importlib.util, sys
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
spec = importlib.util.spec_from_file_location('ex', __file__.replace('extract-chunks.py', 'extract.py'))
# reuse the shape rule and secret filter without re-running the extraction (extract.py runs at import, so copy them)
TOK = re.compile(r"[A-Za-z][A-Za-z0-9_./\-]*[A-Za-z0-9]|[A-Za-z]")
SECRET = re.compile(r'passwd|password|passphrase|token\b|secret|sk-[A-Za-z0-9]|Bearer |密码|口令|api[ _-]?key\s*[:=：]|authorized_keys', re.I)
def is_id(x):
    if len(x) < 2 or '/' in x or re.search(r'\.\w{1,4}$', x): return False
    return bool(re.search(r'[a-z][A-Z]|[_\-]|\d', x) or (x.isupper() and len(x) > 1))
ids = lambda t: [w for w in TOK.findall(t) if is_id(w)]
stream = json.load(open(ROOT + 'stream.json'))
out = []; why = collections.Counter()
for m in stream:
    if m['selected']: continue
    if m['excluded'] not in ('long', 'path-like'): continue
    # cut at sentence punctuation, then pack greedily up to 160 chars
    parts = [p for p in re.split(r'(?<=[。！？；.!?;])\s*', m['text']) if p.strip()]
    segs, cur = [], ''
    for p in parts:
        if len(p) > 160:
            if cur: segs.append(cur); cur = ''
            for i in range(0, len(p), 160): segs.append(p[i:i + 160])
            continue
        if len(cur) + len(p) + 1 <= 160: cur = (cur + ' ' + p).strip()
        else: segs.append(cur); cur = p
    if cur: segs.append(cur)
    for k, seg in enumerate(segs):
        r = None
        if not ids(seg): r = 'no-identifier'
        elif '/' in seg or re.search(r'\w\.(ts|tsx|md|yml|json|sh|js|mjs)\b', seg): r = 'path-like'
        elif SECRET.search(seg): r = 'secret-like'
        why[r or 'kept'] += 1
        if r is None: out.append({'cid': f"{m['id']}.{k}", 'parent': m['id'], 'ts': m['ts'], 'proj': m['proj'], 'commit': m['commit'], 'text': seg, 'ids': ids(seg), 'conv': m['conv']})
json.dump(out, open(ROOT + 'stream-chunks.json', 'w'), ensure_ascii=False)
print(len(out), dict(why))
