// E-C3 代码流水线：校验跨度、类型覆盖、自问自答合并、术语校正（护栏 v2）、引用、模板渲染。不调用模型。
import { lev, low } from '../ea2/common.mts';
export type Raw = { items?: any[]; replacements?: any[]; anchors?: any[] };
export type Item = { id: number; unit: number; type: string; span: string; answers: number | null; overridden?: boolean; answeredBy?: number; repaired?: { from: string; to: string }[] };
export const TYPES = ['事实', '问题', '探路', '假设', '决定', '约束'];
const keep = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
export function squash(s: string) { let out = ''; const idx: number[] = []; for (let i = 0; i < s.length; i++) if (keep(s[i])) { out += s[i].toLowerCase(); idx.push(i); } return { out, idx }; }
/** span 是否是 transcript 的（忽略空白与标点的）子串；是则返回 transcript 里的原文片段。 */
export function verbatim(transcript: string, span: string, allowShort = false): string | null {
  const T = squash(transcript), S = squash(span).out; if (S.length < 1 || (S.length < 2 && !allowShort)) return null; let at = T.out.indexOf(S);
  if (S.length < 2) { // v3：单字回答（「改。」「写。」「行，……」）只在它是整句/整个分句时才算
    at = -1; for (let i = 0; i < T.out.length; i++) { if (T.out[i] !== S) continue; const before = i === 0 ? -1 : T.idx[i - 1], here = T.idx[i], after = i + 1 < T.out.length ? T.idx[i + 1] : transcript.length; if (here - before > 1 && after - here > 1 || (i === 0 && after - here > 1) || (i + 1 === T.out.length && here - before > 1)) { at = i; break; } } }
  if (at < 0) return null;
  let end = T.idx[at + S.length - 1] + 1; let k = 0; while (end < transcript.length && !keep(transcript[end]) && !/\s/.test(transcript[end]) && k < 3) { end++; k++; } // 带上紧随其后的标点（如问号）
  return transcript.slice(T.idx[at], end);
}
const QEND = /[？?]\s*$|[吗吧呢]\s*$/;
export function cleanItems(raw: Raw, transcripts: Record<number, string>, allowShort = false) {
  const out: Item[] = []; let dropped = 0, overridden = 0;
  for (const r of raw.items ?? []) {
    const unit = Number(r?.unit), id = Number(r?.id); if (!Number.isInteger(unit) || !Number.isInteger(id) || !transcripts[unit] || !TYPES.includes(String(r?.type)) || typeof r?.span !== 'string') { dropped++; continue; }
    const v = verbatim(transcripts[unit], r.span, allowShort); if (!v) { dropped++; continue; }
    const it: Item = { id, unit, type: String(r.type), span: v, answers: Number.isInteger(Number(r.answers)) && r.answers !== null ? Number(r.answers) : null };
    if ((it.type === '事实' || it.type === '决定') && QEND.test(it.span)) { it.type = '假设'; it.overridden = true; overridden++; }
    out.push(it);
  }
  // 自问自答：answers 指向更早的问题/探路
  for (const b of out) if (b.answers !== null) { const a = out.find((x) => x.id === b.answers); if (a && (a.type === '问题' || a.type === '探路') && (a.unit < b.unit || (a.unit === b.unit && a.id < b.id))) a.answeredBy = b.id; }
  return { items: out, dropped, overridden };
}
const TOK = /[A-Za-z][A-Za-z0-9_.\-/]{2,}/g;
export function guardReplacements(items: Item[], reps: any[], ctx: string) {
  const accepted: { from: string; to: string }[] = [], rejected: { from: string; to: string; why: string }[] = []; const lc = ctx.toLowerCase(); const ctxToks = [...new Set(ctx.match(TOK) ?? [])];
  for (const r of reps ?? []) {
    const from = typeof r?.from === 'string' ? r.from.replace(/^`|`$/g, '') : '', to = typeof r?.to === 'string' ? r.to.replace(/^`|`$/g, '') : '';
    const lf = low(from), lt = low(to); const dist = lf && lt ? lev(lf, lt) / Math.max(lf.length, lt.length) : 1;
    const why = !from || !to ? 'shape' : !items.some((i) => i.span.includes(from)) ? 'from-not-substring' : lc.includes(from.toLowerCase()) ? 'from-in-context' : !ctx.includes(to) ? 'to-not-in-context' : dist > 0.5 ? 'too-far'
      : !/[A-Za-z]/.test(from) || !/[A-Za-z]/.test(to) ? 'not-latin' : (to.match(/\//g) ?? []).length > (from.match(/\//g) ?? []).length || (!to.includes('*') && from.includes('*')) ? 'concretizes'
      : ctxToks.filter((t) => { const l = low(t); return l && lev(lf, l) / Math.max(lf.length, l.length) <= 0.5; }).length >= 2 ? 'ambiguous' : '';
    if (why) rejected.push({ from, to, why }); else { accepted.push({ from, to }); for (const i of items) if (i.span.includes(from)) { i.span = i.span.split(from).join(to); (i.repaired ??= []).push({ from, to }); } }
  }
  return { accepted, rejected };
}
const REF = /(那个|这个|那条|这条|刚才|上面|你说的|你提到|第[一二三四五六七八九十0-9]+(个|种|点|条|项)|方案\s*[A-Za-z0-9])/;
export function acceptAnchors(anchors: any[], transcripts: Record<number, string>, ctxLines: string[]) {
  const ok: { unit: number; text: string; lines: number[] }[] = [], rej: string[] = [];
  for (const a of anchors ?? []) { const unit = Number(a?.unit); const lines: number[] = Array.isArray(a?.lines) ? a.lines.map(Number) : [];
    if (!transcripts[unit] || !REF.test(transcripts[unit])) { rej.push('no-reference-marker'); continue; }
    const s = [...new Set(lines)].sort((x, y) => x - y); if (!s.length || s.length > 5 || !s.every((x, i) => Number.isInteger(x) && x >= 1 && x <= ctxLines.length && (i === 0 || x === s[i - 1] + 1))) { rej.push('bad-lines'); continue; }
    ok.push({ unit, lines: s, text: s.map((n) => ctxLines[n - 1]).join('\n') }); }
  return { ok, rej };
}
const strip = (s: string) => s.replace(/[？?。.\s]+$/, '').trim();
export function render(items: Item[], anchors: { unit: number; text: string }[]) {
  const lines: string[] = []; const prov: number[][] = []; const live = items.filter((i) => !i.answeredBy);
  for (let k = 0; k < live.length; k++) { const it = live[k];
    if (it.type === '探路') { const grp = [it]; while (k + 1 < live.length && live[k + 1].type === '探路') grp.push(live[++k]); lines.push(`请检查/查明：${grp.map((g) => strip(g.span)).join('；')}`); prov.push(grp.map((g) => g.unit)); continue; }
    const t = strip(it.span);
    lines.push(it.type === '事实' ? `已知：${t}` : it.type === '问题' ? `请检查/查明：${t}` : it.type === '假设' ? `我的判断（假设）：${t}，请检验` : it.type === '决定' ? `已决定：${t}` : `约束：${t}`); prov.push([it.unit]);
    for (const a of anchors.filter((x) => x.unit === it.unit && !lines.includes(`> 引用：${x.text}`))) lines.push(`> 引用：${a.text.replace(/\n/g, '\n> ')}`); }
  return { prompt: lines.join('\n'), prov };
}
export function run(raw: Raw, transcripts: Record<number, string>, ctx: string, useCtx: boolean, allowShort = false) {
  const c = cleanItems(raw, transcripts, allowShort); const ctxLines = ctx.split('\n').filter((l) => l.trim());
  const rep = useCtx ? guardReplacements(c.items, raw.replacements ?? [], ctx) : { accepted: [], rejected: [] as any[] }; const anc = useCtx ? acceptAnchors(raw.anchors ?? [], transcripts, ctxLines) : { ok: [], rej: [] as string[] };
  const r = render(c.items, anc.ok); return { items: c.items, dropped: c.dropped, overridden: c.overridden, replacements: rep, anchors: anc, prompt: r.prompt };
}

// ───────────────────────── v2：保留「问 + 答」（E-C4）。v1 的行为不变，便于复现 E-C3。
const FILLER = /^[嗯呃啊哦那就也还有，,、\s]+/;
const ANS_START = /^(要|不要|不用|不会|不能|不|是的?|对|行|好|可以|没问题|应该|先不|暂不|留着?|带|改|记|沿用|保持|照旧|按|都|有|没有|右边|左边|都要)/;
const isQuestion = (s: string, loose = false) => /[？?]\s*$/.test(s) || (/(要不要|是不是|能不能|行不行|对不对|会不会|还是|吗)/.test(s) && /[？?]/.test(s)) || (loose && (/(要不要|是不是|能不能|行不行|对不对|会不会|有没有)/.test(s) || /吗[，,。\s]*$/.test(s)));
/** 把「问句 + 紧随其后的省略式回答」配成一对：模型给的 answers，加上规则（同一段内、问句后紧跟的决定/事实/约束/假设，且以应答词开头或很短）。返回 问句 id → 回答 id。 */
export function pairAnswers(items: Item[], loose = false): Map<number, number> {
  const pairs = new Map<number, number>();
  // 模型给出的配对要过护栏（E-C3 重放里看到的误配）：问题必须是问句形态；回答必须是决定/约束/事实/假设且本身不是问句；至多隔一段。
  for (const b of items) if (b.answers !== null) { const a = items.find((x) => x.id === b.answers); if (a && (a.type === '问题' || a.type === '探路' || a.type === '假设') && isQuestion(a.span, loose) && ['决定', '约束', '事实', '假设'].includes(b.type) && !isQuestion(b.span, loose) && b.unit - a.unit >= 0 && b.unit - a.unit <= 1 && !pairs.has(a.id) && (a.unit < b.unit || (a.unit === b.unit && a.id < b.id))) pairs.set(a.id, b.id); }
  for (let i = 0; i + 1 < items.length; i++) { const a = items[i], b = items[i + 1]; if (pairs.has(a.id) || [...pairs.values()].includes(b.id)) continue;
    if (a.unit !== b.unit || !['问题', '探路', '假设'].includes(a.type) || !isQuestion(a.span, loose) || !['决定', '事实', '约束', '假设'].includes(b.type)) continue;
    const body = b.span.replace(FILLER, ''); const n = squash(body).out.length; if (ANS_START.test(body) || n <= 8) pairs.set(a.id, b.id); }
  return pairs;
}
export function renderV2(items: Item[], anchors: { unit: number; text: string }[], pairs: Map<number, number>) {
  const answerIds = new Set(pairs.values()); const lines: string[] = []; const live = items.filter((i) => !answerIds.has(i.id));
  for (let k = 0; k < live.length; k++) { const it = live[k]; const ans = pairs.has(it.id) ? items.find((x) => x.id === pairs.get(it.id)) : undefined;
    if (ans) { const q = it.span.trim(), a = ans.span.trim().replace(FILLER, '');
      lines.push(ans.type === '决定' ? `已决定：（问）${q}（答）${a}` : ans.type === '假设' ? `我的判断（假设）：（问）${q}（答）${strip(a)}，请检验` : ans.type === '约束' ? `约束：（问）${q}（答）${a}` : `已知：（问）${q}（答）${a}`); continue; }
    if (it.type === '探路') { const grp = [it]; while (k + 1 < live.length && live[k + 1].type === '探路' && !pairs.has(live[k + 1].id)) grp.push(live[++k]); lines.push(`请检查/查明：${grp.map((g) => strip(g.span)).join('；')}`); continue; }
    const t = strip(it.span);
    lines.push(it.type === '事实' ? `已知：${t}` : it.type === '问题' ? `请检查/查明：${t}` : it.type === '假设' ? `我的判断（假设）：${t}，请检验` : it.type === '决定' ? `已决定：${t}` : `约束：${t}`);
    for (const a of anchors.filter((x) => x.unit === it.unit && !lines.includes(`> 引用：${x.text}`))) lines.push(`> 引用：${a.text.replace(/\n/g, '\n> ')}`); }
  return lines.join('\n');
}
export function runV2(raw: Raw, transcripts: Record<number, string>, ctx: string, useCtx: boolean) {
  const base = run(raw, transcripts, ctx, useCtx); const pairs = pairAnswers(base.items); return { ...base, pairs, promptV2: renderV2(base.items, base.anchors.ok, pairs) };
}

// v3：v2 + 单字整句跨度 + 无问号的强疑问形态（转写里的停顿常把问号标成逗号）。
export function runV3(raw: Raw, transcripts: Record<number, string>, ctx: string, useCtx: boolean) {
  const base = run(raw, transcripts, ctx, useCtx, true); const pairs = pairAnswers(base.items, true); return { ...base, pairs, promptV3: renderV2(base.items, base.anchors.ok, pairs) };
}
