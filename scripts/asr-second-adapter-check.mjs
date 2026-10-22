#!/usr/bin/env node
/**
 * AC-132 — the second recogniser adapter, checked by RUNNING it rather than by reading it.
 *
 * WHY THIS PROBE EXECUTES THE TREE INSTEAD OF SCANNING IT. The sibling probe
 * (`asr-single-implementation-check.mjs`) answers a question about wiring — "how many copies of
 * this protocol exist" — and a scan is the right instrument for that. This task's three claims
 * are not about wiring at all: they are about what the adapter DOES with a request it cannot
 * afford, how it sizes that request, and what it leaves off the wire. None of those is visible in
 * a source file. So the probe loads the fixture's own modules — through `tsx/esm/api`'s loader, so
 * a bare `node` can import the tree's `.ts` (ADR-004 decision 2) — resolves the adapter out of
 * the fixture's own REGISTRY (not off a path this file hardcodes), and drives it with a stand-in
 * transport whose call count is the reading.
 *
 * THE THREE READINGS THAT CARRY THE TASK, one mechanical measurement each:
 *
 *   · an over-budget request is refused AND costs zero upstream calls — the second half is a
 *     stand-in counter, not an inference from the error code (AC1);
 *   · the budget is the WHOLE REQUEST: the same audio is accepted alone and refused once a long
 *     context joins it, so an implementation that sizes the audio alone goes red on the second
 *     half (AC2);
 *   · a hint the declaration does not acknowledge is NOT on the wire — checked as an absence of
 *     the text with a positive control that the acknowledged hint IS there, so a builder that
 *     sends nothing cannot pass by sending nothing (AC3).
 *
 * EVERY CASE IS DRIVEN PER WIRE, because every case above is a statement about a REQUEST and a
 * request only exists in some shape. A registered adapter declares which shape it speaks
 * (`AsrAdapter.wire`, absent meaning the inline one), and the case inputs and expectations are
 * derived from that declaration: what "past the budget" means (the audio's encoding on one wire,
 * its own bytes on the other), what a well-formed answer looks like, and how a recorded body is
 * read at all — a multipart body is a `FormData`, so reading it as "no body" would silently
 * disable every wire check rather than fail one. The declaration is therefore a second thing under
 * test: an adapter that declares one wire and sends another disagrees with the inputs its own
 * declaration implies. Each case is also namespaced by the provider it ran against, so with two
 * registered adapters no case can be satisfied by the other adapter's reading of it (AC8).
 *
 * ...AND ONE KIND OF ADAPTER SENDS NO REQUEST AT ALL, so "per wire" is not the whole vocabulary.
 * `AsrCapabilities.locality` says where the audio goes, and a provider that declares it stays on
 * this host (`'local-server'`, `'local-client'`) speaks no HTTP shape — it hands the bytes to
 * something running here. That declaration selects a SECOND case set (`NO_WIRE_CASES`, see
 * `runNoWireCases`) which measures the same guards one level down — the adapter's own byte ceiling,
 * the line between refused and let through, the budget covering the whole request — plus the reading
 * the wire set cannot take at all: the injected transport, the only way out of this module, is never
 * called. The branch is read off the declaration and never off a provider id, and which inventory a
 * provider owes follows from the same field, so a correct adapter of either kind is held to the list
 * its own declaration implies.
 *
 * THE VOCABULARY IS A TABLE WITH ONE ROW PER DECLARED WIRE (`WIRE_MODELS`), NOT A CLOSED SET WIDER
 * THAN IT. It used to be the latter — `wire === 'multipart' ? 'multipart' : 'inline-json'` — and
 * the fold was a defect with a live cost: a third adapter declaring `'chat-audio'` was scored as
 * `inline-json`, so the probe asked its request for the other wire's credential header, fed it the
 * other wire's answer envelope and sized it with the other wire's arithmetic. A CORRECT adapter
 * went red for a reason that was not its behaviour, which is exactly what this file's design
 * statement above forbids. Adding a row is now the whole cost of teaching the probe a shape, and a
 * declaration with no row is a named failure rather than a fold.
 *
 * OFFLINE IS ENFORCED, NOT ASSERTED (AC7). Every case injects its own transport, and the probe
 * also REPLACES `globalThis.fetch` with a poison for the duration: an adapter that reaches for the
 * ambient fetch instead of the injected one is caught by the poison rather than merely discouraged.
 *
 * AN EMPTY READING IS A FAILURE (AC8). A case whose outcome cannot be read — the adapter was not
 * resolvable out of the registry, or `transcribe` produced nothing readable — prints
 * `EMPTY_READING` and exits non-zero. "No problems were found" must never be indistinguishable
 * from "nothing was looked at".
 *
 * Usage:
 *   node scripts/asr-second-adapter-check.mjs [--root <dir>]
 *
 *   --root <dir>   the tree to check (default: this script's repository root). The falsification
 *                  controls point it at a throwaway tree assembled from the shipping files, which
 *                  is what makes each fake form below an executable case rather than a paragraph.
 *
 * Exit codes: 0 = every reading above held; 1 = at least one verdict failed (each failing verdict
 * prints its own `FAIL <TOKEN>` line before the readings).
 */

import { globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// Lets this bare-`node` entrypoint import the tree's `.ts` modules. Registered before any tree
// module is imported, because the very first thing the probe does is load the fixture's registry.
register();

/**
 * @typedef {{ ok: boolean, code: string|null, text: string|null }} Outcome a readable result
 * @typedef {{ token: string, detail: string }} Problem a failing verdict
 */

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * Readings are printed whether or not a verdict failed: a red run still has to show what was
 * measured, otherwise the failing token is the only thing a reader gets.
 */
class Ledger {
  constructor() {
    /** @type {string[]} */
    this.readings = [];
    /** @type {Problem[]} */
    this.problems = [];
    /** @type {Set<string>} */
    this.ran = new Set();
  }

  /**
   * @param {string} name
   * @param {unknown} value
   */
  record(name, value) {
    this.readings.push(`reading=${name} value=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  /**
   * @param {string} token
   * @param {string} detail
   */
  fail(token, detail) {
    this.problems.push({ token, detail });
  }

  /**
   * The structural half of AC8: every case this probe claims to run must have produced a reading.
   * A case that was skipped — because the adapter never resolved, or because the case above it
   * bailed out — is an empty reading, and an empty reading is not a pass.
   *
   * @param {string[]} expected
   */
  requireAll(expected) {
    for (const id of expected) {
      if (!this.ran.has(id)) {
        this.fail('EMPTY_READING', `case ${id} produced no reading at all — nothing about it was measured`);
      }
    }
  }
}

// ── arguments ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root needs a directory');
      root = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/asr-second-adapter-check.mjs [--root <dir>]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

// ── the offline guard ────────────────────────────────────────────────────────────────────────

/**
 * Replaces the ambient transport with a recorder that refuses to answer.
 *
 * Injected transports make a real call unlikely; this makes it impossible. An adapter that uses
 * `fetch` instead of `invocation.fetchImpl` reaches this and is recorded, which is the reading
 * AC7 asks for — the property "every environment dependency is injected" is what keeps the probe
 * offline, and this is how that property is measured rather than trusted.
 *
 * @returns {{ calls: string[], restore: () => void }}
 */
function installFetchPoison() {
  const original = globalThis.fetch;
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const poison = async (input) => {
    calls.push(String(input));
    throw new Error('the ambient fetch was used; every environment dependency must be injected');
  };
  globalThis.fetch = poison;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * One header as the stand-in recorded it, or `null` when the request does not carry it.
 *
 * Matched case-insensitively because header names are: the multipart wire writes `Authorization`
 * with a capital A, and a reader that compared raw keys would report the credential as absent on
 * the one wire that demonstrably sends it.
 *
 * @param {RequestInit|undefined} init
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(init, name) {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return null;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
    }
    return null;
  }
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  const record = /** @type {Record<string, string>} */ (headers);
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return String(record[key]);
  }
  return null;
}

// ── the wire vocabulary ──────────────────────────────────────────────────────────────────────

/**
 * The transcript a well-formed answer carries on EVERY wire, as one literal. A wire that has to
 * build its answer out of parts (`'inline-json'`) is the reason this is named rather than typed
 * four times: the parts join to this string, and the expectation below is this string.
 */
const TRANSCRIPT_TEXT = 'hello world';

/**
 * The code a recogniser this process runs answers with when no engine has been installed into it.
 *
 * It is the seam's own vocabulary (`AsrErrorCode`), and it is what an ACCEPTED request looks like
 * from here — the guards let it through and there is nothing on this host to run it. Spelled once,
 * so the no-wire cases and the failure they discriminate against (`OVERSIZE`, `UNSUPPORTED_MIME`)
 * cannot drift apart in three string literals.
 */
const ENGINE_UNAVAILABLE = 'ENGINE_UNAVAILABLE';

/**
 * @typedef {{ credentialHeader: string,
 *             audioCharge: 'raw' | 'encoded',
 *             audioMarker: 'file-part' | 'encoded',
 *             wellFormedAnswer: () => string }} WireModel
 */

/**
 * ONE ROW PER DECLARED WIRE, and the DECLARATION selects the row: no field below is reached for by
 * a provider id, which is what keeps `grep -c <provider-id> scripts/asr-second-adapter-check.mjs`
 * at zero. The four fields are the four things every case derives an input or an expectation from:
 *
 *   · `credentialHeader` — the header this wire announces its key under. A property of the
 *     protocol, not of the caller: a request that carries the credential under some other name is
 *     refused before its body is read, so the probe has to know which name is the right one.
 *   · `audioCharge` — what an audio of N bytes costs THIS wire's budget: its own bytes on a wire
 *     that uploads them (`'raw'`), the base64 encoding on a wire that inlines them (`'encoded'`).
 *     This is what puts the oversize and affordable inputs on the correct side of the line, and it
 *     is why "past the budget" is not one number across the vocabulary.
 *   · `audioMarker` — the form the recording takes inside the body. The hint group's POSITIVE
 *     CONTROL: an absence is only a reading if the request demonstrably carries something.
 *   · `wellFormedAnswer` — a body this wire's own parser must read back as `TRANSCRIPT_TEXT`.
 *     Handing one wire's answer to another reds the case for a reason that is not parsing.
 *
 * @type {Record<string, WireModel|undefined>}
 */
const WIRE_MODELS = {
  // The shipped `/audio/transcriptions` shape: a `FormData` body carrying the audio as a file part,
  // the service's own transcription object (`{"text": …}`) read back, the key in `Authorization`.
  multipart: {
    credentialHeader: 'authorization',
    audioCharge: 'raw',
    audioMarker: 'file-part',
    wellFormedAnswer: () => JSON.stringify({ text: TRANSCRIPT_TEXT }),
  },
  // The multimodal shape: the audio base64-encoded INTO the JSON generation request (`inlineData`),
  // so the budget is spent on the ENCODING; the answer is a generation envelope whose text parts
  // concatenate — the two below join to `TRANSCRIPT_TEXT`, which is asserted by the expectation.
  'inline-json': {
    credentialHeader: 'x-goog-api-key',
    audioCharge: 'encoded',
    audioMarker: 'encoded',
    wellFormedAnswer: () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
      }),
  },
  // The chat-completions shape (the third `AsrWire` member): the audio rides inside an
  // `input_audio` data URI in the user turn, the credential is a bearer token like the multipart
  // wire's rather than a key header, and the answer is the assistant turn's content — which is
  // itself the JSON object the recogniser asked the model for.
  //
  // WHAT THIS ROW'S `audioCharge` DELIBERATELY DOES NOT MODEL: this wire's request carries a frozen
  // prompt (~3 KB of UTF-8) that its own guard also pays for, and `'encoded'` is the MARGINAL cost
  // of the audio rather than the whole request. The omitted constant cannot move an input across a
  // budget this size — the affordable audio already sits at three quarters of it — and it is named
  // here so that a future budget small enough for the constant to matter is a deliberate change
  // rather than a silent one. The row is still declared rather than folded: `'encoded'` here is
  // this wire's own answer, checked against the adapter's arithmetic, not the inline wire's row
  // reached by a fallback.
  'chat-audio': {
    credentialHeader: 'authorization',
    audioCharge: 'encoded',
    audioMarker: 'encoded',
    wellFormedAnswer: () =>
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ transcript: TRANSCRIPT_TEXT, instruction: TRANSCRIPT_TEXT }),
            },
          },
        ],
      }),
  },
};

/**
 * The model for `wire`, or a throw when the declaration names a shape this probe has no row for.
 *
 * THROWING RATHER THAN FOLDING IS THE POINT OF THE TABLE. The fold is what this row set replaces:
 * a shape the probe cannot model, scored against one it can, produces readings about the wrong
 * request — and those readings are indistinguishable from readings about a defect. `runCases`
 * reports the same condition as a named `WIRE_NOT_MODELLED` failure before reaching here, so this
 * throw is the backstop for a call that skipped that check, not the reported path.
 *
 * @param {string} wire
 * @returns {WireModel}
 */
function wireModelFor(wire) {
  const model = WIRE_MODELS[wire];
  if (model === undefined) {
    throw new Error(
      `no model for wire '${wire}': this probe models ${Object.keys(WIRE_MODELS).join(', ')}, ` +
        'and a declaration it cannot model must not be scored against one it can',
    );
  }
  return model;
}

/**
 * The header `wire` carries the credential under.
 *
 * @param {string} wire
 * @returns {string}
 */
function credentialHeaderFor(wire) {
  return wireModelFor(wire).credentialHeader;
}

// ── the stand-in transport ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ calls: { url: string, init: RequestInit|undefined }[], fetchImpl: typeof fetch,
 *             count: () => number }} StandIn
 */

/**
 * @param {string} responseBody
 * @param {{ status?: number }} [options]
 * @returns {StandIn}
 */
function makeStandIn(responseBody, options = {}) {
  /** @type {{ url: string, init: RequestInit|undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init: init ?? undefined });
    return new Response(responseBody, {
      status: options.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl, count: () => calls.length };
}

/**
 * @param {StandIn} standIn
 * @returns {object} the injected invocation the adapter must use
 */
function invocationFor(standIn) {
  return {
    // `.invalid` is reserved and never resolves: even a defect that bypassed the stand-in could
    // not reach a real service from here.
    baseUrl: 'https://asr.invalid',
    apiKey: 'probe-key',
    model: 'probe-model',
    timeoutMs: 1000,
    fetchImpl: standIn.fetchImpl,
  };
}

// ── reading the tree ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} root
 * @param {string} pattern
 * @returns {string[]} repository-relative paths, `/`-separated, sorted
 */
function listFiles(root, pattern) {
  return globSync(pattern, { cwd: root })
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
}

/**
 * The registry is FOUND by its vocabulary, not by a path this file asserts: a hardcoded
 * `shared/asr/asrRegistry.ts` would keep "resolving" after the file moved, which is the one thing
 * a resolution check must not do.
 *
 * @param {string} root
 * @returns {string|null} repository-relative path of the module exporting `resolve`
 */
function findRegistry(root) {
  for (const relativePath of listFiles(root, 'shared/asr/*.ts')) {
    let source;
    try {
      source = readFileSync(path.join(root, relativePath), 'utf8');
    } catch {
      continue;
    }
    if (/export function resolve\s*\(/.test(source) && /export function listProviders\s*\(/.test(source)) {
      return relativePath;
    }
  }
  return null;
}

/**
 * Every provider module in the tree. The probe drives whichever ones it finds through the
 * REGISTRY — so a provider that exists on disk but is not registered is a failing resolution
 * reading, not a module this file quietly skips.
 *
 * @param {string} root
 * @returns {string[]} repository-relative paths
 */
function findProviderModules(root) {
  return listFiles(root, 'shared/asr/**/*.asr-provider.ts');
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {Promise<any>} the loaded module
 */
async function loadModule(root, relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href);
}

// ── the budget arithmetic (the probe's own copy, for cross-checking) ─────────────────────────

/**
 * The probe recomputes the encoded length itself rather than importing the adapter's helper: a
 * size check that borrowed the implementation's own arithmetic could not disagree with it.
 *
 * @param {number} byteLength
 * @returns {number}
 */
function base64Length(byteLength) {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * Whether this adapter's transcription reaches a wire at all, read off its own declaration.
 *
 * THE DECLARATION'S ANSWER, never a list of ids kept here — the same rule the wire vocabulary
 * follows. A provider that declares `locality: 'remote'` sends its bytes to a service, and every
 * case below is a statement about the request it sends: the header its key rides in, the body that
 * carries the audio, the answer envelope read back. A recogniser this process runs itself, over a
 * pipe to a model loaded on this host, sends no request — and asking the wire cases of it would
 * score an absent request against a golden body and report the absence as the defect.
 *
 * `'local-client'` COUNTS AS NO WIRE TOO, for the same reason: a recogniser the BROWSER runs reaches
 * no wire from here either.
 *
 * @param {any} adapter
 * @returns {boolean}
 */
function reachesAWire(adapter) {
  return adapter?.capabilities?.locality === 'remote';
}

/**
 * The margin an affordable audio leaves under a no-wire provider's budget.
 *
 * A margin rather than the exact bound: the case has to be a request the guard must NOT refuse, and
 * a size one byte under the line would make "the guard accepted it" and "the guard has an off-by-one"
 * the same reading. It is also what the context case is sized against — see `CONTEXT_PUSH_BYTES`.
 */
const AFFORDABLE_MARGIN_BYTES = 4096;

/**
 * The context a no-wire provider's request carries in the "is the budget the WHOLE request" case.
 *
 * Twice the margin above, so the case discriminates: a declaration that acknowledges the context
 * has it counted and this pushes the otherwise-affordable audio over the line, while a declaration
 * that acknowledges nothing must leave the request exactly where it was. A budget-sized string — what
 * the wire branch uses — is unnecessary here: for a provider that reaches no wire the hint's own
 * BYTES are the only thing that could matter, and tens of megabytes of transient allocation would buy
 * nothing.
 */
const CONTEXT_PUSH_BYTES = AFFORDABLE_MARGIN_BYTES * 2;

/**
 * A container the declaration accepts, so the size cases are refused (or not) for the reason they
 * are about rather than by the mime guard standing in front of them.
 *
 * Read out of the declaration rather than written in: the first entry a provider declares is by
 * construction one it accepts, and a written-in `'audio/webm;codecs=opus'` would red a provider that
 * legitimately narrowed its set.
 *
 * @param {any} capabilities
 * @returns {string}
 */
function firstDeclaredMime(capabilities) {
  const declared = capabilities?.acceptsMime;
  return Array.isArray(declared) && typeof declared[0] === 'string' ? declared[0] : 'application/octet-stream';
}

/**
 * What an audio of `byteLength` bytes costs the budget of a provider that reaches NO wire: its own
 * bytes.
 *
 * A named function rather than the identity inlined at the call site, because it is the second answer
 * to the question `measuredBytes` answers for a wire and the two must be read side by side: a
 * recogniser reached over a pipe never encodes the audio, so sizing its inputs with the inline wire's
 * base64 arithmetic would hand it an audio its own guard correctly accepts — and the reading would
 * report the guard working as the guard failing.
 *
 * @param {number} byteLength
 * @returns {number}
 */
function noWireMeasuredBytes(byteLength) {
  return byteLength;
}

/**
 * The wire an adapter declared, VERBATIM. The tag is optional on the contract and an absent one
 * means the inline shape, which is the same default the registry documents — read here rather than
 * inferred from the body, because a probe that scored an adapter against whatever it happened to
 * send could not notice an adapter that stopped sending what it declared.
 *
 * IT IS A PASSTHROUGH AND NOT A MAP. Folding the tag onto a smaller vocabulary here — the way this
 * function used to — decides the adapter's expectations before anything knows which shapes exist,
 * so a declaration the vocabulary has no row for is silently scored as one it has. Whether a tag is
 * modelled is `WIRE_MODELS`'s question, asked where the failure can be reported by name.
 *
 * @param {any} adapter
 * @returns {string}
 */
function wireOf(adapter) {
  const declared = adapter.wire;
  return declared === undefined || declared === null ? 'inline-json' : declared;
}

/**
 * The bytes THIS wire's budget accounting counts for an audio of `byteLength` bytes.
 *
 * THE BUDGET IS NOT SPENT BY THE SAME THING ON EVERY WIRE, so "past the budget" is not one number:
 * a wire that base64-encodes its audio spends the budget on the ENCODING (four characters per three
 * bytes), a wire that uploads the audio spends it on the audio's own bytes. WHICH ONE IS A FIELD OF
 * THE WIRE'S ROW (`audioCharge`) rather than a test against a wire name — the arithmetic follows
 * the declaration the same way the credential header and the answer envelope do, so a third shape
 * is sized by ITS OWN row instead of by the row the vocabulary happened to fold it onto. Each
 * quantity is derived independently of the adapter's own guard, so the pair of sizes below
 * straddles the line the adapter says it draws.
 *
 * @param {string} wire
 * @param {number} byteLength
 * @returns {number}
 */
function measuredBytes(wire, byteLength) {
  return wireModelFor(wire).audioCharge === 'raw' ? byteLength : base64Length(byteLength);
}

/**
 * An audio size that is past `budget` in this wire's arithmetic: the smallest size whose charge
 * exceeds the budget (one byte over on a raw-charging wire; the base64 encoding of that on an
 * encoding-charging one).
 * @param {string} wire
 * @param {number} budget
 * @returns {number}
 */
function oversizeAudioBytes(wire, budget) {
  return wireModelFor(wire).audioCharge === 'raw'
    ? budget + 1
    : Math.ceil((budget + 1) / 4) * 3;
}

/**
 * An audio size well inside `budget` in this wire's arithmetic, leaving room for the request's
 * skeleton and for a context that is meant to push it over: three quarters of the budget, inverted
 * back through the wire's own charge.
 * @param {string} wire
 * @param {number} budget
 * @returns {number}
 */
function affordableAudioBytes(wire, budget) {
  return wireModelFor(wire).audioCharge === 'raw'
    ? Math.floor(budget * 0.75)
    : Math.floor((budget * 0.75) / 4) * 3;
}

/**
 * The request body as a comparable string, in whatever shape the wire sent it.
 *
 * A multipart body MUST NOT be read as "no body". The hint checks below search this string for the
 * hints' text, so recording a `FormData` as empty would make every "the unacknowledged hint is not
 * on the wire" reading pass by measuring nothing — the same fault this probe exists to catch, one
 * level down. The rendering carries field names, values and a file part's name and SIZE; never the
 * file's bytes, which is what keeps it a reading about the wire rather than a copy of the audio.
 *
 * @param {unknown} body
 * @returns {string}
 */
function renderBody(body) {
  if (typeof body === 'string') return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    /** @type {string[]} */
    const parts = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push(`${name}=${value}`);
        continue;
      }
      const part = /** @type {{ name?: unknown, type?: unknown, size?: unknown }} */ (value);
      parts.push(
        `${name}:<file name=${String(part?.name ?? '')} type=${String(part?.type ?? '')} size=${Number(part?.size ?? 0)}B>`,
      );
    }
    return parts.join('&');
  }
  return '';
}

/**
 * The audio as THIS wire carries it, as a substring of the rendered body.
 *
 * This is the hint group's POSITIVE CONTROL, and it is why the group is not satisfied by a builder
 * that puts nothing anywhere: "the unacknowledged prompt is absent" is only a reading if the
 * request carries something the absence can be told apart from. The FORM is the wire's own row
 * (`audioMarker`) and the value is computed here rather than read off the adapter — a wire that
 * uploads the recording names the part's size, a wire that inlines it carries the base64 of the
 * audio's bytes — so the marker cannot agree with the adapter by construction.
 *
 * @param {string} wire
 * @param {number} byteLength
 * @returns {string}
 */
function audioMarker(wire, byteLength) {
  if (wireModelFor(wire).audioMarker === 'file-part') return `size=${byteLength}B`;
  return Buffer.from(new Uint8Array(byteLength)).toString('base64');
}

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} result
 * @returns {Outcome|null} null when nothing readable came back — an empty reading, not a pass
 */
function readOutcome(result) {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = /** @type {{ ok?: unknown, code?: unknown, text?: unknown }} */ (result);
  if (typeof candidate.ok !== 'boolean') return null;
  return {
    ok: candidate.ok,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
  };
}

/**
 * @param {any} adapter
 * @param {any} request
 * @param {any} invocation
 * @param {Ledger} ledger
 * @param {string} caseId
 * @returns {Promise<Outcome|null>}
 */
async function callAdapter(adapter, request, invocation, ledger, caseId) {
  let result;
  try {
    result = await adapter.transcribe(request, invocation);
  } catch (error) {
    ledger.fail('CASE_THREW', `${caseId}: transcribe threw ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const outcome = readOutcome(result);
  if (outcome === null) {
    ledger.fail(
      'EMPTY_READING',
      `${caseId}: transcribe returned nothing readable (${JSON.stringify(result) ?? 'undefined'}) — an unreadable outcome is not a pass`,
    );
    return null;
  }
  ledger.ran.add(caseId);
  return outcome;
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────

const NON_ENVELOPE_JSON_BODY = JSON.stringify({ error: { code: 429, message: 'quota exceeded' } });
const NON_JSON_BODY = '<html><body>502 Bad Gateway</body></html>';

/**
 * The response-parse baseline, one case per body shape, PER WIRE.
 *
 * "Not this service's answer" is the same reading on every wire — a body that is not this
 * service's JSON is a failed transcription, never the transcript. "A well-formed answer" IS NOT:
 * a generation envelope whose text parts concatenate on one wire, the transcription object's own
 * `text` field on another, the assistant turn of a chat completion carrying a JSON object on the
 * third — so the first case's body comes from the wire's own row rather than being shared. Handing
 * one wire's answer to another would red the case for a reason that has nothing to do with parsing.
 *
 * @param {string} wire
 * @returns {{ id: string, body: string, expectOk: boolean, expectText: string|null }[]}
 */
const RESPONSE_CASE_SHAPES = [
  { id: 'response-envelope', expectOk: true, expectText: TRANSCRIPT_TEXT },
  { id: 'response-non-envelope-json', expectOk: false, expectText: null },
  { id: 'response-non-json', expectOk: false, expectText: null },
];

/**
 * @param {string} wire
 * @returns {{ id: string, body: string, expectOk: boolean, expectText: string|null }[]}
 */
function responseCases(wire) {
  /** @type {Record<string, string>} */
  const bodies = {
    'response-envelope': wireModelFor(wire).wellFormedAnswer(),
    'response-non-envelope-json': NON_ENVELOPE_JSON_BODY,
    'response-non-json': NON_JSON_BODY,
  };
  return RESPONSE_CASE_SHAPES.map((shape) => ({ ...shape, body: bodies[shape.id] }));
}

/**
 * Every case this probe claims to run. The list is the probe's own inventory, not a claim about
 * the tree: a case on it that produced no reading is exactly the "empty reading" AC8 refuses to
 * read as green, and the inventory is what makes "it did not run" distinguishable from "it ran and
 * found nothing".
 */
const EXPECTED_CASES = [
  'oversize-refused',
  'budget-audio-alone',
  'budget-audio-plus-context',
  'hints-on-the-wire',
  ...RESPONSE_CASE_SHAPES.map((responseCase) => responseCase.id),
];

/**
 * The cases a provider that reaches NO WIRE is scored on, and the inventory `requireAll` holds it to.
 *
 * THE THREE OVERLAPPING IDS ARE THE SAME THREE INVARIANTS, not a copy of the wire branch's list: the
 * budget is a line the adapter draws for itself, an affordable request is not refused, and the budget
 * covers the WHOLE request rather than the audio alone. What changes is the reading an ACCEPTED
 * request produces — there is no wire to carry it, so it comes back as the engine's absence — and
 * that difference is asserted in exactly one place below rather than smuggled into the ids.
 *
 * The fourth id is this branch's own, and it is the reading the wire branch cannot take: the audio
 * leaves this host zero times. `audio-stays-on-host` is therefore NOT in `EXPECTED_CASES` — a remote
 * provider is never asked for it, and a local one is never let off it.
 */
const NO_WIRE_CASES = [
  'oversize-refused',
  'budget-audio-alone',
  'budget-audio-plus-context',
  'audio-stays-on-host',
];

/**
 * The positive control for the hint rules: a text that IS acknowledged must reach the wire. It is
 * the same request as the prompt case with the one hint the declaration accepts, so "the prompt is
 * absent" cannot be satisfied by a builder that puts nothing anywhere.
 */
const CONTEXT_TEXT = 'quarterly revenue recognition policy';

/**
 * @param {any} adapter the adapter resolved out of the registry
 * @param {any} capabilities that adapter's declaration
 * @param {Ledger} ledger
 * @param {string} providerId the id the adapter is registered under. Every reading and every case
 *   id below is namespaced by it, so with more than one registered adapter "case X ran" is a claim
 *   about one provider rather than about the run as a whole — otherwise a case one adapter skipped
 *   would be satisfied by another adapter's reading of it.
 */
async function runCases(adapter, capabilities, ledger, providerId) {
  /** @param {string} id @returns {string} */
  const scoped = (id) => `${providerId}:${id}`;
  const reachesTransport = reachesAWire(adapter);
  const wire = wireOf(adapter);
  const budget = capabilities.maxInlineRequestBytes;
  ledger.record(scoped('reaches-a-wire'), reachesTransport);
  ledger.record(scoped('wire'), reachesTransport ? wire : 'none');
  // A declaration the vocabulary has no row for is an EMPTY READING, not a green one. Every case
  // below is an expectation about a request that exists in the declared shape, so scoring an
  // unmodelled shape against a modelled one would measure a request nobody sent — the fault the
  // `WIRE_MODELS` table exists to remove. Reported by name and then stopped, which leaves the cases
  // un-run and therefore `EMPTY_READING` below: "nothing was looked at" stays distinguishable.
  //
  // ASKED ONLY OF A PROVIDER THAT REACHES A WIRE. A recogniser this process runs speaks no shape at
  // all, so it has no tag to model and no `wireOf` default to be folded onto — its cases are the
  // no-wire set below, which reads the declaration's locality and never its wire.
  if (reachesTransport && WIRE_MODELS[wire] === undefined) {
    ledger.fail(
      'WIRE_NOT_MODELLED',
      `'${providerId}' declares wire '${wire}', which this probe has no model for (it models ` +
        `${Object.keys(WIRE_MODELS).join(', ')}) — a shape nothing here describes cannot be scored, ` +
        'and folding it onto a modelled one would score the request against a vocabulary it does not speak',
    );
    return;
  }
  const transcriptBody = reachesTransport ? responseCases(wire)[0].body : '';
  ledger.record(scoped('budget-bytes'), budget);

  // ── AC6: the declaration is a real one, with every field present and of the declared kind ──
  //
  // `tokens` and `locality` are on this list because they are the two the recognisers DIFFER on —
  // the per-token promise, and where the audio goes — and a declaration that dropped either would
  // otherwise be measured by nothing at all: the wire cases read the rest of the declaration, and
  // this loop is what makes a missing field a named failure rather than a silent `undefined`.
  for (const field of ['acceptsMime', 'maxInlineRequestBytes', 'oversize', 'honors', 'billing', 'pauseCues', 'style', 'oneShot', 'tokens', 'locality']) {
    ledger.record(scoped(`capabilities.${field}`), capabilities[field]);
    if (capabilities[field] === undefined) {
      ledger.fail('CAPABILITIES_MISSING_FIELD', `the resolved declaration for '${providerId}' has no '${field}'`);
    }
  }
  ledger.record(scoped('capabilities.acceptsMime.length'), capabilities.acceptsMime?.length ?? 0);

  // ── AC5: oversize is a declared rejection, taken before anything leaves ───────────────────
  ledger.record(scoped('oversize-policy'), capabilities.oversize);
  if (capabilities.oversize !== 'reject') {
    ledger.fail(
      'OVERSIZE_POLICY_NOT_REJECT',
      `'${providerId}' declares oversize='${String(capabilities.oversize)}'; the first version only allows 'reject' — an over-budget request must be refused here, not handed to the service to refuse`,
    );
  }

  // ── the branch: the cases above are statements about a request, and only a provider that sends
  //    one has any. The no-wire set measures the same guards one level down, plus the property the
  //    wire branch cannot state: the audio never leaves. ─────────────────────────────────────
  if (!reachesTransport) {
    await runNoWireCases(adapter, capabilities, ledger, providerId, budget);
    return;
  }

  // ── AC1: over budget ⇒ OVERSIZE, and the stand-in's counter must read zero ────────────────
  const oversizeBytes = oversizeAudioBytes(wire, budget);
  ledger.record(scoped('oversize-audio-bytes'), oversizeBytes);
  ledger.record(scoped('oversize-encoded-bytes'), base64Length(oversizeBytes));
  ledger.record(scoped('oversize-measured-bytes'), measuredBytes(wire, oversizeBytes));
  if (measuredBytes(wire, oversizeBytes) <= budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `'${providerId}': the oversize input no longer exceeds the declared budget of ${budget} B in the ${wire} wire's arithmetic`,
    );
  }
  const oversizeStandIn = makeStandIn(transcriptBody);
  const oversizeOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(oversizeBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'oversize.webm' },
    },
    invocationFor(oversizeStandIn),
    ledger,
    scoped('oversize-refused'),
  );
  if (oversizeOutcome !== null) {
    ledger.record(scoped('oversize-code'), oversizeOutcome.code);
    ledger.record(scoped('oversize-calls'), oversizeStandIn.count());
    if (oversizeOutcome.ok || oversizeOutcome.code !== 'OVERSIZE') {
      ledger.fail(
        'OVERSIZE_NOT_REJECTED',
        `'${providerId}': an over-budget request returned ${JSON.stringify(oversizeOutcome)} instead of a failure with code OVERSIZE`,
      );
    }
    if (oversizeStandIn.count() !== 0) {
      ledger.fail(
        'OVERSIZE_NOT_ZERO_REQUEST',
        `'${providerId}': an over-budget request was refused but still cost ${oversizeStandIn.count()} upstream call(s) — the guard runs after the transport, so the bytes left`,
      );
    }
  }

  // ── AC2: the budget is the WHOLE REQUEST — the same audio passes alone and fails with a
  //        long context beside it. Sizes are derived from the declared budget rather than
  //        typed in, so a declaration that shrinks moves the control with it.
  const affordableBytes = affordableAudioBytes(wire, budget);
  const contextText = 'x'.repeat(budget);
  const contextHonored = capabilities.honors?.context === true;
  ledger.record(scoped('affordable-audio-bytes'), affordableBytes);
  ledger.record(scoped('affordable-encoded-bytes'), base64Length(affordableBytes));
  ledger.record(scoped('affordable-measured-bytes'), measuredBytes(wire, affordableBytes));
  ledger.record(scoped('context-bytes'), contextText.length);
  ledger.record(scoped('context.honored'), contextHonored);
  if (measuredBytes(wire, affordableBytes) + 1024 > budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `'${providerId}': the 'affordable' input already fills the declared budget of ${budget} B in the ${wire} wire's arithmetic, so the pair below would prove nothing`,
    );
  }

  const aloneStandIn = makeStandIn(transcriptBody);
  const aloneOutcome = await callAdapter(
    adapter,
    { audio: { bytes: new Uint8Array(affordableBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'alone.webm' } },
    invocationFor(aloneStandIn),
    ledger,
    scoped('budget-audio-alone'),
  );
  if (aloneOutcome !== null) {
    ledger.record(scoped('budget-audio-alone-ok'), aloneOutcome.ok);
    ledger.record(scoped('budget-audio-alone-calls'), aloneStandIn.count());
    if (!aloneOutcome.ok || aloneStandIn.count() !== 1) {
      ledger.fail(
        'AUDIO_ALONE_REFUSED',
        `'${providerId}': an audio well inside the budget was not sent (${JSON.stringify(aloneOutcome)}, ${aloneStandIn.count()} call(s)) — the pair below can only show the budget is request-level if this half is accepted`,
      );
    }
  }

  const withContextStandIn = makeStandIn(transcriptBody);
  const withContextOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(affordableBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'with-context.webm' },
      hints: { context: contextText },
    },
    invocationFor(withContextStandIn),
    ledger,
    scoped('budget-audio-plus-context'),
  );
  if (withContextOutcome !== null) {
    ledger.record(scoped('budget-audio-plus-context-code'), withContextOutcome.code);
    ledger.record(scoped('budget-audio-plus-context-calls'), withContextStandIn.count());
    if (contextHonored) {
      if (withContextOutcome.ok || withContextOutcome.code !== 'OVERSIZE') {
        ledger.fail(
          'BUDGET_IS_AUDIO_ONLY',
          `'${providerId}': the same audio that was accepted alone returned ${JSON.stringify(withContextOutcome)} once ${contextText.length} B of context joined it — the budget is being measured on the audio instead of on the whole request`,
        );
      }
      if (withContextStandIn.count() !== 0) {
        ledger.fail(
          'OVERSIZE_NOT_ZERO_REQUEST',
          `'${providerId}': the request that exceeded the budget after its context was added still cost ${withContextStandIn.count()} upstream call(s)`,
        );
      }
    } else if (!withContextOutcome.ok || withContextStandIn.count() !== 1) {
      // THE MIRROR READING, and the same invariant seen from the other side of the declaration. A
      // hint the declaration does not acknowledge is not sent — so its bytes are not on the request
      // and must not be counted against the budget either. An adapter that drops the context but
      // still sizes it refuses an upload the service would have accepted, which is the defect this
      // group names, read from the direction the honoring provider cannot show it from.
      ledger.fail(
        'UNHONORED_HINT_COUNTED_AGAINST_BUDGET',
        `'${providerId}': the same audio that was accepted alone returned ${JSON.stringify(withContextOutcome)} once a context the declaration does not acknowledge joined it (${withContextStandIn.count()} call(s)) — an unacknowledged hint is left off the wire, so it cannot be what pushes a request over the budget`,
      );
    }
  }

  // ── AC3: a hint the declaration does not acknowledge is NOT on the wire ───────────────────
  const PROMPT_TEXT = 'biasing prompt for the probe';
  const hintAudioBytes = 2048;
  const hintsStandIn = makeStandIn(transcriptBody);
  const hintsOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(hintAudioBytes), mimeType: 'audio/webm;codecs=opus', fileName: 'hints.webm' },
      hints: { prompt: PROMPT_TEXT, language: 'zh', context: CONTEXT_TEXT },
    },
    invocationFor(hintsStandIn),
    ledger,
    scoped('hints-on-the-wire'),
  );
  if (hintsOutcome !== null) {
    const call = hintsStandIn.calls[0];
    const rawBody = renderBody(call?.init?.body);
    ledger.record(scoped('hints-calls'), hintsStandIn.count());
    ledger.record(scoped('hints-body-bytes'), rawBody.length);
    if (rawBody.length === 0) {
      ledger.fail(
        'CASE_INPUT_STALE',
        `'${providerId}': the stand-in received a body this probe cannot render as a wire (${typeof call?.init?.body}), so the hint checks below cannot read one`,
      );
    } else {
      // THE POSITIVE CONTROL FOR THE GROUP, and it is read first: whatever else is left off, the
      // request carries the audio in the wire's own form. Without it, a builder that put nothing on
      // the wire at all would satisfy every absence below — the same "an inert implementation
      // passes" fault the whole probe exists to refuse, one case down.
      const marker = audioMarker(wire, hintAudioBytes);
      const audioPresent = rawBody.includes(marker);
      ledger.record(scoped('hints.audio.on-the-wire'), audioPresent);
      if (!audioPresent) {
        ledger.fail(
          'HINT_CONTROL_ABSENT',
          `'${providerId}': the audio is not on the request in the ${wire} wire's own form, so the absences below could be satisfied by a request that carries nothing at all`,
        );
      }
      // The credential's HEADER is a wire property, and it is read beside the hints because it
      // decides whether any of this reaches the service at all: measured against the live service,
      // a key sent as `Authorization: Bearer` is answered with a 401 naming OAuth 2 before the body
      // is read. Read by the wire's declared name rather than by a name written in here, so the
      // multipart wire is still read under `Authorization` and the generation wire under the header
      // it actually declares.
      const credentialHeader = credentialHeaderFor(wire);
      const announced = headerValue(call?.init, credentialHeader);
      ledger.record(scoped('credential.header-name'), credentialHeader);
      ledger.record(scoped('credential.on-the-wire'), announced !== null && announced !== '');
      if (announced === null || announced === '') {
        ledger.fail(
          'CREDENTIAL_NOT_ON_WIRE',
          `'${providerId}': a configured key is not on the request under '${credentialHeader}', the header this wire declares — such a request is refused before its body is read`,
        );
      }
      // The other half of the reading, and it is the one that caught the live defect: the credential
      // must not ALSO travel in a header this wire does not declare. A request that announced the
      // key in two places would keep passing a one-sided check while the service read neither.
      const otherHeader = credentialHeader === 'authorization' ? 'x-goog-api-key' : 'authorization';
      const stray = headerValue(call?.init, otherHeader);
      ledger.record(scoped('credential.stray-header'), stray !== null);
      if (stray !== null) {
        ledger.fail(
          'UNEXPECTED_CREDENTIAL_HEADER',
          `'${providerId}': the request announces the credential in '${otherHeader}', which the '${wire}' wire does not declare — the credential has one declared home per wire`,
        );
      }
      for (const hint of ['prompt', 'language']) {
        const honored = capabilities.honors?.[hint] === true;
        const present = rawBody.includes(hint === 'prompt' ? PROMPT_TEXT : 'zh');
        ledger.record(scoped(`hints.${hint}.honored`), honored);
        ledger.record(scoped(`hints.${hint}.text-present`), present);
        if (!honored && present) {
          ledger.fail(
            hint === 'prompt' ? 'PROMPT_SENT' : 'UNHONORED_HINT_SENT',
            `'${providerId}': the declaration says honors.${hint}=false, but the value is in the request body — an unacknowledged hint must not be sent at all (not sent as an empty value either)`,
          );
        }
      }
      // The other half: what IS acknowledged must be there, so the absences above cannot be
      // satisfied by an adapter that sends only the audio.
      const contextPresent = rawBody.includes(CONTEXT_TEXT);
      ledger.record(scoped('hints.context.text-present'), contextPresent);
      if (capabilities.honors?.context === true && !contextPresent) {
        ledger.fail(
          'ACKNOWLEDGED_HINT_ABSENT',
          `'${providerId}': the declaration acknowledges context, but the context text is absent from the body — the absence of the prompt above would otherwise be satisfied by a builder that sends nothing`,
        );
      }
    }
  }

  // ── AC4: the response-parse baseline, one case per body shape ─────────────────────────────
  for (const responseCase of responseCases(wire)) {
    const standIn = makeStandIn(responseCase.body);
    const outcome = await callAdapter(
      adapter,
      { audio: { bytes: new Uint8Array(1024), mimeType: 'audio/webm;codecs=opus', fileName: 'response.webm' } },
      invocationFor(standIn),
      ledger,
      scoped(responseCase.id),
    );
    if (outcome === null) continue;
    ledger.record(scoped(`${responseCase.id}-ok`), outcome.ok);
    ledger.record(scoped(`${responseCase.id}-text`), outcome.text ?? '<none>');
    if (responseCase.expectOk) {
      if (!outcome.ok || outcome.text !== responseCase.expectText) {
        ledger.fail(
          'ENVELOPE_NOT_READ',
          `'${providerId}' ${responseCase.id}: a well-formed answer read as ${JSON.stringify(outcome)} instead of '${String(responseCase.expectText)}'`,
        );
      }
    } else if (outcome.ok) {
      ledger.fail(
        'LOOSE_RESPONSE_PARSE',
        `'${providerId}' ${responseCase.id}: a body that is not this service's answer was returned as a transcript (${JSON.stringify(outcome.text)}) — the whole response must never stand in for the text`,
      );
    }
  }
}

