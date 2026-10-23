// E-A 共用：本地数据目录、案例读取、定位与区间指标。原文只在仓库外。
import { readFileSync } from 'node:fs';
export const LOCAL = '/data/home/yale/work/tc-verify/corpus/voice-draft-ea';
export type Case = { id: string; session: string; ts: string; prev: string; label: { start: number; end: number }; excerpt: string; reply: string };
export const cases = (): Case[] => JSON.parse(readFileSync(`${LOCAL}/cases.json`, 'utf8'));
export const N = 12;
const keep = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
export function squash(s: string) { let out = ''; const idx: number[] = []; for (let i = 0; i < s.length; i++) if (keep(s[i])) { out += s[i].toLowerCase(); idx.push(i); } return { out, idx }; }
/** 在 prev 里定位一段文字（链式 12-gram）。找不到返回 null。 */
export function locate(prev: string, text: string): { start: number; end: number } | null {
  const P = squash(prev), q = squash(text).out; if (q.length < 6) { const at = P.out.indexOf(q); return at < 0 || q.length === 0 ? null : { start: P.idx[at], end: P.idx[at + q.length - 1] + 1 }; }
  const n = Math.min(N, q.length); let pos = -1, first = -1, lastHit = -1, matched = 0;
  for (let i = 0; i + n <= q.length; i++) { const g = q.slice(i, i + n); const from = pos < 0 ? 0 : Math.max(0, pos - 4); const at = P.out.indexOf(g, from); if (at >= 0 && (pos < 0 || at - pos < 400)) { pos = at; if (first < 0) first = at; lastHit = at + n; matched++; } }
  if (first < 0 || matched < 0.9 * Math.max(1, q.length - n + 1)) return null;
  return { start: P.idx[first], end: P.idx[Math.min(lastHit - 1, P.idx.length - 1)] + 1 };
}
export function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); const la = a.end - a.start, lb = b.end - b.start; const uni = la + lb - inter;
  const p = la ? inter / la : 0, r = lb ? inter / lb : 0; return { iou: uni ? inter / uni : 0, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}
/** 把 prev 切成行单元，记录每行在 prev 里的区间。 */
export function units(prev: string) { const out: { id: number; text: string; start: number; end: number }[] = []; let off = 0; let id = 0; for (const line of prev.split('\n')) { const start = off; off += line.length + 1; if (line.trim()) out.push({ id: ++id, text: line, start, end: start + line.length }); } return out; }
