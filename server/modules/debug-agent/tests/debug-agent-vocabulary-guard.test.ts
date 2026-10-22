import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ADR-003 decision 7 as a static guard — the file `goals/AC-126` names.
 *
 * The debug agent is allowed to construct dialect ROWS and nothing else: a
 * scenario says what gets written to a transcript and when, and every frame a
 * client sees is what the product's own normalizer makes of those rows. The
 * moment a frame or event name appears in this module, someone has started
 * building frames here, and "the debug agent goes through the same chain as the
 * product" stops being true — which is the only reason its output is evidence
 * about the product at all.
 *
 * Two halves, and neither means anything alone:
 *
 *  1. NO frame field name and NO event name appears in the module's source. The
 *     dialect's own field names (`type`, `message`, `content`, ...) are not in
 *     the vocabulary; the vocabulary is the WIRE's. The `kind:` fields the
 *     module may write are ROW discriminators, never the wire's: a host LEASE's
 *     — see {@link HOST_LEASE_KIND_LITERALS} — and the claude dialect's own
 *     `origin.kind` on a peer row — see {@link DIALECT_ROW_KIND_LITERALS}.
 *  2. The module really does import the product's normalization entry. Half 1 on
 *     its own is passed by a module that produces nothing at all, so half 2 is
 *     its complement: it says the row → frame edge exists and is the product's.
 *
 * Scope, and why it is the scope it is. The scan covers the module's own `*.ts`
 * sources, NOT `tests/`: `tests/debug-agent-external-write.test.ts` asserts on the
 * `session_upserted` broadcast by name, which is exactly what a behavioural test
 * should do. This guard lives under `tests/` too, so it is out of scope by the
 * same rule — and the test below PROVES that exclusion is load-bearing rather
 * than incidental, by scanning this file's own text and showing it hits.
 *
 * The honest upper bound. This reads LITERALS. A frame name assembled at runtime
 * from fragments, or read out of a config file, is invisible here. So this is the
 * static half of decision 7 and not a substitute for the behavioural criteria
 * (`AC-124`): "the frames really came out of the normalizer" is measured there,
 * on a run, against the artifact.
 */

/** This file, as an absolute path — the scan set must never contain it. */
const GUARD_FILE = fileURLToPath(import.meta.url);

/** The debug agent's module directory: the directory this file's `tests/` sits in. */
const MODULE_DIR = path.resolve(path.dirname(GUARD_FILE), '..');

/** For printing hit locations the way a reader would type them. */
const REPO_ROOT = path.resolve(MODULE_DIR, '../../..');

function rel(file: string): string {
  return path.relative(REPO_ROOT, file);
}

/**
 * The wire's own names (ADR-003 decision 7).
 *
 * This is the frame/event vocabulary a client can receive — `MessageKind` plus
 * `GatewayEventKind` in `@/shared/types.js` — minus `text`. `text` is deliberately
 * absent: it is ALSO the claude dialect's own content-part type, which
 * `debug-agent.runtime.ts` has to write when it builds a row
 * (`content: [{ type: 'text', text }]`), so a vocabulary that flagged it would
 * force the module to rename a dialect field it is required to write.
 */
const FRAME_AND_EVENT_LITERALS = [
  'stream_delta',
  'stream_end',
  'complete',
  'session_upserted',
  'permission_request',
  'permission_resolved',
  'permission_cancelled',
  'session_created',
  'history_truncated',
  'task_notification',
  'tool_use',
  'tool_result',
  'thinking',
] as const;

const VOCABULARY = new Set<string>(FRAME_AND_EVENT_LITERALS);

/**
 * The `kind:` values this module IS allowed to write by hand: a HOST LEASE's.
 *
 * `HostLease` (`@/shared/types.js`) is the other thing this module constructs —
 * the host driver reports a lease when a turn opens and when a scenario adds a
 * keepalive, and those values carry a `kind` discriminant of their own
 * (`turn` | `background-task` | `monitor` | `cron` | `resident-policy`). That is
 * the host layer's vocabulary, not the wire's: no client ever receives a lease,
 * so a lease `kind:` is not the "frames are being built here" signal the rule
 * below exists to catch.
 *
 * The list is written out rather than derived because `HostLease['kind']` is a
 * type, not a value — there is no runtime closed set to read. That makes it a
 * list that can go stale, which is why the scan is by FIELD VALUE and not by
 * "allow-list the hits I know about": any `kind:` outside these five still reds,
 * so a new lease kind added upstream fails this guard until it is listed here,
 * visibly, next to the contract it is copying.
 */
