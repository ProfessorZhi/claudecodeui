// Deterministic spoken-form templates (exploratory variant X3, NOT part of the pre-registered arms).
// Two shapes the first run showed no similarity score can reach: spoken symbol words ("下划线" = "_") and numbered
// references ("AC 零零二" = "AC-002", "Go零零幺" = "GOAL-001"). Prefixes are taken from reference-shaped entities the
// index already knows — nothing is hard-coded.
const DIG = { 零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM = '[零〇一二三四五六七八九幺]';
export function knownPrefixes(entities) {
  const out = new Set(); for (const e of entities.values()) { const m = /^([A-Z]{1,6})-\d+$/.exec(e.term); if (m) out.add(m[1]); } return [...out];
}
export function applyTemplates(text, prefixes) {
  let out = text.replace(/\s*(?:下划线|底线)\s*/g, '_').replace(/\s*(?:横杠|短横线)\s*/g, '-');
  const re = new RegExp(`((?:[A-Za-z]\\s?){1,6}?)\\s?(${NUM}{2,4}|\\d{2,4})`, 'g');
  out = out.replace(re, (all, letters, num) => {
    const L = letters.replace(/\s/g, '').toUpperCase();
    const known = prefixes.find((p) => p === L) ?? (L.length >= 2 ? (prefixes.filter((p) => p.startsWith(L)).length === 1 ? prefixes.find((p) => p.startsWith(L)) : null) : null);
    if (!known) return all;
    const digits = [...num].map((c) => (c in DIG ? String(DIG[c]) : c)).join('');
    return `${known}-${digits.padStart(3, '0')}`;
  });
  return out;
}
