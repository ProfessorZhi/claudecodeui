// Shared helpers for the replay: the identifier shape rule (a port of extract.py's is_id — keep them identical),
// token matching, and the character-level alignment that finds where a gold token went in the recognised text.
export const TOK = /[A-Za-z][A-Za-z0-9_./\-]*[A-Za-z0-9]|[A-Za-z]/g;
export function isId(x) {
  if (x.length < 2 || x.includes('/') || /\.\w{1,4}$/.test(x)) return false;
  return /[a-z][A-Z]|[_\-]|\d/.test(x) || (x === x.toUpperCase() && /[A-Z]/.test(x) && x.length > 1);
}
export const idsWithPos = (text) => [...text.matchAll(TOK)].filter((m) => isId(m[0])).map((m) => ({ tok: m[0], start: m.index, end: m.index + m[0].length }));
export const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const has = (text, term) => !!text && new RegExp(`(?<![A-Za-z0-9_-])${esc(term)}(?![A-Za-z0-9_]|-[A-Za-z])`).test(text.replace(/`/g, ''));
export function shapeType(tok) {
  if (/^(AC|GOAL|ADR|DIR|M)-?\d+/i.test(tok)) return 'ref';
  if (tok.startsWith('mcp__')) return 'tool';
  if (tok === tok.toUpperCase() && tok.length <= 6) return 'acronym';
  if (/[a-z][A-Z]/.test(tok)) return 'symbol';
  if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(tok)) return 'slug';
  if (tok.includes('_')) return 'env';
  if (tok.includes('-')) return 'term';
  return 'term';
}
/** Maps gold [gs,ge) onto the recognised text through a character-level alignment of the whitespace-stripped,
 *  lower-cased strings. Returns { start, end, text } in ORIGINAL coordinates of `asr`, or null when the gold part
 *  has no counterpart (deleted) — in which case nothing can be flagged there. */
export function alignRegion(gold, asr, gs, ge) {
  const strip = (s) => { const idx = []; let o = ''; for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { o += s[i].toLowerCase(); idx.push(i); } return { o, idx }; };
  const g = strip(gold), a = strip(asr);
  const n = g.o.length, m = a.o.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i; for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (g.o[i - 1] === a.o[j - 1] ? 0 : 1));
  // backtrace: gold stripped index -> asr stripped index (or -1 for deleted)
  const map = new Array(n).fill(-1); let i = n, j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (g.o[i - 1] === a.o[j - 1] ? 0 : 1)) { map[i - 1] = j - 1; i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) { map[i - 1] = -1; i--; } else j--;
  }
  const gsS = g.idx.findIndex((x) => x >= gs), geS = (() => { let k = -1; g.idx.forEach((x, t) => { if (x < ge) k = t; }); return k; })();
  if (gsS < 0 || geS < gsS) return null;
  const mapped = map.slice(gsS, geS + 1).filter((x) => x >= 0);
  // aligned span = from the first mapped char to the last mapped char, widened to the gaps up to the neighbours' images
  let lo, hi;
  if (mapped.length) { lo = Math.min(...mapped); hi = Math.max(...mapped); }
  else { const prev = gsS > 0 ? map.slice(0, gsS).reverse().find((x) => x >= 0) : -1; const next = map.slice(geS + 1).find((x) => x >= 0); lo = (prev ?? -1) + 1; hi = (next ?? m) - 1; if (hi < lo) return null; }
  // widen to include unmatched neighbours inside the gap between the previous and next matched gold chars
  const prevM = gsS > 0 ? (map.slice(0, gsS).reverse().find((x) => x >= 0) ?? -1) : -1;
  const nextM = map.slice(geS + 1).find((x) => x >= 0) ?? m;
  lo = Math.min(lo, prevM + 1); hi = Math.max(hi, nextM - 1);
  if (hi < lo) return null;
  const start = a.idx[lo], end = a.idx[hi] + 1;
  return { start, end, text: asr.slice(start, end) };
}
/** widen a region to whole Latin words so "Key" in "Keyfile" is judged as the word it sits in */
export function widenToWords(asr, r) {
  let { start, end } = r;
  while (start > 0 && /[A-Za-z0-9]/.test(asr[start - 1]) && /[A-Za-z0-9]/.test(asr[start])) start--;
  while (end < asr.length && /[A-Za-z0-9]/.test(asr[end]) && /[A-Za-z0-9]/.test(asr[end - 1])) end++;
  const PUNCT = /[\s，。、：；！？（）“”‘’,.;:!?()"'`]/;
  while (start < end && PUNCT.test(asr[start])) start++;
  while (end > start && PUNCT.test(asr[end - 1])) end--;
  return { start, end, text: asr.slice(start, end) };
}

/** key for a heard string: case-folded, whitespace / punctuation removed, but letters, digits AND CJK kept
 *  (normKey drops CJK, which made "AC 零零二" and "AC 零零五" the same key "ac"). */
export const heardKey = (s) => s.toLowerCase().replace(/[\s，。、：；！？（）“”‘’,.;:!?()"'`\-_]/g, '');
/** occurrences of `key` in `text` (whitespace-insensitive), with Latin boundaries; returns original-coordinate spans */
export function findHeard(text, key) {
  const idx = []; let q = ''; for (let i = 0; i < text.length; i++) if (!/[\s，。、：；！？（）“”‘’,.;:!?()"'`\-_]/.test(text[i])) { q += text[i].toLowerCase(); idx.push(i); }
  const out = []; let from = 0;
  for (;;) {
    const k = q.indexOf(key, from); if (k < 0) break; from = k + 1;
    const before = q[k - 1], after = q[k + key.length];
    if (/[a-z0-9]/.test(key[0]) && before && /[a-z0-9]/.test(before)) continue;
    if (/[a-z0-9]/.test(key[key.length - 1]) && after && /[a-z0-9]/.test(after)) continue;
    out.push({ start: idx[k], end: idx[k + key.length - 1] + 1 });
  }
  return out;
}