// ── the no-wire cases ────────────────────────────────────────────────────────────────────────

/**
 * The cases a provider that reaches NO WIRE can honestly be scored on.
 *
 * WHY THIS IS A SEPARATE SET AND NOT A FLAG INSIDE `runCases`. Every case in the wire set is a claim
 * about a REQUEST — which header the key rides in, what the body carries, what the answer envelope
 * parses to, whether a hint's text is on the wire — and a recogniser reached over a pipe to a local
 * process has no request at all. Driving the wire set against it would produce a page of reds that
 * describe the SHAPE OF THE SEAM rather than a defect in the adapter, which is exactly what this
 * probe's own design statement forbids. Three of the wire set's four groups survive the absence and
 * are read here in the provider's own terms; the fourth (`hints-on-the-wire`, a statement about a
 * body) has no honest reading and is not asked for.
 *
 * WHAT IS MEASURED, one mechanical reading each:
 *
 *   · the guards still run, and they still run FIRST — an over-budget request is refused with code
 *     OVERSIZE and costs the injected transport nothing (AC1's invariant, one level down: the
 *     adapter's own bytes are the charge, because nothing encodes them);
 *   · the guards are a LINE, not a wall — an audio just inside the declared budget is NOT refused;
 *   · the budget covers the WHOLE request, read from both sides of the `honors` declaration exactly
 *     as the wire branch reads it;
 *   · the audio leaves this host zero times — the count on the injected transport, which is the only
 *     way out of this module. THIS IS THE ONE READING THE WIRE BRANCH CANNOT TAKE, and it is the
 *     whole promise `locality: 'local-server'` makes.
 *
 * AN ACCEPTED REQUEST READS AS THE ENGINE'S ABSENCE. This probe installs no engine — it is the
 * operator check, and the thing under test is the adapter, not a host's model — so a request the
 * guards let through comes back as `ENGINE_UNAVAILABLE` with zero calls. That is a DIFFERENT reading
 * from a refusal (`OVERSIZE`, `UNSUPPORTED_MIME`), which is the whole discrimination these cases
 * need: if the guard wrongly refused the affordable audio, the code says which guard did it.
 *
 * @param {any} adapter
 * @param {any} capabilities
 * @param {Ledger} ledger
 * @param {string} providerId
 * @param {number} budget
 */
