#!/usr/bin/env python3
"""Builds the replay stream from the user's own session transcripts (nothing here leaves the machine).

Output (outside the repo): stream.json — every human-written input in time order, with the identifier-shaped
tokens it contains, the conversation vocabulary available BEFORE it (last 8 assistant turns of the same session),
and the selection / exclusion decision. The shape rule below is the single source of truth for 'identifier-like'.
"""
import json, glob, os, re, sys, collections
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
BASE = os.path.expanduser('~/.claude/projects')
PROJ = {'claudecodeui': '-data-home-yale-work-claudecodeui', 'quay': '-data-home-yale-work-quay',
        'cantus': '-data-home-yale-work-cantus', 'quay-fleet': '-data-home-yale-work-quay-fleet'}
AUTO = re.compile(r'^(You are |WORKSPACE:|This session is being continued|<task-notification|<command-|<local-command|\[Request interrupted|<system-reminder|Caveat:|<bash-|<user-prompt|Base directory)')
SECRET = re.compile(r'passwd|password|passphrase|token\b|secret|sk-[A-Za-z0-9]|Bearer |密码|口令|api[ _-]?key\s*[:=：]|authorized_keys', re.I)
TOK = re.compile(r"[A-Za-z][A-Za-z0-9_./\-]*[A-Za-z0-9]|[A-Za-z]")

def clean(t):
    t = re.sub(r'<pasted_content[^>]*>.*?</pasted_content[^>]*>', ' ', t, flags=re.S)
    t = re.sub(r'```.*?```', ' ', t, flags=re.S)
    t = re.sub(r'https?://\S+', ' ', t)
    t = re.sub(r'\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b', ' ', t)
    t = re.sub(r'\b[0-9a-f]{7,40}\b', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def is_id(x):
    """identifier-like: camel/Pascal boundary, '_' or '-', a digit, or an all-caps run of >= 2; never a path or file name"""
    if len(x) < 2 or '/' in x or re.search(r'\.\w{1,4}$', x): return False
    return bool(re.search(r'[a-z][A-Z]|[_\-]|\d', x) or (x.isupper() and len(x) > 1))

def ids(text): return [w for w in TOK.findall(text) if is_id(w)]

def ctx_tokens(text):
    return {w for w in TOK.findall(text) if is_id(w) or (len(w) > 1 and re.search(r'\.\w{1,4}$', w))}

def base_stem(p):
    b = os.path.basename(p); return {b, re.sub(r'\.[A-Za-z0-9]+$', '', b)}

stream = []
for proj, d in PROJ.items():
    for f in glob.glob(f'{BASE}/{d}/*.jsonl'):
        sid = os.path.basename(f)[:8]
        turns = collections.deque(maxlen=8)   # each: set of tokens from one assistant turn
        cur = None
        for line in open(f, errors='ignore'):
            try: o = json.loads(line)
            except Exception: continue
            tp = o.get('type')
            if tp not in ('user', 'assistant'): continue
            m = o.get('message', {}); c = m.get('content')
            if tp == 'assistant':
                if o.get('isSidechain'): continue
                if cur is None: cur = set(); turns.append(cur)
                if isinstance(c, list):
                    for b in c:
                        if b.get('type') == 'text': cur |= ctx_tokens(b.get('text', ''))
                        elif b.get('type') == 'tool_use':
                            cur.add(b.get('name', ''))
                            inp = json.dumps(b.get('input', {}), ensure_ascii=False)[:3000]
                            cur |= ctx_tokens(inp)
                            for k in ('file_path', 'path', 'notebook_path'):
                                v = b.get('input', {}).get(k)
                                if isinstance(v, str): cur |= base_stem(v)
                continue
            # user record
            if isinstance(c, list):
                if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                    cur = cur  # tool results belong to the running assistant turn
                    for b in c:
                        if isinstance(b, dict) and b.get('type') == 'tool_result' and cur is not None:
                            cc = b.get('content')
                            if isinstance(cc, list): cc = ''.join(z.get('text', '') for z in cc if isinstance(z, dict))
                            if isinstance(cc, str): cur |= ctx_tokens(cc[:2000])
                    continue
                c = ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
            if not isinstance(c, str) or not c.strip() or o.get('isMeta') or o.get('isSidechain'): continue
            if AUTO.match(c.lstrip()) or len(c) > 3000: continue
            text = clean(c)
            if not text: continue
            # conversation vocabulary available before this message: tokens with their turn distance (1 = latest)
            conv = {}
            for dist, tset in enumerate(reversed(turns), start=1):
                for t in tset:
                    if t and t not in conv: conv[t] = dist
            stream.append({'ts': o.get('timestamp'), 'proj': proj, 'sid': sid, 'text': text, 'ids': ids(text), 'conv': conv})
            cur = None
stream.sort(key=lambda x: x['ts'] or '')
for i, s in enumerate(stream): s['id'] = i
sel = 0; why = collections.Counter()
for s in stream:
    t = s['text']; r = None
    if len(t) > 160: r = 'long'
    elif not s['ids']: r = 'no-identifier'
    elif '/' in t or re.search(r'\w\.(ts|tsx|md|yml|json|sh|js|mjs)\b', t): r = 'path-like'
    elif SECRET.search(t): r = 'secret-like'
    s['selected'] = r is None; s['excluded'] = r
    why[r or 'selected'] += 1
json.dump(stream, open(ROOT + 'stream.json', 'w'), ensure_ascii=False)
print(len(stream), dict(why))
print('conv vocab size median', sorted(len(s['conv']) for s in stream)[len(stream) // 2])