const HOST_LEASE_KIND_LITERALS = [
  'turn',
  'background-task',
  'monitor',
  'cron',
  'resident-policy',
] as const;

const HOST_LEASE_KINDS = new Set<string>(HOST_LEASE_KIND_LITERALS);

/**
 * The claude dialect's own `origin.kind` value this module must reproduce: a
 * message another session sent.
 *
 * `origin` is a ROW field — the CLI writes it on a transcript line, beside
 * `isMeta` and `message` — and its `kind` says what the message *is* (a peer
 * delivery), not how a client should frame it. The module writes it because the
 * debug agent's job is to describe what the CLI writes, and a scenario that used
 * the shared `{trigger, sender}` vocabulary here instead would produce a row the
 * CLI never produces — blind to the very gate that drops the real one
 * (gap-cross-session-message-dropped-by-ismeta-gate). Like a host lease's
 * `kind:`, this value is a row discriminator rather than the wire's, which is
 * why {@link KIND_VALUE} must not read it as a frame written by hand.
 *
 * Written out rather than derived, for the same reason as the lease list: the
 * dialect's raw shape has no runtime closed set to read. A `kind:` at ANY other
 * value still reds — see the near-miss control in the not-inert test — so a new
 * dialect discriminator fails this guard until it is listed here, visibly.
 */
const DIALECT_ROW_KIND_LITERALS = ['peer'] as const;

const DIALECT_ROW_KINDS = new Set<string>(DIALECT_ROW_KIND_LITERALS);

/**
 * A `kind:` given a literal value — ANY value outside {@link HOST_LEASE_KINDS}
 * and {@link DIALECT_ROW_KINDS}, not only the names listed above.
 *
 * This is the other half of the literal vocabulary, and the one that catches the
 * frames-only shape: ADR-003's verification record measured a fake implementation
 * being caught by `kind: 'text'` while the real path hit nothing. A turn row's
 * own discriminator is its `type`, so a `kind:` in this module can only be a
 * frame discriminator written by hand — a host lease's, or the claude dialect's
 * `origin.kind` on a peer row, the two row-layer exclusions the sets above
 * carry. Matching the FIELD rather than a list of values is what keeps this from
 * going stale the next time a kind is added upstream.
 */
const KIND_VALUE =
  /\bkind\s*:\s*(?<quote>['"`])(?<value>(?:\\.|(?!\k<quote>)[^\\\n])*)\k<quote>/g;

/**
 * The normalization entry a real import statement must reach: the product's own
 * session normalizer, either bound directly or named as a member of the shared
 * contract that declares it.
 */
const NORMALIZATION_ENTRY_NAMES = ['normalizeMessage', 'createNormalizedMessage'];

/**
 * Where that entry may be imported from. The providers module is not an option
 * and never was: the registry registers this module's provider, so importing
 * back would close a cycle (see `debug-agent.provider.ts`). The shared module is
 * the one place both sides may name.
 */
const SHARED_MODULE = /^@\/shared\//;

const LINE_BREAK = '\n';

type LiteralHit = { file: string; line: number; what: string };

function formatHit(hit: LiteralHit): string {
  return `${hit.file}:${hit.line}: ${hit.what}`;
}

type StringLiteral = {
  value: string;
  /** Where the literal starts in the comment-stripped text, so its line can be read off that one string. */
  start: number;
};

type ScannedSource = {
  /** The source with every comment blanked out; offsets and line breaks are preserved so a hit can name its line. */
  code: string;
  /** Every quoted literal in the source, in source order. A comment contributes none. */
  literals: StringLiteral[];
};

/**
 * Reads one quoted literal from `start`, verbatim, up to and including its
 * closing quote.
 *
 * A template literal is read as ONE opaque literal — its `${...}` substitutions
 * stay text rather than being parsed as expressions. Nothing this module writes
 * hides a name behind a substitution, and treating them as text keeps a `${`
 * from being mistaken for the start of a nested scanner state.
 *
 * A line break ends a single- or double-quoted literal instead of letting it run
 * to the end of the file: a malformed source would otherwise swallow every line
 * after it, which is the one failure that would make this guard silently blind.
 */
function readLiteral(source: string, start: number): { text: string; value: string; end: number } {
  const quote = source.charAt(start);
  let text = quote;
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '\\') {
      const escaped = char + source.charAt(index + 1);
      text += escaped;
      value += escaped;
      index += 2;
      continue;
    }

    if (char === LINE_BREAK) {
      if (quote !== '`') {
        break;
      }
      text += char;
      value += char;
      index += 1;
      continue;
    }

    text += char;
    index += 1;
    if (char === quote) {
      break;
    }
    value += char;
  }

  return { text, value, end: index };
}

