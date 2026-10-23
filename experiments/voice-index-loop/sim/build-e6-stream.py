#!/usr/bin/env python3
"""E6 stream: the v3 stream with each long / path-like parent replaced by its kept chunks (selected), and the v3-selected
messages demoted to ordinary history (selected = false), so the replay measures only the new population while U / C / P
see exactly what they saw before. A chunk's parent is not observed as sent BEFORE its chunk (that would leak)."""
import json, collections
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
stream = json.load(open(ROOT + 'stream.json')); chunks = json.load(open(ROOT + 'stream-chunks.json'))
asr = {}
for l in open(ROOT + 'asr-chunks.jsonl'):
    r = json.loads(l)
    if r.get('asr') is not None: asr[r['id']] = r['asr']
by = collections.defaultdict(list)
for c in chunks:
    if c['cid'] in asr: by[c['parent']].append(c)
out = []
for m in stream:
    if m['id'] in by:
        for c in by[m['id']]:
            out.append({'id': c['cid'], 'ts': c['ts'], 'proj': c['proj'], 'sid': m['sid'], 'text': c['text'], 'ids': c['ids'], 'conv': c['conv'], 'commit': c['commit'], 'selected': True, 'excluded': None})
    else:
        m = dict(m); m['selected'] = False; out.append(m)
json.dump(out, open(ROOT + 'stream-e6.json', 'w'), ensure_ascii=False)
print('chunks with asr', len(asr), 'stream items', len(out), 'selected', sum(1 for x in out if x['selected']))
