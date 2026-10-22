// A1 — base rate, computed LOCALLY over ~/.claude/projects transcripts. Writes AGGREGATE counts only;
// no conversation text leaves this machine or enters the repo. Usage:
//   node experiments/voice-omni-written/a1/a1-base-rate.mjs [--root ~/.claude/projects] [--write] [--examples]
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : join(homedir(), '.claude', 'projects');
const CAP = 8000;

// ── which user turns are a human typing ────────────────────────────────────────────────────
const HUMAN_SOURCES = new Set(['typed|cli', 'sdk|sdk-cli', 'sdk|cli', 'suggestion_accepted|cli', 'queued|cli']);
const MACHINE_PREFIX = /^(You are |This session is being continued|<|\[Request interrupted|Caveat:)/;
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
}
const strip = (t) => t.replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');

// ── identifiers ────────────────────────────────────────────────────────────────────────────
const EXT = 'ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|sh|yml|yaml|toml|css|html|sql|txt|jsonl';
const RE = {
  file: new RegExp(String.raw`(?<![\w./-])[A-Za-z_][\w-]*(?:\.[\w-]+)*\.(?:${EXT})(?![\w])`, 'g'),
  camel: /(?<![\w.-])(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?![\w-])/g,
  kebab: /(?<![\w.-])[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}(?![\w.])/g,
};
function idsOf(text) {
  const out = new Map();
  for (const [cls, re] of Object.entries(RE)) for (const m of text.matchAll(re)) if (!out.has(m[0])) out.set(m[0], cls);
  return out; // name -> class
}
const lower = (s) => s.toLowerCase();
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
const firstSeg = (s) => lower(s).split(/[./_-]|(?=[A-Z])/)[0];
const extOf = (s) => (s.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() ?? '';
function confusable(target, cls, other, otherCls) {
  if (lower(other) === lower(target) || otherCls !== cls) return false;
  const a = lower(target), b = lower(other);
  if (a.includes(b) || b.includes(a)) return false; // stem vs basename of the same name is not a competitor
  if (cls === 'file' && extOf(target) === extOf(other) && firstSeg(target) === firstSeg(other)) return true;
  if (cls !== 'file' && firstSeg(target) === firstSeg(other) && firstSeg(target).length >= 3) return true;
  return lev(a, b) / Math.max(a.length, b.length) <= 0.4;
}
const has = (ctx, name) => new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i').test(ctx);

// ── walk sessions ──────────────────────────────────────────────────────────────────────────
const WINDOWS = ['turn1', 'turn3'];
const zero = () => ({ targetOnly: 0, targetAndCompetitor: 0, competitorOnly: 0, neither: 0 });
const agg = { sessions: 0, humanPrompts: 0, promptsWithIds: 0, promptsWithIdsAndPriorTurn: 0, targets: 0, byWindow: {}, byClass: {}, bySurface: {} };
for (const w of WINDOWS) agg.byWindow[w] = zero();
const examples = [];
for (const dir of readdirSync(ROOT)) {
  const d = join(ROOT, dir); if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.jsonl'))) {
    let lines; try { lines = readFileSync(join(d, f), 'utf8').split('\n'); } catch { continue; }
    const turns = []; let current = null; let sawHuman = false;
    for (const l of lines) {
      if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.isSidechain) continue;
      if (e.type === 'assistant') { const t = textOf(e.message?.content); if (t && current) current.assistant.push(t); continue; }
      if (e.type !== 'user' || e.isMeta) continue;
      const t = textOf(e.message?.content); if (!t) continue; // tool_result-only turns have no text
      const src = `${e.promptSource ?? ''}|${e.entrypoint ?? ''}`;
      if (!HUMAN_SOURCES.has(src) || MACHINE_PREFIX.test(t.trimStart()) || t.length > 3000) { current = { human: false, assistant: [] }; turns.push(current); continue; }
      sawHuman = true; agg.humanPrompts++;
      const prior = turns.filter((x) => x.assistant.length);
      const ctxOf = (n) => prior.slice(-n).map((x) => x.assistant.join('\n')).join('\n').slice(-CAP);
      const ids = idsOf(strip(t));
      if (ids.size) {
        agg.promptsWithIds++;
        if (prior.length) {
          agg.promptsWithIdsAndPriorTurn++;
          const surface = e.entrypoint === 'sdk-cli' ? 'cloudcli-ui' : 'terminal';
          for (const [name, cls] of ids) {
            agg.targets++;
            for (const w of WINDOWS) {
              const ctx = ctxOf(w === 'turn1' ? 1 : 3);
              const ctxIds = idsOf(ctx);
              const tgt = has(ctx, name);
              const comp = [...ctxIds].filter(([o, oc]) => confusable(name, cls, o, oc)).map(([o]) => o);
              const key = tgt && !comp.length ? 'targetOnly' : tgt ? 'targetAndCompetitor' : comp.length ? 'competitorOnly' : 'neither';
              agg.byWindow[w][key]++;
              ((agg.byClass[`${w}:${cls}`] ??= zero()))[key]++;
              ((agg.bySurface[`${w}:${surface}`] ??= zero()))[key]++;
              if (w === 'turn1' && key !== 'neither' && examples.length < 40) examples.push(`${key.padEnd(20)} ${name}  vs  ${comp.slice(0, 3).join(', ')}`);
            }
          }
        }
      }
      current = { human: true, assistant: [] }; turns.push(current);
    }
    if (sawHuman) agg.sessions++;
  }
}
const pct = (o) => { const n = Object.values(o).reduce((a, b) => a + b, 0); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, `${v} (${n ? ((100 * v) / n).toFixed(1) : 0}%)`])); };
console.log(JSON.stringify({ ...agg, byWindow: Object.fromEntries(Object.entries(agg.byWindow).map(([k, v]) => [k, pct(v)])), byClass: Object.fromEntries(Object.entries(agg.byClass).map(([k, v]) => [k, pct(v)])), bySurface: Object.fromEntries(Object.entries(agg.bySurface).map(([k, v]) => [k, pct(v)])) }, null, 1));
if (argv.includes('--examples')) console.error(examples.join('\n'));
if (argv.includes('--write')) writeFileSync(new URL('./summary.json', import.meta.url), JSON.stringify({ computedAt: new Date().toISOString(), cap: CAP, windows: { turn1: 'assistant text of the last turn before the prompt', turn3: 'last three turns' }, note: 'aggregate counts only; no transcript text', ...agg }, null, 1) + '\n');