/**
 * Splits a source into the text this guard reasons about and the literals it
 * carries, so both halves read the same view of the file.
 *
 * Comments are replaced by spaces rather than deleted: line numbers survive, and
 * a name that appears only in prose stops being visible — which is what makes
 * "the entry is named" a statement about code (ADR-003's task for this guard
 * calls that trap out: an import degraded to a comment must go red).
 */
function readSource(source: string): ScannedSource {
  const code: string[] = [];
  const literals: StringLiteral[] = [];
  let index = 0;

  const blank = (text: string): void => {
    code.push(text === LINE_BREAK ? LINE_BREAK : ' ');
  };

  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);

    if (char === LINE_BREAK) {
      code.push(char);
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source.charAt(index) !== LINE_BREAK) {
        blank(source.charAt(index));
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      blank(char);
      blank(next);
      index += 2;
      while (index < source.length && !(source.charAt(index) === '*' && source.charAt(index + 1) === '/')) {
        blank(source.charAt(index));
        index += 1;
      }
      for (let closing = 0; closing < 2 && index < source.length; closing += 1) {
        blank(source.charAt(index));
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const literal = readLiteral(source, index);
      code.push(literal.text);
      literals.push({ value: literal.value, start: index });
      index = literal.end;
      continue;
    }

    code.push(char);
    index += 1;
  }

  return { code: code.join(''), literals };
}

/** The 1-based line `index` falls on in `code`. */
function lineAt(code: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (code.charAt(cursor) === LINE_BREAK) {
      line += 1;
    }
  }
  return line;
}

/**
 * Half 1, for one source: every frame name spelled as a literal, and every
 * `kind:` given one — except a host lease's, which is not the wire's vocabulary.
 *
 * Each hit carries the file and the line, so a red run names what to delete
 * rather than only that something is wrong.
 */
function scanLiterals(file: string, source: string): LiteralHit[] {
  const { code, literals } = readSource(source);
  const hits: LiteralHit[] = [];

  for (const literal of literals) {
    if (VOCABULARY.has(literal.value)) {
      hits.push({
        file,
        line: lineAt(code, literal.start),
        what: `the frame/event literal ${JSON.stringify(literal.value)} — this module builds dialect rows; the frames are the normalizer's to make`,
      });
    }
  }

  for (const match of code.matchAll(KIND_VALUE)) {
    const value = match.groups?.value ?? '';
    if (HOST_LEASE_KINDS.has(value) || DIALECT_ROW_KINDS.has(value)) {
      continue;
    }

    const line = lineAt(code, match.index ?? 0);
    hits.push({
      file,
      line,
      what: `${match[0].trim()} — a \`kind:\` written by hand is a frame discriminator, and a dialect row carries no \`kind\` field`,
    });
  }

  return hits;
}

/**
 * Blank out `[start, end)` of `code`, keeping line breaks, so that asking "is
 * this symbol used here" cannot be answered by the statement that declares it.
 */
function blankRange(code: string, start: number, end: number): string {
  return code.slice(0, start) + code.slice(start, end).replace(/[^\n]/g, ' ') + code.slice(end);
}

