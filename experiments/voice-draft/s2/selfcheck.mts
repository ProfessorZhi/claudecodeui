// 判据自检（PREREG 的负控制）：npx tsx experiments/voice-draft/s2/selfcheck.mts
// goodDraft 必须召回 100% 且泄漏 0；badDraft 必须召回 0 且泄漏 100%。任一不满足则谓词作废。
import { SCRIPTS, normalize } from './scripts.mts';

export function score(script: (typeof SCRIPTS)[number], draft: string) {
  const t = normalize(draft);
  const got = script.items.filter((i) => i.ok(t));
  const leaked = script.forbidden.filter((f) => f.hit(t));
  return { got: got.map((i) => i.id), missed: script.items.filter((i) => !i.ok(t)).map((i) => i.id), leaked: leaked.map((f) => f.id) };
}

if (process.argv[1]?.endsWith('selfcheck.mts')) {
  let bad = 0;
  for (const s of SCRIPTS) {
    const g = score(s, s.goodDraft);
    const b = score(s, s.badDraft);
    const goodOk = g.missed.length === 0 && g.leaked.length === 0;
    const badOk = b.got.length === 0 && b.leaked.length === s.forbidden.length;
    console.log(`${s.id} good: recall ${g.got.length}/${s.items.length} leak ${g.leaked.length}/${s.forbidden.length} ${goodOk ? 'OK' : `FAIL missed=${g.missed} leaked=${g.leaked}`}`);
    console.log(`${s.id} bad : recall ${b.got.length}/${s.items.length} leak ${b.leaked.length}/${s.forbidden.length} ${badOk ? 'OK' : `FAIL got=${b.got} leaked=${b.leaked}`}`);
    if (!goodOk || !badOk) bad++;
  }
  console.log(bad ? `SELFCHECK-FAIL (${bad} scripts)` : 'SELFCHECK-OK');
  process.exit(bad ? 1 : 0);
}
