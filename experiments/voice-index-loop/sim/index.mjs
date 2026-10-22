// The auto-maintained entity index (PREREG-v3 §5 E2). Pure and deterministic: every method takes the clock (`now`, in
// days) explicitly, nothing reads the environment, and `opts.disable` switches a rule off so the tests can prove each
// rule is the thing keeping its assertion green.
import { isId, normKey, shapeType } from './lib.mjs';

export const DEFAULTS = { promoteAfter: 1, convTurns: 8, tombDays: 30, archiveDays: 90, K: 200 };

export class EntityIndex {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts }; this.off = new Set(opts.disable ?? []);
    this.P = new Map();       // proj -> Map(name -> { type, present, tombAt })
    this.U = new Map();       // lower token -> { canonical, count, lastAt }
    this.aliases = new Map(); // proj -> Map(heardNorm -> Entry[])
    this.conflicts = 0;
    this.blocked = new Set(); // `${proj}|${heardNorm}|${canonical}` silent replacements the user reverted
  }
  // ── P: the project's own names ───────────────────────────────────────────────────────────────
  syncProject(proj, names, now) {
    const cur = this.P.get(proj) ?? new Map(); this.P.set(proj, cur);
    for (const [name, type] of names) { const e = cur.get(name); if (e) { e.present = true; e.tombAt = null; e.type = type; } else cur.set(name, { type, present: true, tombAt: null }); }
    for (const [name, e] of [...cur]) {
      if (names.has(name)) continue;
      if (this.off.has('tombstone')) { cur.delete(name); continue; }
      if (e.present) { e.present = false; e.tombAt = now; }
      else if (now - e.tombAt > this.o.tombDays) cur.delete(name);
    }
  }
  // ── U: what the user has sent ────────────────────────────────────────────────────────────────
  observeSent(tokens, now) { for (const t of tokens) { const k = t.toLowerCase(); const e = this.U.get(k); if (e) { e.count++; e.lastAt = now; } else this.U.set(k, { canonical: t, count: 1, lastAt: now }); } }
  // ── entities offered to the matcher ──────────────────────────────────────────────────────────
  /** sources: Set of 'P' | 'C' | 'U'. conv: Map(token -> turn distance). Returns Map(term -> features). */
  entities(proj, conv, now, sources) {
    const out = new Map();
    const add = (term, f) => { const e = out.get(term) ?? { term, sources: new Set(), recent: false, prior: false, count: 0, type: shapeType(term), tomb: false }; for (const k of Object.keys(f)) { if (k === 'src') e.sources.add(f.src); else if (k === 'type') e.type = f.type; else if (k === 'count') e.count = Math.max(e.count, f.count); else if (f[k]) e[k] = f[k]; } out.set(term, e); };
    if (sources.has('P')) for (const [name, e] of this.P.get(proj) ?? []) { if (!isId(name)) continue; add(name, { src: 'P', prior: true, type: e.type, tomb: !e.present }); }
    if (sources.has('U')) for (const [k, e] of this.U) { if (!this.off.has('archive') && now - e.lastAt > this.o.archiveDays) continue; add(e.canonical, { src: 'U', prior: true, count: e.count }); }
    if (sources.has('C')) for (const [tok, dist] of conv) { if (!isId(tok)) continue; if (!this.off.has('convDecay') && dist > this.o.convTurns) continue; add(tok, { src: 'C', recent: true, prior: !!this.o.cPrior }); }
    if (this.o.aliasForms) {   // exploratory X4: every confirmed heard form is one more way to say its canonical
      for (const list of (this.aliases.get(proj) ?? new Map()).values()) for (const e of list) {
        if (e.confirms < 1 || e.state === 'archived') continue;
        for (const raw of e.raws ?? []) out.set(`${e.canonical}\u0000${raw}`, { term: e.canonical, matchTerm: raw, sources: new Set(['A']), recent: false, prior: true, count: e.confirms, type: shapeType(e.canonical), tomb: false });
      }
    }
    return out;
  }
  // ── aliases (heard → meant) ──────────────────────────────────────────────────────────────────
  _list(proj, heardNorm) { const m = this.aliases.get(proj) ?? new Map(); this.aliases.set(proj, m); const l = m.get(heardNorm) ?? []; m.set(heardNorm, l); return l; }
  confirm(proj, heardNorm, canonical, left, now, heardRaw) {
    const list = this._list(proj, heardNorm);
    let e = list.find((x) => x.canonical === canonical);
    if (!e) { e = { canonical, confirms: 0, hits: 0, reverts: 0, state: 'pending', lastAt: now, negLeft: new Set(), raws: new Set() }; list.push(e); }
    if (heardRaw) e.raws.add(heardRaw);
    e.confirms++; e.lastAt = now;
    if (e.confirms >= this.o.promoteAfter && e.state === 'pending' && e.reverts <= e.hits) e.state = 'active';
    if (!this.off.has('conflict')) {
      const live = list.filter((x) => x.confirms >= 1 && x.state !== 'archived');
      if (live.length >= 2) { for (const x of live) x.state = 'pending'; this.conflicts++; }
    }
    return e;
  }
  /** the canonical for an exact heard string, or null. `left` is the previous word (lower-cased) */
  l1(proj, heardNorm, left, now) {
    const list = (this.aliases.get(proj) ?? new Map()).get(heardNorm) ?? [];
    const act = list.filter((x) => x.state === 'active' && !(left && x.negLeft.has(left)));
    if (act.length !== 1) return null;
    act[0].hits++; act[0].lastAt = now; return act[0];
  }
  revert(proj, heardNorm, canonical, left, now) {
    const list = this._list(proj, heardNorm); const e = list.find((x) => x.canonical === canonical); if (!e) return;
    e.reverts++; e.lastAt = now; if (left && !this.off.has('negative')) e.negLeft.add(left);
    if (!this.off.has('demote') && e.reverts > e.hits) e.state = 'pending';
  }
  blockSilent(proj, heardNorm, canonical) { this.blocked.add(`${proj}|${heardNorm}|${canonical}`); }
  isBlocked(proj, heardNorm, canonical) { return this.blocked.has(`${proj}|${heardNorm}|${canonical}`); }
  sweep(now) {
    if (this.off.has('archive')) return;
    for (const m of this.aliases.values()) for (const l of m.values()) for (const e of l) if (e.state !== 'archived' && now - e.lastAt > this.o.archiveDays) e.state = 'archived';
  }
  // ── invariants (checked after every message of the replay) ───────────────────────────────────
  checkInvariants(proj, conv, now, sources, perWindowScored = 0) {
    const bad = [];
    const ents = this.entities(proj, conv, now, sources);
    for (const e of ents.values()) {
      if (e.sources.has('C') && e.sources.size === 1 && (conv.get(e.term) ?? 99) > this.o.convTurns) bad.push(`stale conversation entity ${e.term}`);
      if (e.tomb && e.sources.size === 1) { const p = this.P.get(proj)?.get(e.term); if (p && now - p.tombAt > this.o.tombDays) bad.push(`expired tombstone ${e.term}`); }
    }
    for (const m of this.aliases.values()) for (const l of m.values()) for (const e of l) { if (e.state === 'archived' && this.l1Probe(e)) bad.push('archived alias applies'); }
    if (perWindowScored > this.o.K) bad.push(`scored ${perWindowScored} > K`);
    return bad;
  }
  l1Probe(e) { return e.state === 'active'; }
}