const IMPORT_STATEMENT = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;

type ImportRecord = { specifier: string; locals: string[]; line: number; start: number; end: number };

/**
 * The local names an import clause binds: the default binding, `* as ns`, and
 * every named member — including `x as y` and `type x as y`, which the shared
 * barrel uses for its type-only re-exports.
 */
function readImportLocals(rawClause: string): string[] {
  // `import type { A } from …` and `import { type A } from …` are both written in
  // this repo; the leading form is stripped here so neither is read as binding a
  // member literally called `type`.
  const clause = rawClause.replace(/^\s*type\s+/, '');
  const locals: string[] = [];
  const open = clause.indexOf('{');
  const head = open === -1 ? clause : clause.slice(0, open);
  const named = open === -1 ? '' : clause.slice(open + 1, clause.lastIndexOf('}'));

  const namespace = head.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const defaultBinding = head.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  const headBinding = namespace?.[1] ?? defaultBinding?.[1];
  if (headBinding) {
    locals.push(headBinding);
  }

  for (const member of named.split(',')) {
    const withoutType = member.trim().replace(/^type\s+/, '').trim();
    if (!withoutType) {
      continue;
    }
    const aliased = withoutType.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
    const plain = withoutType.match(/^([A-Za-z_$][\w$]*)$/);
    const local = aliased?.[1] ?? plain?.[1];
    if (local) {
      locals.push(local);
    }
  }

  return locals;
}

/** Every import statement in comment-stripped `code`, with the locals it binds. */
function readImports(code: string): ImportRecord[] {
  const records: ImportRecord[] = [];

  for (const match of code.matchAll(IMPORT_STATEMENT)) {
    const start = match.index ?? 0;
    records.push({
      specifier: match[3] ?? '',
      locals: readImportLocals(match[1] ?? ''),
      line: lineAt(code, start),
      start,
      end: start + match[0].length,
    });
  }

  return records;
}

function containsWord(code: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(code);
}

/**
 * Half 2, for one source: a real import statement that reaches the product's
 * normalization entry, and the entry actually used.
 *
 * Two forms are accepted, because both are an import statement pointing at the
 * entry:
 *
 *  - the entry bound by name (`import { createNormalizedMessage } from '@/shared/utils.js'`),
 *    used somewhere in the file;
 *  - the entry named as a member of a shared contract bound by name
 *    (`IProviderSessions['normalizeMessage']`), which is how this module reaches
 *    it: the provider module cannot be imported (the registry registers this
 *    provider, so the edge back would close a cycle), so the shared contract that
 *    declares the entry is the compile-time edge.
 *
 * `normalizeMessage` merely being a parameter or a property name is NOT either
 * form — that is the degradation the criterion warns about, and it stays green
 * only if this function is written to look for the import.
 */
function scanEntry(file: string, source: string): LiteralHit[] {
  const { code } = readSource(source);
  const imports = readImports(code);
  const hits: LiteralHit[] = [];

  let body = code;
  for (const record of imports) {
    body = blankRange(body, record.start, record.end);
  }

  for (const record of imports) {
    if (!SHARED_MODULE.test(record.specifier)) {
      continue;
    }

    for (const local of record.locals) {
      if (NORMALIZATION_ENTRY_NAMES.includes(local)) {
        if (containsWord(body, local)) {
          hits.push({
            file,
            line: record.line,
            what: `import { ${local} } from '${record.specifier}' (line ${record.line}), and the file uses it`,
          });
        }
        continue;
      }

      const asMember = new RegExp(
        `\\b${local}\\s*(?:\\[\\s*['"\`]normalizeMessage['"\`]\\s*\\]|\\.\\s*normalizeMessage\\b)`,
      );
      if (asMember.test(body)) {
        hits.push({
          file,
          line: record.line,
          what: `import { ${local} } from '${record.specifier}' (line ${record.line}), naming the entry as ${local}['normalizeMessage']`,
        });
      }
    }
  }

  return hits;
}

