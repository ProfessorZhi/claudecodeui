import { TERMS, TEMPLATES, goldText, TRAPS, NEUTRAL, MULTI } from './cases.mjs';
// One entry per audio clip. `kind`: target | trap | neutral | multi. `pron`: K (/kiː/), W (/kweɪ/), N (no variant).
export function allClips() {
  const out = [];
  for (const t of TERMS) for (const tpl of TEMPLATES) for (const [pron, say] of Object.entries(t.say)) {
    out.push({ id: `t-${t.id}-${tpl.id}-${pron}`, kind: 'target', cls: t.cls, term: t.id, targets: [t.gold], pron, voice: tpl.voice,
      spoken: tpl.text(say), gold: goldText(tpl, t) });
  }
  for (const x of TRAPS) out.push({ id: x.id, kind: 'trap', targets: ['quay'], pron: 'N', voice: x.voice, spoken: x.spoken, gold: x.gold, keep: x.keep });
  for (const x of NEUTRAL) out.push({ id: x.id, kind: 'neutral', targets: ['quay'], pron: 'N', voice: x.voice, spoken: x.spoken, gold: x.gold });
  for (const m of MULTI) for (const pron of ['K', 'W']) {
    const v = m.id === 'mu1' ? (pron === 'K' ? 'key fleet' : 'kway fleet') : (pron === 'K' ? 'key' : 'kway');
    out.push({ id: `${m.id}-${pron}`, kind: 'multi', targets: m.targets, pron, voice: m.voice, spoken: m.spoken(v), gold: m.gold });
  }
  return out;
}
if (process.argv[1]?.endsWith('clips.mjs')) { const c = allClips(); console.log(c.length, JSON.stringify(c.slice(0, 3), null, 1)); }
