// E-A 数据抽取：从本项目会话历史里找「摘录 + 回复」的人类输入，摘录是上一轮助手输出里的一段（标签）。
//   node experiments/voice-draft/ea/extract.mjs
// 原文只写到仓库外的 LOCAL_DIR；仓库里的 cases-index.json 只含会话前缀、序号与位置/长度，不含任何对话文本。
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const ROOT = join(homedir(), '.claude', 'projects', '-data-home-yale-work-claudecodeui');
const LOCAL_DIR = '/data/home/yale/work/tc-verify/corpus/voice-draft-ea';
const HUMAN = new Set(['typed|cli', 'sdk|sdk-cli', 'sdk|cli', 'suggestion_accepted|cli', 'queued|cli']);
const MACHINE = /^(You are |This session is being continued|<|\[Request interrupted|Caveat:|Another Claude session)/;
const WINDOW = 8000;           // 上下文：上一轮助手输出的末尾 8000 字
const MIN_EXCERPT = 20;        // 摘录至少 20 个非空白字符
const MIN_REPLY = 4;           // 回复至少 4 个非空白字符
const N = 12;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const keep = (ch) => /[\p{L}\p{N}]/u.test(ch);
/** 只保留字母数字，并记录每个保留字符在原文里的位置。 */
function squash(s) { let out = ''; const idx = []; for (let i = 0; i < s.length; i++) if (keep(s[i])) { out += s[i].toLowerCase(); idx.push(i); } return { out, idx }; }
function coverage(seg, prevSq) { const t = squash(seg).out; if (t.length < N) return 0; let hit = 0; const set = new Set(); for (let i = 0; i + N <= prevSq.length; i++) set.add(prevSq.slice(i, i + N)); const mark = new Array(t.length).fill(false); for (let i = 0; i + N <= t.length; i++) if (set.has(t.slice(i, i + N))) for (let k = i; k < i + N; k++) mark[k] = true; hit = mark.filter(Boolean).length; return hit / t.length; }
const cases = []; const stats = { humanWithPrev: 0, candidates: 0, noSingleExcerpt: 0, shortReply: 0, notLocated: 0, outsideWindow: 0, kept: 0 };
for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.jsonl'))) {
  const p = join(ROOT, f); if (!statSync(p).isFile()) continue; let last = ''; let turn = 0;
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; } if (e.isSidechain) continue;
    const t = textOf(e.message?.content);
    if (e.type === 'assistant') { if (t) last += (last ? '\n\n' : '') + t; continue; }
    if (e.type !== 'user' || e.isMeta || !t) continue;
    const human = HUMAN.has(`${e.promptSource ?? ''}|${e.entrypoint ?? ''}`) && !MACHINE.test(t.trimStart());
    turn++;
    if (human && last) {
      stats.humanWithPrev++;
      const prev = last.length > WINDOW ? last.slice(-WINDOW) : last; const prevSq = squash(prev);
      const parts = t.split(/\n\s*(?:---+|___+|\*\*\*+)\s*\n/).map((x) => x.trim()).filter(Boolean);
      const segs = parts.length > 1 ? parts : t.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
      const info = segs.map((s) => ({ s, sq: squash(s).out.length, cov: coverage(s, prevSq.out) }));
      const ex = info.filter((x) => x.sq >= MIN_EXCERPT && x.cov >= 0.8); const rest = info.filter((x) => !(x.sq >= MIN_EXCERPT && x.cov >= 0.8));
      if (ex.length === 0) { last = ''; continue; }
      stats.candidates++;
      if (ex.length !== 1 || rest.some((x) => x.cov >= 0.5 && x.sq >= 20)) { stats.noSingleExcerpt++; last = ''; continue; }
      const reply = rest.map((x) => x.s).join('\n').trim(); if (squash(reply).out.length < MIN_REPLY) { stats.shortReply++; last = ''; continue; }
      // 定位摘录在 prev 里的字符区间：用摘录的 12-gram 在 prev 里顺序链式匹配，取首末命中位置
      const q = squash(ex[0].s).out; let pos = -1, first = -1, lastHit = -1, matched = 0;
      for (let i = 0; i + N <= q.length; i++) { const g = q.slice(i, i + N); const from = pos < 0 ? 0 : Math.max(0, pos - 4); const at = prevSq.out.indexOf(g, from); if (at >= 0 && (pos < 0 || at - pos < 400)) { pos = at; if (first < 0) first = at; lastHit = at + N; matched++; } }
      if (first < 0 || matched < 0.6 * Math.max(1, q.length - N + 1) || lastHit - first < 0.6 * q.length || lastHit - first > 1.4 * q.length + 30) { stats.notLocated++; last = ''; continue; }
      const start = prevSq.idx[first], end = prevSq.idx[Math.min(lastHit - 1, prevSq.idx.length - 1)] + 1;
      cases.push({ id: `${f.slice(0, 8)}-${turn}`, session: f.slice(0, 8), ts: e.timestamp, prev, label: { start, end }, excerpt: prev.slice(start, end), reply, quotedBefore: t.indexOf(ex[0].s) < t.indexOf(reply.slice(0, 10)) });
      stats.kept++;
    }
    last = '';
  }
}
mkdirSync(LOCAL_DIR, { recursive: true });
writeFileSync(join(LOCAL_DIR, 'cases.json'), JSON.stringify(cases, null, 1));
const index = cases.map((c) => ({ id: c.id, ts: c.ts.slice(0, 16), prevChars: c.prev.length, label: c.label, excerptChars: c.excerpt.length, replyChars: c.reply.length, quotedBefore: c.quotedBefore }));
writeFileSync(new URL('./cases-index.json', import.meta.url), JSON.stringify({ rule: { WINDOW, MIN_EXCERPT, MIN_REPLY, coverage: '≥0.8 of the segment is verbatim from the previous assistant output (12-gram, alnum-squashed)', single_excerpt: true }, stats, cases: index }, null, 1));
console.log(JSON.stringify(stats));
const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log('excerpt chars median', med(cases.map((c) => c.excerpt.length)), 'reply chars median', med(cases.map((c) => c.reply.length)), 'prev chars median', med(cases.map((c) => c.prev.length)));
console.log('excerpt before reply:', cases.filter((c) => c.quotedBefore).length, '/', cases.length, '; distinct sessions', new Set(cases.map((c) => c.session)).size);