/**
 * The files this guard scans: the module's own `*.ts` sources. `tests/` is not
 * one of them — this module's tests assert on wire names on purpose.
 */
function collectModuleSources(): string[] {
  return fs
    .readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(MODULE_DIR, name))
    .sort();
}

function scanModuleLiterals(files: string[]): LiteralHit[] {
  return files.flatMap((file) => scanLiterals(rel(file), fs.readFileSync(file, 'utf8')));
}

function scanModuleEntry(files: string[]): LiteralHit[] {
  return files.flatMap((file) => scanEntry(rel(file), fs.readFileSync(file, 'utf8')));
}

const MODULE_SOURCES = collectModuleSources();

test('half 1 — the module names no frame and no event', () => {
  const hits = scanModuleLiterals(MODULE_SOURCES);

  assert.deepEqual(
    hits,
    [],
    `the debug module may build dialect rows only (ADR-003 decision 7); these lines say frames are being built here:\n${hits
      .map(formatHit)
      .join('\n')}`,
  );
});

test('half 2 — the module imports the product normalization entry', () => {
  const hits = scanModuleEntry(MODULE_SOURCES);

  assert.ok(
    hits.length > 0,
    `no source file under ${rel(MODULE_DIR)}/ imports the normalization entry (${NORMALIZATION_ENTRY_NAMES.join(
      ' / ',
    )}) from a shared module and uses it. Half 1 passes for a module that produces nothing at all, so this half is what says the row → frame edge exists — and that it is the product's own.`,
  );

  for (const hit of hits) {
    console.log(`[vocabulary-guard] normalization entry via ${formatHit(hit)}`);
  }
});

test('the scan set is the module sources, and the guard is not one of them', () => {
  console.log(`[vocabulary-guard] scanning ${MODULE_SOURCES.length} module source file(s):`);
  for (const file of MODULE_SOURCES) {
    console.log(`  - ${rel(file)}`);
  }
  console.log(
    `[vocabulary-guard] vocabulary: ${VOCABULARY.size} frame/event literal(s), plus every \`kind:\` literal value outside the ${HOST_LEASE_KINDS.size} host-lease kind(s) and ${DIALECT_ROW_KINDS.size} dialect row kind(s)`,
  );

  assert.ok(
    MODULE_SOURCES.length > 0,
    'the module directory must hold source files: an empty scan set would make every assertion above vacuously green',
  );
  assert.ok(
    !MODULE_SOURCES.includes(GUARD_FILE),
    `${rel(GUARD_FILE)} must not be scanned — the vocabulary it asserts is written in its own text, so a scan set containing it would hit itself`,
  );

  // Positive control: the exclusion is doing work, not decoration. Scanning this
  // file's own text DOES produce hits, so a guard that sat beside the sources (or
  // one that failed to leave `tests/` out) would be red — which is what stops the
  // alternative failure, a vocabulary quietly distorted until it stops matching.
  const selfHits = scanModuleLiterals([...MODULE_SOURCES, GUARD_FILE]);
  assert.ok(
    selfHits.length > 0,
    'scanning the guard file itself must produce hits; if it does not, the self-exclusion is incidental and this guard could sit in the scanned directory while staying green',
  );

  console.log(`[vocabulary-guard] self-inclusion control: ${selfHits.length} hit(s) if this file were scanned:`);
  for (const hit of selfHits.slice(0, 3)) {
    console.log(`  - ${formatHit(hit)}`);
  }
});

