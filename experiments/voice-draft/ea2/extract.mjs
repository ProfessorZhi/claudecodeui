// E-A2 数据抽取。  node experiments/voice-draft/ea2/extract.mjs
// 原文只写到仓库外 LOCAL_DIR；仓库里的 cases-index.json 只含会话前缀、时间与长度。
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const ROOT = join(homedir(), '.claude', 'projects', '-data-home-yale-work-claudecodeui');
const LOCAL_DIR = '/data/home/yale/work/tc-verify/corpus/voice-draft-ea2';
const HUMAN = new Set(['typed|cli', 'sdk|sdk-cli', 'sdk|cli', 'suggestion_accepted|cli', 'queued|cli']);
const MACHINE = /^(You are |This session is being continued|<|\[Request interrupted|Caveat:|Another Claude session)/;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const TERM = /[A-Za-z][A-Za-z0-9_.\-]{2,}|\d+(?:\.\d+)?/g;
const WINDOW = 8000, PER_SESSION = 3, TAKE = 60, SEED = 20261007;
const cand = [];
for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.jsonl'))) {
  const p = join(ROOT, f); if (!statSync(p).isFile()) continue; let last = ''; let turn = 0;
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; } if (e.isSidechain) continue;
    const t = textOf(e.message?.content);
    if (e.type === 'assistant') { if (t) last += (last ? '\n\n' : '') + t; continue; }
    if (e.type !== 'user' || e.isMeta || !t) continue; turn++;
    if (HUMAN.has(`${e.promptSource ?? ''}|${e.entrypoint ?? ''}`) && !MACHINE.test(t.trimStart()) && last) {
      const own = t.replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, ' ').replace(/<pasted_content[\s\S]*$/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ').replace(/<\/?[A-Za-z][^>\n]*>/g, ' ').replace(/`/g, '').trim(); const prev = last.slice(-WINDOW);
      if (own.length >= 8 && own.length <= 200) { const terms = [...new Set(own.match(TERM) ?? [])].filter((x) => x.length >= 3 || /\d/.test(x)); const lo = prev.toLowerCase(); const inPrev = terms.filter((x) => lo.includes(x.toLowerCase()) && !/^\d$/.test(x));
        if (inPrev.length) cand.push({ id: `${f.slice(0, 8)}-${turn}`, session: f.slice(0, 8), ts: e.timestamp, prev, reply: own, terms, inPrev }); } }
    last = ''; } }
let s = SEED; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
const per = {}; const picked = []; for (const c of cand) { if ((per[c.session] ?? 0) >= PER_SESSION) continue; per[c.session] = (per[c.session] ?? 0) + 1; picked.push(c); if (picked.length === TAKE) break; }
mkdirSync(LOCAL_DIR, { recursive: true }); writeFileSync(join(LOCAL_DIR, 'cases.json'), JSON.stringify(picked, null, 1));
writeFileSync(new URL('./cases-index.json', import.meta.url), JSON.stringify({ rule: { WINDOW, PER_SESSION, TAKE, SEED }, candidates: cand.length, cases: picked.map((c) => ({ id: c.id, ts: c.ts.slice(0, 16), prevChars: c.prev.length, replyChars: c.reply.length, terms: c.terms.length, termsInPrev: c.inPrev.length })) }, null, 1));
const sum = (xs) => xs.reduce((a, b) => a + b, 0); console.log('候选', cand.length, '入选', picked.length, '会话', new Set(picked.map((c) => c.session)).size, '术语', sum(picked.map((c) => c.terms.length)), '其中在上一轮里', sum(picked.map((c) => c.inPrev.length)));
