#!/usr/bin/env python3
"""Project snapshots as they were at each message's time: file / task / goal / adr names from the git tree, scripts and
dependencies from package.json. Output: snap.json = { proj: { commit: { name: type } } } and stream.json gains `commit`."""
import json, os, re, subprocess, collections
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
REPO = {p: f'/data/home/yale/work/{p}' for p in ('claudecodeui', 'quay', 'quay-fleet', 'cantus')}
stream = json.load(open(ROOT + 'stream.json'))
def git(repo, *a):
    return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True).stdout
cache = {}
def snapshot(repo, commit):
    names = {}
    for path in git(repo, 'ls-tree', '-r', '--name-only', commit).split('\n'):
        if not path: continue
        b = os.path.basename(path); stem = re.sub(r'\.[A-Za-z0-9]+$', '', b)
        top = path.split('/')[0]
        typ = {'tasks': 'task', 'goals': 'goal', 'adr': 'adr'}.get(top, 'file') if '/' in path else 'file'
        for n in {b, stem}:
            if n and n not in names: names[n] = typ
    try:
        pj = json.loads(git(repo, 'show', f'{commit}:package.json'))
        for k in pj.get('scripts', {}): names.setdefault(k, 'command')
        for k in list(pj.get('dependencies', {})) + list(pj.get('devDependencies', {})): names.setdefault(k, 'dep')
    except Exception: pass
    return names
snap = collections.defaultdict(dict); miss = collections.Counter()
for s in stream:
    repo = REPO[s['proj']]
    day = (s['ts'] or '')[:10]
    key = (s['proj'], day)
    if key not in cache:
        c = git(repo, 'rev-list', '-1', f'--before={s["ts"]}', '--all').strip()
        if not c:
            c = git(repo, 'rev-list', '--max-parents=0', 'HEAD').strip().split('\n')[-1]; miss[s['proj']] += 1
        cache[key] = c
    s['commit'] = cache[key]
    if cache[key] not in snap[s['proj']]: snap[s['proj']][cache[key]] = snapshot(repo, cache[key])
json.dump(snap, open(ROOT + 'snap.json', 'w'))
json.dump(stream, open(ROOT + 'stream.json', 'w'), ensure_ascii=False)
print({p: len(v) for p, v in snap.items()}, 'fell back to earliest commit:', dict(miss))
print({p: sorted({len(x) for x in v.values()})[len(v)//2] for p, v in snap.items()}, 'median names per snapshot')