test('the literal half is not inert — a planted frame is caught, a dialect row is not', () => {
  const planted = [
    "const fake = 'stream_delta';",
    "writer.send({ kind: 'text', content });",
    "const events = ['session_upserted'];",
  ].join('\n');

  const hits = scanLiterals('(planted frame)', planted);
  assert.deepEqual(
    hits.map((hit) => hit.line).sort((left, right) => left - right),
    [1, 2, 3],
    `a hand-written frame literal and a hand-written \`kind:\` must both be caught at their own lines; got:\n${hits
      .map(formatHit)
      .join('\n')}`,
  );
  assert.ok(
    hits.some((hit) => hit.line === 2 && hit.what.startsWith("kind: 'text'")),
    'the hand-written `kind:` must be caught by the FIELD, not by a value on the vocabulary list — `text` is deliberately not one of the 13 names, so a value-list-only guard would miss this line',
  );

  // The other direction, and the reason `text` is not in the vocabulary: the row
  // `debug-agent.runtime.ts` is required to write must scan clean.
  const dialectRow =
    "export function buildRow(role: string, text: string) {\n  return { type: role, message: { role, content: [{ type: 'text', text }] } };\n}\n";
  assert.deepEqual(
    scanLiterals('(dialect row)', dialectRow),
    [],
    'a dialect row written the way this module writes them must not be flagged — in particular `type: \'text\'` is a row field, not a frame kind',
  );

  // The exclusion, in both directions. A host lease's `kind:` is the host
  // layer's own discriminant and must scan clean, or the host driver cannot
  // report a lease at all; a `kind:` at the same field position with any other
  // value must still red, or the exclusion has widened the rule into nothing.
  const hostLeases =
    "const turn: HostLease = { kind: 'turn', runId };\nconst cron: HostLease = { kind: 'cron', id, recurring: true };\nconst held: HostLease = { kind: 'resident-policy' };\n";
  assert.deepEqual(
    scanLiterals('(host leases)', hostLeases),
    [],
    'the lease kinds `HostLease` declares must not be read as frame discriminators — the host driver reports leases, and the wire never carries one',
  );

  const peerOrigin = "const row = { origin: { kind: 'peer', name, msg_id } };\n";
  assert.deepEqual(
    scanLiterals('(peer origin)', peerOrigin),
    [],
    "the claude dialect's own `origin.kind` on a peer row is a row discriminator, not a frame the module built: it must scan clean, or the guard would force the fixture to write a shape the CLI never produces",
  );

  const nearMissLease = "const lease = { kind: 'delta', id };\n";
  assert.deepEqual(
    scanLiterals('(near-miss lease)', nearMissLease).map((hit) => hit.line),
    [1],
    "`kind: 'delta'` is not a `HostLease` kind, so the field rule must still catch it: an exclusion that swallowed every `kind:` would be a guard that stopped guarding",
  );

  const nearMissOrigin = "const row = { origin: { kind: 'oracle', name } };\n";
  assert.deepEqual(
    scanLiterals('(near-miss origin)', nearMissOrigin).map((hit) => hit.line),
    [1],
    "the peer exclusion must not widen to every `origin.kind`: any value the dialect does not declare still reds, so a new discriminator cannot slip in unlisted",
  );
});

test('the import half is not inert — a comment is not an import, and neither is an unused one', () => {
  const direct =
    "import { createNormalizedMessage } from '@/shared/utils.js';\nconst frame = createNormalizedMessage(fields);\n";
  assert.equal(scanEntry('(direct entry import)', direct).length, 1, 'a direct binding of the entry, used, is the first accepted form');

  const contract =
    "import type { IProviderSessions } from '@/shared/interfaces.js';\ntype Entry = IProviderSessions['normalizeMessage'];\n";
  assert.equal(scanEntry('(contract import)', contract).length, 1, 'naming the entry as a member of a shared contract is the second accepted form');

  const commentOnly = "// this module hands its rows to normalizeMessage, the product's own entry\nconst frame = whatever(fields);\n";
  assert.deepEqual(
    scanEntry('(comment only)', commentOnly),
    [],
    'the entry named in a COMMENT must not count: a guard satisfied by prose is green for the wrong reason',
  );

  const unusedImport = "import { createNormalizedMessage } from '@/shared/utils.js';\nconst nothing = 1;\n";
  assert.deepEqual(
    scanEntry('(unused import)', unusedImport),
    [],
    'an import whose symbol is never used must not count: an inert import is not a row → frame edge',
  );

  const foreignImport = "import { normalizeMessage } from '@/modules/providers/index.js';\nconst frame = normalizeMessage(row);\n";
  assert.deepEqual(
    scanEntry('(foreign import)', foreignImport),
    [],
    'the entry must be reached through the shared module; the providers module is the cycle this module may not close',
  );
});