async function runNoWireCases(adapter, capabilities, ledger, providerId, budget) {
  /** @param {string} id @returns {string} */
  const scoped = (id) => `${providerId}:${id}`;
  const mimeType = firstDeclaredMime(capabilities);
  ledger.record(scoped('mime-type-used'), mimeType);

  // ── the guard is the adapter's OWN ceiling, drawn in the bytes themselves ───────────────────
  const oversizeBytes = budget + 1;
  const oversizeStandIn = makeStandIn('');
  ledger.record(scoped('oversize-audio-bytes'), oversizeBytes);
  ledger.record(scoped('oversize-measured-bytes'), noWireMeasuredBytes(oversizeBytes));
  if (noWireMeasuredBytes(oversizeBytes) <= budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `'${providerId}': the oversize input no longer exceeds the declared budget of ${budget} B in the arithmetic a provider that reaches no wire uses — the bytes themselves`,
    );
  }
  const oversizeOutcome = await callAdapter(
    adapter,
    { audio: { bytes: new Uint8Array(oversizeBytes), mimeType, fileName: 'oversize.wav' } },
    invocationFor(oversizeStandIn),
    ledger,
    scoped('oversize-refused'),
  );
  if (oversizeOutcome !== null) {
    ledger.record(scoped('oversize-code'), oversizeOutcome.code);
    ledger.record(scoped('oversize-calls'), oversizeStandIn.count());
    if (oversizeOutcome.ok || oversizeOutcome.code !== 'OVERSIZE') {
      ledger.fail(
        'OVERSIZE_NOT_REJECTED',
        `'${providerId}': an over-budget request returned ${JSON.stringify(oversizeOutcome)} instead of a failure with code OVERSIZE — this adapter sets its own ceiling, so nothing downstream will refuse it`,
      );
    }
    if (oversizeStandIn.count() !== 0) {
      ledger.fail(
        'OVERSIZE_NOT_ZERO_REQUEST',
        `'${providerId}': an over-budget request cost ${oversizeStandIn.count()} transport call(s) — the guard runs after the bytes are handed on, so they left`,
      );
    }
  }

  // ── the same audio, just inside the line: NOT refused ───────────────────────────────────────
  const affordableBytes = Math.max(1, budget - AFFORDABLE_MARGIN_BYTES);
  const contextText = 'x'.repeat(CONTEXT_PUSH_BYTES);
  const contextHonored = capabilities.honors?.context === true;
  ledger.record(scoped('affordable-audio-bytes'), affordableBytes);
  ledger.record(scoped('affordable-measured-bytes'), noWireMeasuredBytes(affordableBytes));
  ledger.record(scoped('context-bytes'), contextText.length);
  ledger.record(scoped('context.honored'), contextHonored);
  // EACH HALF'S PREMISE IS CHECKED WHERE IT IS USED, rather than one guard for both. The affordable
  // input must be inside the budget, or "it was not refused" would say nothing; and if the
  // declaration acknowledges the context, the context must be able to push that same audio over, or
  // the honored half of the pair would be measuring a request that never crossed the line.
  if (noWireMeasuredBytes(affordableBytes) >= budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `'${providerId}': the 'affordable' input is not inside the declared budget of ${budget} B in the arithmetic a provider that reaches no wire uses, so the pair below would prove nothing`,
    );
  }
  if (contextHonored && noWireMeasuredBytes(affordableBytes) + CONTEXT_PUSH_BYTES <= budget) {
    ledger.fail(
      'CASE_INPUT_STALE',
      `'${providerId}': the declaration acknowledges the context, but this case's context (${CONTEXT_PUSH_BYTES} B) cannot push the affordable audio past the declared budget of ${budget} B — the case would pass for a request that never crossed the line`,
    );
  }

  const aloneStandIn = makeStandIn('');
  const aloneOutcome = await callAdapter(
    adapter,
    { audio: { bytes: new Uint8Array(affordableBytes), mimeType, fileName: 'alone.wav' } },
    invocationFor(aloneStandIn),
    ledger,
    scoped('budget-audio-alone'),
  );
  if (aloneOutcome !== null) {
    ledger.record(scoped('budget-audio-alone-code'), aloneOutcome.code);
    ledger.record(scoped('budget-audio-alone-calls'), aloneStandIn.count());
    if (aloneOutcome.ok || aloneOutcome.code !== ENGINE_UNAVAILABLE) {
      ledger.fail(
        'AUDIO_ALONE_REFUSED',
        `'${providerId}': an audio inside the declared budget was not let through the guards (${JSON.stringify(aloneOutcome)}, ${aloneStandIn.count()} call(s)) — expected the engine's own absence, since this probe installs none; OVERSIZE or UNSUPPORTED_MIME here means the guard refused a request it declares it accepts`,
      );
    }
  }

  // ── the budget is the WHOLE request, read from both sides of the declaration ────────────────
  const withContextStandIn = makeStandIn('');
  const withContextOutcome = await callAdapter(
    adapter,
    {
      audio: { bytes: new Uint8Array(affordableBytes), mimeType, fileName: 'with-context.wav' },
      hints: { context: contextText },
    },
    invocationFor(withContextStandIn),
    ledger,
    scoped('budget-audio-plus-context'),
  );
  if (withContextOutcome !== null) {
    ledger.record(scoped('budget-audio-plus-context-code'), withContextOutcome.code);
    ledger.record(scoped('budget-audio-plus-context-calls'), withContextStandIn.count());
    if (contextHonored) {
      if (withContextOutcome.ok || withContextOutcome.code !== 'OVERSIZE') {
        ledger.fail(
          'BUDGET_IS_AUDIO_ONLY',
          `'${providerId}': the same audio that was let through alone returned ${JSON.stringify(withContextOutcome)} once ${contextText.length} B of context joined it — the declaration acknowledges the context, so the budget is the whole request and the context is what pushed it over`,
        );
      }
    } else if (withContextOutcome.ok || withContextOutcome.code !== ENGINE_UNAVAILABLE) {
      // The mirror reading: a hint the declaration does not acknowledge is not handed to the engine
      // and its bytes are not counted against the budget either. An adapter that sized a hint it
      // never sends would refuse a recording this host can transcribe.
      ledger.fail(
        'UNHONORED_HINT_COUNTED_AGAINST_BUDGET',
        `'${providerId}': the same audio that was let through alone returned ${JSON.stringify(withContextOutcome)} once a context the declaration does not acknowledge joined it — an unacknowledged hint is not part of the request, so it cannot be what pushes the request over the budget`,
      );
    }
  }

  // ── the property the wire branch cannot state: the audio never leaves this host ─────────────
  const hostStandIn = makeStandIn('');
  const hostOutcome = await callAdapter(
    adapter,
    { audio: { bytes: new Uint8Array(2048), mimeType, fileName: 'stays.wav' } },
    invocationFor(hostStandIn),
    ledger,
    scoped('audio-stays-on-host'),
  );
  if (hostOutcome !== null) {
    ledger.record(scoped('audio-stays-on-host.code'), hostOutcome.code);
    ledger.record(scoped('audio-stays-on-host.transport-calls'), hostStandIn.count());
    if (hostStandIn.count() !== 0) {
      ledger.fail(
        'AUDIO_LEFT_THE_HOST',
        `'${providerId}' declares locality='${String(capabilities.locality)}', but transcribing one clip cost the injected transport ${hostStandIn.count()} call(s) — the transport is the only way out of this module, so the recording left the machine the declaration says it never leaves`,
      );
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} the process exit code */
async function main() {
  /** @type {{ root: string }} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const root = options.root;
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    process.stdout.write(`root is not a directory: ${root}\n`);
    return 1;
  }

  const ledger = new Ledger();
  const poison = installFetchPoison();
  /** @type {string[]} */
  const header = [`asr-second-adapter-check root=${root}`];

  try {
    const registryPath = findRegistry(root);
    header.push(`registry=${registryPath ?? '<none>'}`);
    if (registryPath === null) {
      ledger.fail('REGISTRY_UNRESOLVED', `no module under shared/asr/ exports both listProviders and resolve`);
    }

    const providerPaths = findProviderModules(root);
    header.push(`provider-modules=${providerPaths.length}`);
    for (const providerPath of providerPaths) header.push(`  provider-module=${providerPath}`);
    if (providerPaths.length === 0) {
      ledger.fail('PROVIDER_MODULE_UNRESOLVED', 'no *.asr-provider.ts module exists under shared/asr/');
    }

    if (registryPath !== null) {
      const registry = await loadModule(root, registryPath);
      /** @type {any[]} */
      const registered = registry.listProviders();
      header.push(`registered=${registered.map((adapter) => adapter.id).join(',') || '<none>'}`);
      ledger.record('registered-count', registered.length);
      if (registered.length === 0) {
        ledger.fail('ADAPTER_UNRESOLVED', 'the registry hands out no adapter at all');
      }

      // AC6 — every provider module on disk must be resolvable out of the registry BY ID, and the
      // declaration the registry hands back must be the one the module exports, field for field.
      for (const providerPath of providerPaths) {
        const providerModule = await loadModule(root, providerPath);
        const providerId = providerModule.id;
        ledger.record(`provider-module.${providerPath}.id`, providerId);

        let resolved;
        try {
          resolved = registry.resolve(providerId);
        } catch (error) {
          ledger.fail(
            'ADAPTER_UNRESOLVED',
            `${providerPath} declares id '${String(providerId)}' but the registry does not resolve it: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        ledger.record(`resolve(${String(providerId)}).id`, resolved.id);
        if (resolved.id !== providerId) {
          ledger.fail('CAPABILITIES_MISMATCH', `resolve('${String(providerId)}') returned id '${String(resolved.id)}'`);
        }

        const declaredKeys = new Set([...Object.keys(providerModule.capabilities ?? {}), ...Object.keys(resolved.capabilities ?? {})]);
        for (const key of [...declaredKeys].sort()) {
          const fromModule = JSON.stringify(providerModule.capabilities?.[key]);
          const fromRegistry = JSON.stringify(resolved.capabilities?.[key]);
          ledger.record(`resolve(${String(providerId)}).capabilities.${key}`, fromRegistry ?? 'undefined');
          if (fromModule !== fromRegistry) {
            ledger.fail(
              'CAPABILITIES_MISMATCH',
              `resolve('${String(providerId)}').capabilities.${key} is ${String(fromRegistry)} but the module exports ${String(fromModule)}`,
            );
          }
        }

        if (resolved.capabilities?.maxInlineRequestBytes > 0) {
          await runCases(resolved, resolved.capabilities, ledger, String(providerId));
          // Scoped to THIS provider: with two adapters registered, an unscoped inventory would let
          // one provider's reading of a case stand in for the other's missing one (AC8).
          //
          // WHICH INVENTORY IS THE DECLARATION'S ANSWER TOO, not a second branch on a provider id:
          // a recogniser that reaches a wire owes the request-shaped cases, one that reaches none
          // owes the set readable without a request. Holding either to the other's list would print
          // an inventory mismatch for a provider that was measured correctly.
          const inventory = reachesAWire(resolved) ? EXPECTED_CASES : NO_WIRE_CASES;
          ledger.requireAll(inventory.map((id) => `${String(providerId)}:${id}`));
        } else {
          ledger.fail(
            'EMPTY_READING',
            `resolve('${String(providerId)}').capabilities.maxInlineRequestBytes is ${String(resolved.capabilities?.maxInlineRequestBytes)} — the budget cases below cannot be sized from it`,
          );
        }
      }
    }
  } catch (error) {
    ledger.fail('PROBE_THREW', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    poison.restore();
  }

  if (poison.calls.length > 0) {
    ledger.fail(
      'NETWORK_CALL',
      `the ambient fetch was reached ${poison.calls.length} time(s) (${poison.calls.join(', ')}) — every environment dependency must be injected for this probe to be offline`,
    );
  }
  ledger.record('ambient-fetch-calls', poison.calls.length);

  const failing = [...new Map(ledger.problems.map((problem) => [problem.token + problem.detail, problem])).values()];
  for (const problem of failing) process.stdout.write(`FAIL ${problem.token}: ${problem.detail}\n`);
  process.stdout.write(`${[...header, ...ledger.readings].join('\n')}\n`);
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = await main();
