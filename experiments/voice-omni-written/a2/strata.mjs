// A2 shared pieces: per-clip targets, the A1 competitor rule, the leak check, and a pool builder that reads
// local transcripts. The pool itself is NOT written to the repo — only the chosen contexts are frozen later.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** What each clip's speaker names. Reference-derived and fixed before any context is chosen. */
export const TARGETS = {
  'd01-o65.wav': ['voice.service.ts'], 'd02-o65.wav': ['voice.routes.ts'], 'd03-o65.wav': ['useVoiceInput'],
  'd04-o65.wav': ['voice.module.ts', 'voice.service.ts'], 'n01-o65': ['ChatComposer.tsx'], 'n02-o65': ['resend'], 'n04-o65': ['useVoiceInput'],
};
const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|sh|yml|yaml|toml|css|html|sql|txt|jsonl';
const RE = { file: new RegExp(String.raw`(?<![\w./-])[A-Za-z_][\w-]*(?:\.[\w-]+)*\.(?:${EXT})(?![\w])`, 'g'), camel: /(?<![\w.-])(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?![\w-])/g, word: /(?<![\w.-])[a-z]{4,}(?![\w.-])/g };
export function idsOf(text, classes = ['file', 'camel']) { const out = new Map(); for (const c of classes) for (const m of text.matchAll(RE[c])) if (!out.has(m[0])) out.set(m[0], c); return out; }
const low = (s) => s.toLowerCase();
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
const firstSeg = (s) => low(s).split(/[./_-]|(?=[A-Z])/)[0];
const extOf = (s) => (s.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() ?? '';
const clsOf = (s) => (/\.[a-z0-9]+$/i.test(s) ? 'file' : /[A-Z]/.test(s) ? 'camel' : 'word');
/** A1's rule, unchanged: same class, not the same name or a stem of it, and (same ext + same first segment | same first segment | normalized edit distance <= 0.4). */
export function confusable(target, other) {
  const cls = clsOf(target), oc = clsOf(other); const a = low(target), b = low(other);
  if (a === b || oc !== cls || a.includes(b) || b.includes(a)) return false;
  if (cls === 'file' && extOf(target) === extOf(other) && firstSeg(target) === firstSeg(other)) return true;
  if (cls !== 'file' && firstSeg(target) === firstSeg(other) && firstSeg(target).length >= 3) return true;
  return lev(a, b) / Math.max(a.length, b.length) <= 0.4;
}
export const has = (ctx, name) => new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(ctx);
/** Stratum of a (context, clip) pair; null for clips that name no identifier. */
export function stratumOf(ctx, clip) {
  const targets = TARGETS[clip]; if (!targets) return null;
  const ids = [...idsOf(ctx, ['file', 'camel', 'word']).keys()];
  const tgt = targets.some((t) => has(ctx, t));
  const comp = [...new Set(ids.filter((o) => targets.some((t) => confusable(t, o))))];
  return { stratum: tgt && !comp.length ? 'targetOnly' : tgt ? 'targetAndCompetitor' : comp.length ? 'competitorOnly' : 'neither', competitors: comp };
}
const norm = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}…]/gu, '');
/** A context leaks when it shares a 12-char normalized window with a reference AFTER the reference's identifiers are removed:
 * naming `voice.service.ts` is the very thing under test, quoting the sentence around it is the leak. Returns the window or null. */
export function leaks(ctx, refs) {
  const c = norm(ctx);
  for (const r of refs) {
    const stripped = r.replace(/[A-Za-z_][\w.-]*/g, ' ');
    for (const part of stripped.split(/\s+/)) { const n = norm(part); for (let i = 0; i + 12 <= n.length; i++) if (c.includes(n.slice(i, i + 12))) return n.slice(i, i + 12); }
  }
  return null;
}

/** Assistant-turn texts from human sessions of one project, tail-capped. */
export function buildPool(projectDir = join(homedir(), '.claude', 'projects', '-data-home-yale-work-claudecodeui'), { min = 1500, cap = 8000 } = {}) {
  const HUMAN = new Set(['typed|cli', 'sdk|sdk-cli', 'sdk|cli', 'suggestion_accepted|cli', 'queued|cli']);
  const pool = [];
  for (const f of readdirSync(projectDir).filter((x) => x.endsWith('.jsonl'))) {
    const p = join(projectDir, f); if (!statSync(p).isFile()) continue;
    let cur = null; let idx = 0;
    const flush = () => { if (cur && cur.human && cur.text.length >= min) pool.push({ session: f.slice(0, 8), turn: cur.idx, text: cur.text.slice(-cap) }); };
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; } if (e.isSidechain) continue;
      const c = e.message?.content; const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
      if (e.type === 'assistant') { if (t && cur) cur.text += (cur.text ? '\n' : '') + t; continue; }
      if (e.type !== 'user' || e.isMeta || !t) continue;
      flush(); const human = HUMAN.has(`${e.promptSource ?? ''}|${e.entrypoint ?? ''}`) && !/^(You are |This session|<|\[Request)/.test(t.trimStart());
      cur = { human, text: '', idx: idx++ };
    }
    flush();
  }
  return pool;
}
