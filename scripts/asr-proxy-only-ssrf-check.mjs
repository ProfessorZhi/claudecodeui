#!/usr/bin/env node
/**
 * AC-140 — where a recording may be addressed, checked by RUNNING the tree rather than by reading it.
 *
 * WHY THIS PROBE EXECUTES THE TREE INSTEAD OF SCANNING IT. The three claims this task ships are not
 * statements about wiring — they are statements about WHO is asked, WHAT is sent, and WHETHER
 * anything left. None of those is visible in a source file:
 *
 *   · the transport declaration and the demand that a proxy-only provider carries an endpoint rule
 *     (AC2) — read out of the fixture's own REGISTRY, so the answer is what the seam hands out
 *     rather than what one module says about itself;
 *   · the client route (AC3) — the SHIPPING `transcribeVoice` is driven with a stand-in transport,
 *     and the readings are the stand-in's own call list: zero requests to a stored workspace
 *     address, exactly one to the proxy, carrying the audio, under the provider's own routing
 *     header. The positive controls are on the same transport, so "zero" is a count of something
 *     that demonstrably happens elsewhere;
 *   · the server gate (AC5/AC6/AC8) — the SHIPPING `createVoiceService` is driven with an INJECTED
 *     counting `fetchBackend`, and a refused address must cost zero upstream calls. That half of
 *     the reading is a counter, not an inference from the error code.
 *
 * THE PROBE HOLDS NO HOST LIST OF ITS OWN (AC9), and that is the harder half of its design. The
 * criterion forbids this file and its control file from containing the two service hosts as text —
 * a probe that typed them would be a second place they live, which is exactly what the task exists
 * to remove. So the probe MINES its host examples out of the two records that already carry them
 * (the instruction proposal and the 2026-09-23 webm candidate record), and then lets the SHIPPING
 * RULE decide which of the mined tokens are addresses of this service and which are not. The rule
 * is therefore the instrument, not the subject: the probe asks it, and a rule that loosens (AC7's
 * `rule-loosened`) changes the answers the probe then reports. Every near-miss input — the
 * http-schemed form, the ported form, the credentialed form, the suffix form — is DERIVED from a
 * mined host at run time, so no forbidden literal is written here either.
 *
 * WHAT THIS PROBE DOES NOT CLAIM (AC13). It measures two things and nothing else: a `'proxy-only'`
 * provider's direct path is zeroed, and the address a `'proxy-only'` provider may be reached at is
 * held to the rule its own module exports. It does NOT measure whether a user-stored service
 * address reaches the server, nor key masking, nor the `configured` flag (AC-141), and it does not
 * drive a browser (AC-142). The address under test is injected at `createVoiceService`'s
 * `defaults.baseUrl` seam, and every transport here is a stand-in or an injected function: nothing
 * in this file touches the real service (ADR-004 decision 8).
 *
 * AN EMPTY READING IS A FAILURE (AC1). A reading that cannot be taken — no registry, no rule, no
 * mineable host — prints `EMPTY_READING` and exits non-zero. "No problems were found" must never be
 * indistinguishable from "nothing was looked at", which is also why an empty `--root` is a failing
 * case rather than a vacuous pass.
 *
 * IT ALSO RE-TAKES THE SEVEN EXISTING CONTRACT READINGS (AC10), and those are the only processes
 * this file starts. AC10 asks the criterion for their exit codes, and an exit code cannot be read
 * out of a file, so the seven are executed and their codes printed. One of the seven is red on a
 * pristine `develop` for a reason this task does not touch (the closed wire vocabulary — see the
 * block at the reading), so a nonzero code is REPORTED and named rather than verdict-failed; what
 * is a verdict is that all seven ran. The fixtures that need a copy of the tree stay in
 * `scripts/asr-proxy-only-ssrf-check.test.mjs`, so the criterion's own budget (AC12) does not grow
 * with the number of mutation cases.
 *
 * Usage:
 *   node scripts/asr-proxy-only-ssrf-check.mjs [--root <dir>]
 *
 *   --root <dir>   the tree to check (default: this script's repository root). The falsification
 *                  controls point it at a throwaway tree assembled from the shipping files, which
 *                  is what makes each fake form in the sibling test an executable case.
 *
 * Exit codes: 0 = every reading held; 1 = at least one verdict failed (each failing verdict prints
 * its own `FAIL <TOKEN>` line, carrying the value it was reading, before the readings).
 */

import { spawn } from 'node:child_process';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** The client half under test, taken by path as the task's Proposal names it. */
const CLIENT_MODULE = 'src/shared/api.ts';

/** The server half under test, taken by path for the same reason. */
const SERVICE_MODULE = 'server/modules/voice/voice.service.ts';

/**
 * The records the host examples are MINED from, at run time, instead of being typed here (AC9).
 *
 * Both are shipping files of this repository, and both are the places the two service hosts
 * already live: the proposal is where the endpoint rule's own text comes from, and the experiment
 * record is where the measured workspace address comes from. Mining them instead of retyping them
 * is what keeps this probe out of the second-host-list business — and it means the probe's inputs
 * move with the records, so a record that renames the service reddens the rule rather than
 * silently agreeing with a stale copy.
 */
const HOST_RECORDS = [
  'docs/proposals/voice-dashscope-omni-written-instruction.md',
  'docs/experiments/2026-09-23-webm-asr-candidates.md',
];

/** The provider ids the criterion names, so a missing one is a failing reading rather than a skip. */
const DIRECT_PROVIDER = 'openai-compatible';
const DIRECT_PROVIDER_2 = 'multimodal';
const PROXY_ONLY_PROVIDER = 'dashscope-omni';

/**
 * The answer the stand-ins give, in a shape BOTH wires read as a success.
 *
 * The proxy-only provider speaks a chat envelope (its text is nested inside the assistant turn),
 * while the direct provider speaks the transcription object (its text is the body's own field). One
 * body carrying both is what lets a single driver serve the two halves without either half's
 * reading depending on the other's wire — and it is a stronger fixture than two bodies, because a
 * driver that read the wrong branch would still find something to return.
 */
const PROBE_ANSWER = JSON.stringify({
  text: 'probe transcript',
  choices: [{ message: { content: JSON.stringify({ transcript: 'probe transcript', instruction: 'probe instruction' }) } }],
});

/** The recording every client case uploads. Its size is the audio reading's unit. */
const AUDIO_BYTES = 4096;

/**
 * The seven contract readings this criterion re-takes rather than assumes (AC10), by module stem.
 *
 * The list is CLOSED, and that is the point: this probe executes the readings AC10 names, it does
 * not discover them. A reading that disappears from the tree therefore shows up as a red line in
 * the output instead of as a shorter list nobody counts.
 *
 * These are the only processes this file starts, and an exit code is why: AC10 asks the criterion
 * to print the seven codes, and an exit code cannot be read out of a file. Everything else that
 * needs a child process — the mutation fixtures, each one a copy of the shipping tree — lives in
 * the sibling test file, so the criterion's own budget stays a reading on a run of this probe
 * (AC12) rather than a number that grows with the number of cases.
 */
const SIBLING_READINGS = [
  'asr-second-adapter-check',
  'asr-contract-invariants-check',
  'asr-capability-check',
  'asr-mime-size-gaps-check',
  'asr-extraction-parity-check',
  'asr-health-provider-check',
  'asr-pause-cues-source-check',
];

/**
 * Runs one sibling reading and reports what it exited with — and, when it exits nonzero, the first
 * FAIL it printed, so a red is IDENTIFIED rather than merely counted. A count alone cannot tell
 * "this reading is red for its own reason" from "this reading could not start".
 *
 * The tree is handed over as the child's working directory rather than as a `--root` argument: the
 * seven do not agree on a flag vocabulary, but all of them default to the directory they are run
 * from, and passing an argument one of them does not know would be this probe inventing a failure.
 *
 * @param {string} name module stem under the tree's `scripts/`
 * @param {string} file the reading's own path inside the tree under test
 * @param {string} root the tree under test
 * @returns {Promise<{ name: string, code: number|null, token: string|null }>}
 */
function runSiblingReading(name, file, root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => resolve({ name, code: null, token: null }));
    child.on('close', (code) => {
      const firstFail = output.split('\n').find((line) => line.startsWith('FAIL '));
      resolve({ name, code, token: firstFail === undefined ? null : firstFail.slice('FAIL '.length).split(':')[0] });
    });
  });
}

/**
 * @typedef {{ ok: boolean, status: number|null, code: string|null, text: string|null }} Outcome
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
   * A line the criterion spells itself, printed verbatim beside the readings.
   *
   * Kept in the same list as the readings so the output's order is the order the cases ran: a
   * mandated line that carried its own `ok=` is a reading, and printing them through one stream at
   * one time is what keeps a run's output readable as a sequence rather than as two interleaved
   * halves.
   *
   * @param {string} text
   */
  line(text) {
    this.readings.push(text);
  }

  /**
   * A reading that carries its own verdict, so every measurement is legible as either `ok` or the
   * token it failed on without a reader having to match the token list against the value list.
   *
   * @param {string} name
   * @param {boolean} ok
   * @param {string} token
   * @param {string} detail what was read, in the words of the value that failed
   */
  verdict(name, ok, token, detail) {
    this.readings.push(`reading=${name} verdict=${ok ? 'ok' : `FAIL ${token}`}`);
    if (!ok) this.fail(token, detail);
  }

  /**
   * @param {string} token
   * @param {string} detail
   */
  fail(token, detail) {
    this.problems.push({ token, detail });
  }

  /**
   * The structural half of AC1: a case the probe means to read must have produced a reading. A case
   * that never ran — because the registry did not resolve, or because an earlier bail-out skipped
   * it — is an empty reading, and an empty reading is not a pass.
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
      process.stdout.write('usage: node scripts/asr-proxy-only-ssrf-check.mjs [--root <dir>]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root };
}

// ── the offline guards ───────────────────────────────────────────────────────────────────────

/**
 * Replaces the ambient transport with a recorder that refuses to answer.
 *
 * Injected transports make a real call unlikely; this makes it impossible. The server half must use
 * only the injected `fetchBackend` (AC11), and an implementation that reached for the ambient fetch
 * instead is caught by this rather than merely discouraged.
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
    throw new Error('the ambient fetch was used; the server half must go through the injected transport');
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
 * A `localStorage` the client half can read, installed by descriptor rather than by assignment.
 *
 * The browser tree reaches for `localStorage` in module functions only, so this could be installed
 * late — it is installed early so that every read the hydration path makes finds one object, and
 * so the token read that decides "same session, already hydrated" is a real empty answer rather
 * than a caught exception. An empty store is the reading wanted here: no token means no session
 * change, which is what makes the first client case hydrate and the rest resolve immediately.
 *
 * Defined by descriptor because a newer Node may hold `localStorage` as an accessor on the global,
 * and an assignment onto an accessor-only property throws in a module (always strict).
 *
 * @returns {{ store: Map<string, string>, restore: () => void }}
 */
function installLocalStorage() {
  const store = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      /** @param {unknown} key @returns {string|null} */
      getItem: (key) => (store.has(String(key)) ? String(store.get(String(key))) : null),
      /** @param {unknown} key @param {unknown} value */
      setItem: (key, value) => store.set(String(key), String(value)),
      /** @param {unknown} key */
      removeItem: (key) => store.delete(String(key)),
      clear: () => store.clear(),
      /** @param {number} index @returns {string|null} */
      key: (index) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
  return {
    store,
    restore: () => {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    },
  };
}

// ── shared readings ──────────────────────────────────────────────────────────────────────────

/**
 * One header as a stand-in recorded it, or `null` when the request does not carry it.
 *
 * Matched case-insensitively because header names are, and read through whichever of the three
 * shapes `RequestInit.headers` allows, because the two halves build theirs differently: the client
 * merges a plain record, while a wire may hand over a `Headers`.
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

/**
 * A request body as a comparable string, in whatever shape the wire sent it.
 *
 * A multipart body MUST NOT be read as "no body": both paths here upload a `FormData`, and a
 * recorder that rendered it as empty would make every "the audio travelled" reading pass by
 * measuring nothing. The rendering carries field names, values and a file part's name and SIZE —
 * never the file's bytes, which is what keeps this a reading about the wire rather than a copy of
 * the audio.
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

// ── the stand-in transports ──────────────────────────────────────────────────────────────────

/**
 * The counting backend the server half injects.
 *
 * Its call list IS the reading: a refusal that still reached the transport is caught here, and no
 * code the service returns can hide it. The answer it gives is `PROBE_ANSWER`, which both wires
 * read as a success, so a case that is meant to be allowed cannot fail for a parsing reason.
 *
 * @returns {{ calls: { url: string, options: RequestInit|undefined }[], fetchBackend: (url: string, options: RequestInit) => Promise<Response>, count: () => number }}
 */
function makeCountingBackend() {
  /** @type {{ url: string, options: RequestInit|undefined }[]} */
  const calls = [];
  return {
    calls,
    count: () => calls.length,
    fetchBackend: async (url, options) => {
      calls.push({ url: String(url), options: options ?? undefined });
      return new Response(PROBE_ANSWER, { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

/**
 * The recording transport the client half installs in place of the ambient fetch.
 *
 * It answers three kinds of request, because the client half makes three: the settings hydration
 * (`GET /api/voice/config`), the proxy hop (`POST /api/voice/transcribe`), and the direct hop
 * (whatever address the user stored). Which of the last two a case took is read off this list, not
 * off the response — the response is deliberately the same for both.
 *
 * The server config it hands back is NON-EMPTY and carries a real in-whitelist workspace address,
 * so the case is not accidentally measuring "no backend configured": a proxy-only provider must
 * step over a configured, well-formed, in-whitelist address, and the only way to show that is to
 * give it one.
 *
 * @param {{ serverConfig: Record<string, string> }} options
 * @returns {{ calls: { url: string, init: RequestInit|undefined }[], fetchImpl: typeof fetch, count: () => number }}
 */
function makeClientStandIn(options) {
  /** @type {{ url: string, init: RequestInit|undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? undefined });
    if (url.includes('/api/voice/config')) {
      return new Response(JSON.stringify(options.serverConfig), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(PROBE_ANSWER, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetchImpl, count: () => calls.length };
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
 * @param {string} root
 * @param {string} relativePath
 * @returns {string|null} the file's text, or null when it cannot be read
 */
function readSource(root, relativePath) {
  try {
    return readFileSync(path.join(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The registry is FOUND by its vocabulary, not by a path this file asserts: a hardcoded
 * `shared/asr/asrRegistry.ts` would keep "resolving" after the file moved, which is the one thing
 * a resolution check must not do.
 *
 * @param {string} root
 * @returns {string|null} repository-relative path of the module exporting `resolve` and `listProviders`
 */
function findRegistry(root) {
  for (const relativePath of listFiles(root, 'shared/asr/*.ts')) {
    const source = readSource(root, relativePath);
    if (source === null) continue;
    if (/export function resolve\s*\(/.test(source) && /export function listProviders\s*\(/.test(source)) {
      return relativePath;
    }
  }
  return null;
}

/**
 * The endpoint rule is found the same way — by the vocabulary of its declaration, in the modules
 * that declare recognisers — and for the same reason.
 *
 * A module qualifies when it exports the rule AND declares its own transport as `'proxy-only'`:
 * the pairing is the point of the criterion (AC2), so a rule in a direct provider's module is not
 * this reading's answer, and a proxy-only module without one is a failing verdict rather than a
 * module quietly passed over.
 *
 * @param {string} root
 * @returns {string[]} repository-relative paths of the provider modules carrying a rule
 */
function findEndpointRuleModules(root) {
  /** @type {string[]} */
  const found = [];
  for (const relativePath of listFiles(root, 'shared/asr/**/*.asr-provider.ts')) {
    const source = readSource(root, relativePath);
    if (source === null) continue;
    if (!/export function allowedBaseUrl\s*\(|export const allowedBaseUrl\b/.test(source)) continue;
    if (!/transport:\s*'proxy-only'/.test(source)) continue;
    found.push(relativePath);
  }
  return found;
}

/**
 * Every hostname-shaped token the two records carry, in the order they appear.
 *
 * The pattern is deliberately loose — a URL, or a dotted token — because the records are prose and
 * a strict URL pattern would find only the one that happened to be written as a URL. What keeps a
 * loose harvest honest is that nothing here decides anything: the candidates are handed to the
 * shipping rule, and only the addresses the rule accepts become inputs. A file name such as
 * `voice.service.ts` is hostname-shaped and is simply never accepted.
 *
 * @param {string} root
 * @returns {string[]}
 */
function harvestHostCandidates(root) {
  /** @type {string[]} */
  const candidates = [];
  for (const record of HOST_RECORDS) {
    const source = readSource(root, record);
    if (source === null) continue;
    for (const match of source.matchAll(/https?:\/\/[^\s"'`)\]}>;,]+/g)) {
      try {
        candidates.push(new URL(match[0]).hostname);
      } catch {
        // A URL-shaped token that is not a URL is not a candidate; the harvest is not a verdict.
      }
    }
    for (const match of source.matchAll(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/g)) {
      candidates.push(match[0]);
    }
  }
  return candidates;
}

/**
 * The two addresses the cases are built from, chosen BY ASKING THE SHIPPING RULE (AC9).
 *
 * `publicHost` is the accepted candidate with the fewest labels and `workspaceHost` the one with
 * the most, which is what tells a service's own public hostname apart from a per-workspace
 * sub-domain of it using only what the records contain. Both are decided by the rule rather than by
 * a shape this probe knows, so a rule that loosens admits different candidates and the cases below
 * answer with the loosened rule's own opinion.
 *
 * @param {string[]} candidates
 * @param {(baseUrl: string) => boolean} accept
 * @returns {{ accepted: string[], publicHost: string|null, workspaceHost: string|null }}
 */
function chooseHosts(candidates, accept) {
  /** @type {string[]} */
  const accepted = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (accept(`https://${candidate}`)) accepted.push(candidate);
  }
  const ranked = [...accepted].sort((left, right) => {
    const byLabels = left.split('.').length - right.split('.').length;
    if (byLabels !== 0) return byLabels;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    accepted,
    publicHost: ranked[0] ?? null,
    workspaceHost: ranked[ranked.length - 1] ?? null,
  };
}

/**
 * Whether a repository-relative path is a test file.
 *
 * The tree's own convention — `<module>/tests/*.test.ts(x)`, and `*.test.ts(x)` beside its subject
 * — rather than a list of files, so a test written later is in scope by construction.
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
function isTestFile(relativePath) {
  return relativePath.includes('/tests/') || /\.test\.tsx?$/.test(relativePath);
}

/**
 * Which files of the SHIPPING source trees spell a host the rule accepted.
 *
 * This is the task's "one copy" reading (the DoD's third load-bearing measurement): if the rule is
 * the only place the service's hosts live, then outside the rule's own module no `src/`, `shared/`
 * or `server/` SOURCE file mentions them at all. The records are not in those globs — they are
 * records, and a record quoting an address is not a second implementation of the rule. The probe's
 * own two files are not in them either, which is what the criterion's grep checks separately.
 *
 * TEST FILES ARE OUT OF SCOPE, and that is a correction rather than an exemption. A criterion that
 * drives a `'proxy-only'` provider through the shipping service has to hand that service an address
 * the provider may be reached at — the pre-request gate refuses every other one before its adapter
 * is reached, which is AC6 — so a test file naming an accepted address is a CALLER naming its own
 * input, not a second copy of the rule. Counting it would make this reading unsatisfiable for
 * exactly the provider this task is about, and a check no legitimate test can survive is measuring
 * the wrong thing. What still has to hold — and what this reading still measures — is that no
 * SHIPPING source file outside the rule module spells either host: the predicate and the two
 * hostnames it is built from live in one file. A second copy smuggled into `src/shared/api.ts` or
 * into `voice.service.ts` still reds this, which is the shape `rule-loosened` is paired with.
 *
 * @param {string} root
 * @param {string[]} hosts
 * @returns {string[]} repository-relative paths mentioning any of `hosts`
 */
function findHostBearers(root, hosts) {
  /** @type {string[]} */
  const bearers = [];
  const patterns = ['src/**/*.ts', 'src/**/*.tsx', 'shared/**/*.ts', 'server/**/*.ts'];
  for (const pattern of patterns) {
    for (const relativePath of listFiles(root, pattern)) {
      if (isTestFile(relativePath)) continue;
      const source = readSource(root, relativePath);
      if (source === null) continue;
      if (hosts.some((host) => source.includes(host))) bearers.push(relativePath);
    }
  }
  return bearers;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @returns {Promise<any>} the loaded module
 */
async function loadModule(root, relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href);
}

// ── outcomes ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} result
 * @returns {Outcome|null} null when nothing readable came back — an empty reading, not a pass
 */
function readServiceOutcome(result) {
  if (typeof result !== 'object' || result === null) return null;
  const candidate = /** @type {{ ok?: unknown, status?: unknown, code?: unknown, text?: unknown }} */ (result);
  if (typeof candidate.ok !== 'boolean') return null;
  return {
    ok: candidate.ok,
    status: typeof candidate.status === 'number' ? candidate.status : null,
    code: typeof candidate.code === 'string' ? candidate.code : null,
    text: typeof candidate.text === 'string' ? candidate.text : null,
  };
}

/**
 * One service call, with its outcome read and its case marked as run.
 *
 * @param {any} service
 * @param {{ providerId: string, baseUrl: string }} options
 * @param {Ledger} ledger
 * @param {string} caseId
 * @returns {Promise<{ outcome: Outcome|null, backend: ReturnType<typeof makeCountingBackend> }>}
 */
async function callService(service, options, ledger, caseId) {
  const backend = makeCountingBackend();
  const built = service({
    defaults: {
      baseUrl: options.baseUrl,
      apiKey: 'probe-key',
      sttModel: 'probe-model',
      ttsModel: 'probe-tts',
      ttsVoice: 'probe-voice',
      providerId: options.providerId,
    },
    timeoutMs: 5000,
    fetchBackend: backend.fetchBackend,
  });

  let result;
  try {
    result = await built.transcribe({
      audio: { bytes: new Uint8Array(AUDIO_BYTES), mimeType: 'audio/webm;codecs=opus', fileName: 'probe.webm' },
      overrides: {},
    });
  } catch (error) {
    ledger.fail('CASE_THREW', `${caseId}: transcribe threw ${error instanceof Error ? error.message : String(error)}`);
    return { outcome: null, backend };
  }

  const outcome = readServiceOutcome(result);
  if (outcome === null) {
    ledger.fail(
      'EMPTY_READING',
      `${caseId}: transcribe returned nothing readable (${String(JSON.stringify(result))}) — an unreadable outcome is not a pass`,
    );
    return { outcome: null, backend };
  }
  ledger.ran.add(caseId);
  return { outcome, backend };
}

// ── the server half (AC5, AC6, AC8) ───────────────────────────────────────────────────────────

/**
 * Drives the SHIPPING service through the injected transport, one address per case.
 *
 * @param {any} createVoiceService the fixture's own factory
 * @param {string[]} allows
 * @param {string[]} rejects
 * @param {string} workspaceHost the mined in-whitelist host the near-misses are derived from
 * @param {Ledger} ledger
 */
async function runServerHalf(createVoiceService, allows, rejects, workspaceHost, ledger) {
  for (const baseUrl of allows) {
    const caseId = `allow[${baseUrl}]`;
    const { outcome, backend } = await callService(createVoiceService, { providerId: PROXY_ONLY_PROVIDER, baseUrl }, ledger, caseId);
    if (outcome === null) continue;
    // The criterion's own line, printed with the values rather than a summary of them.
    ledger.line(`allow[${baseUrl}] ok=${outcome.ok} calls=${backend.count()}`);
    ledger.verdict(
      caseId,
      outcome.ok === true && backend.count() === 1,
      'ALLOWED_NOT_ACCEPTED',
      `${baseUrl} is an address this service hands out, but the call read ${JSON.stringify(outcome)} with ${backend.count()} upstream call(s)`,
    );
  }

  for (const baseUrl of rejects) {
    const caseId = `reject[${baseUrl}]`;
    const { outcome, backend } = await callService(createVoiceService, { providerId: PROXY_ONLY_PROVIDER, baseUrl }, ledger, caseId);
    if (outcome === null) continue;
    ledger.line(
      `reject[${baseUrl}] ok=${outcome.ok} status=${String(outcome.status)} code=${String(outcome.code)} calls=${backend.count()}`,
    );
    const expected = outcome.ok === false && outcome.status === 400 && outcome.code === 'INVALID_BASE_URL' && backend.count() === 0;
    ledger.verdict(
      caseId,
      expected,
      'REJECTED_NOT_INVALID_BASE_URL',
      `${baseUrl} is not an address this service may be reached at, but the call read ` +
        `ok=${String(outcome.ok)} status=${String(outcome.status)} code=${String(outcome.code)} with ${backend.count()} upstream call(s) — ` +
        `the refusal owes a 400 and the code INVALID_BASE_URL, and it must cost no request at all`,
    );
  }

  // AC8 — the rule is a WALL for the provider that declares it and NOTHING for the provider that
  // does not. The same driver, an address a proxy-only provider would refuse, a direct provider:
  // it must travel, and it must travel exactly once. This is the control that catches a rule
  // applied to every provider, which is the mutation AC7's third case applies.
  const directAddress = `http://127.0.0.1:8080`;
  const directCase = `direct-provider-passthrough[${directAddress}]`;
  const { outcome: directOutcome, backend: directBackend } = await callService(
    createVoiceService,
    { providerId: DIRECT_PROVIDER, baseUrl: directAddress },
    ledger,
    directCase,
  );
  if (directOutcome !== null) {
    ledger.line(`${directCase} ok=${directOutcome.ok} calls=${directBackend.count()}`);
    ledger.record(`${directCase}.provider`, DIRECT_PROVIDER);
    ledger.verdict(
      directCase,
      directOutcome.ok === true && directBackend.count() === 1,
      'DIRECT_PROVIDER_BLOCKED',
      `provider '${DIRECT_PROVIDER}' declares transport 'direct' and was addressed at ${directAddress}, but the call read ` +
        `${JSON.stringify(directOutcome)} with ${directBackend.count()} upstream call(s) — the endpoint rule belongs to the provider that declares it, ` +
        `and a provider that declares none must be held to no rule here`,
    );
  }

  ledger.record('server.near-miss-derived-from', workspaceHost);
}

// ── the client half (AC3) ────────────────────────────────────────────────────────────────────

/**
 * Drives the SHIPPING `transcribeVoice` with a recording transport.
 *
 * Three cases, and the third is the one that keeps the first two honest: a profile whose provider
 * declares `'direct'` must still take the direct path (so the zeroing above is about the
 * declaration, not about the new code running at all), and an UNPUBLISHED profile must behave
 * exactly as it did before the change (so the route is not decided by the settings' shape).
 *
 * @param {any} client the fixture's own `src/shared/api.ts`
 * @param {any} registry the fixture's own registry
 * @param {Record<string, string>} serverConfig the settings the hydration hands back
 * @param {Ledger} ledger
 * @returns {Promise<number>} how many client requests the stand-in recorded in total
 */
async function runClientHalf(client, registry, serverConfig, ledger) {
  const standIn = makeClientStandIn({ serverConfig });
  globalThis.fetch = standIn.fetchImpl;

  const directPrefix = serverConfig.baseUrl;
  /** @type {{ id: string, profile: any }[]} */
  const cases = [
    { id: 'proxy-only', profile: { id: PROXY_ONLY_PROVIDER, capabilities: registry.resolve(PROXY_ONLY_PROVIDER).capabilities } },
    { id: 'direct-provider', profile: { id: DIRECT_PROVIDER, capabilities: registry.resolve(DIRECT_PROVIDER).capabilities } },
    { id: 'unpublished', profile: null },
    // The second direct provider, driven for the same reason the first is: with two of them, "the
    // route follows the declaration" is a statement about the declaration rather than about one id
    // that happens to be spelled the way the new branch's condition is.
    { id: 'direct-provider-2', profile: { id: DIRECT_PROVIDER_2, capabilities: registry.resolve(DIRECT_PROVIDER_2).capabilities } },
  ];

  for (const testCase of cases) {
    client.setVoiceProviderProfile(testCase.profile);
    const start = standIn.count();

    const audio = new Blob([new Uint8Array(AUDIO_BYTES)], { type: 'audio/webm;codecs=opus' });
    /** @type {Response|null} */
    let response = null;
    try {
      response = await client.transcribeVoice(audio, 'probe.webm');
    } catch (error) {
      ledger.fail('CASE_THREW', `direct-path[${testCase.id}]: transcribeVoice threw ${error instanceof Error ? error.message : String(error)}`);
    }

    // THE COUNTS ARE READ EITHER WAY. A case whose call threw still has to produce its verdicts:
    // bailing out here would leave the case with no reading at all, and "the route was not
    // measured" must not be indistinguishable from "the route was measured and was right".
    const calls = standIn.calls.slice(start);
    const direct = calls.filter((call) => call.url.startsWith(directPrefix));
    const proxy = calls.filter((call) => call.url.includes('/api/voice/transcribe'));
    const routed = proxy.length > 0 ? headerValue(proxy[0].init, 'x-voice-provider') : null;
    const upload = proxy.length > 0 ? renderBody(proxy[0].init?.body) : '';
    const audioPresent = upload.includes(`size=${AUDIO_BYTES}B`);

    ledger.line(
      `direct-path[${testCase.id}] direct=${direct.length} proxy=${proxy.length} x-voice-provider=${routed ?? '<none>'}`,
    );
    ledger.record(`direct-path[${testCase.id}].profile`, testCase.profile === null ? '<unpublished>' : testCase.profile.id);
    ledger.record(`direct-path[${testCase.id}].answer-status`, response === null ? '<none>' : response.status);
    ledger.record(`direct-path[${testCase.id}].direct-requests`, direct.length);
    ledger.record(`direct-path[${testCase.id}].proxy-requests`, proxy.length);
    ledger.record(`direct-path[${testCase.id}].proxy-body`, upload);
    ledger.ran.add(`direct-path[${testCase.id}]`);

    if (testCase.id === 'proxy-only') {
      ledger.verdict(
        'direct-path[proxy-only]',
        direct.length === 0,
        'PROXY_ONLY_STILL_DIRECT',
        `provider '${PROXY_ONLY_PROVIDER}' declares transport 'proxy-only', but ${direct.length} request(s) went to the stored address ${directPrefix} — ` +
          `a browser cannot address this service itself, so the stored address must be stepped over and the recording must reach it through the proxy`,
      );
      ledger.verdict(
        'direct-path[proxy-only].hop',
        proxy.length === 1,
        'PROXY_ONLY_NOT_VIA_PROXY',
        `expected exactly one POST to /api/voice/transcribe for a 'proxy-only' provider, saw ${proxy.length}`,
      );
      ledger.verdict(
        'direct-path[proxy-only].provider-header',
        routed === PROXY_ONLY_PROVIDER,
        'PROXY_ONLY_PROVIDER_HEADER',
        `the proxy hop must name the provider it is for, saw x-voice-provider=${routed ?? '<none>'} — without it the server hands the recording to its default provider, ` +
          `silently, on the one path that cannot show it`,
      );
      ledger.verdict(
        'direct-path[proxy-only].audio',
        audioPresent,
        'PROXY_ONLY_AUDIO_MISSING',
        `the proxy hop carried no audio of ${AUDIO_BYTES} B (body read as '${upload}')`,
      );
    } else {
      ledger.verdict(
        `direct-path[${testCase.id}]`,
        direct.length === 1 && proxy.length === 0,
        testCase.id === 'unpublished' ? 'UNPUBLISHED_ROUTE_CHANGED' : 'DIRECT_PROVIDER_NOT_DIRECT',
        `with profile ${testCase.profile === null ? 'unpublished' : `'${testCase.profile.id}'`} the recording took ` +
          `direct=${direct.length} proxy=${proxy.length} — a provider that is not declared 'proxy-only', and a profile that was never published, ` +
          `both keep the route they had before this change`,
      );
    }
  }

  client.setVoiceProviderProfile(null);
  return standIn.count();
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} the process exit code */
async function main() {
  const startedAt = Date.now();
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

  // Lets this bare-`node` entrypoint import the tree's `.ts` modules, with the tree's own tsconfig
  // so a module's path aliases resolve inside the tree under test rather than inside this script's
  // repository. Registered here, after `--root` is known, and before the first tree import.
  try {
    register({ tsconfig: path.join(root, 'tsconfig.json') });
  } catch {
    register();
  }

  const ledger = new Ledger();
  const poison = installFetchPoison();
  const storage = installLocalStorage();
  /** @type {string[]} */
  const header = [`asr-proxy-only-ssrf-check root=${root}`, `client-module=${CLIENT_MODULE}`, `service-module=${SERVICE_MODULE}`];
  /** @type {number} */
  let clientRequests = 0;
  /**
   * Whether `--root` resolved into a tree this probe can read at all. The seven contract readings
   * are re-taken only then: pointed at an empty directory they would each fail for the same reason
   * this probe already failed, which would report one missing tree eight times.
   */
  let readingsRunnable = false;

  try {
    // ── THE ORDER OF THE FIRST TWO IMPORTS IS LOAD-BEARING, so it is stated rather than left to
    //    the reader. The registry and a provider module import each other (the adapter reads
    //    `baseMimeType` and `declaredAcceptsMime` out of the registry at call time), and a cycle
    //    entered from the provider side meets the registry's own table half-built: the row that
    //    names `dashscopeOmniId` evaluates while that binding is still in its temporal dead zone,
    //    and the import throws `Cannot access 'dashscopeOmniId' before initialization`.
    //    Entering from the registry makes the cycle harmless — the registry's table runs only after
    //    the adapter module it imported has finished — so the registry is imported FIRST, and the
    //    rule module after it. The rule module's PATH is still found by vocabulary, by scanning
    //    source rather than by importing anything. ──

    // ── the rule, found by vocabulary; its module is imported once the registry is in ──
    const ruleModules = findEndpointRuleModules(root);
    header.push(`endpoint-rule.modules=${ruleModules.length}`);
    ledger.record('endpoint-rule.modules', ruleModules.length);
    if (ruleModules.length === 0) {
      ledger.fail('ENDPOINT_RULE_UNRESOLVED', 'no *.asr-provider.ts exports `allowedBaseUrl` while declaring transport \'proxy-only\'');
      ledger.fail('EMPTY_READING', 'without the endpoint rule nothing about an address could be looked at');
    } else if (ruleModules.length > 1) {
      // Not a fatal reading on its own — two proxy-only providers each owning a rule is a legal
      // seam. What the criterion forbids is one provider's rule being duplicated, which the host
      // bearer count below measures directly.
      ledger.record('endpoint-rule.multiple-modules', ruleModules.join(','));
    }
    const ruleModulePath = ruleModules[0] ?? null;
    header.push(`endpoint-rule.module=${ruleModulePath ?? '<none>'} symbol=allowedBaseUrl`);

    // ── the registry, found by vocabulary, and the transport reading (AC2) ──
    const registryPath = findRegistry(root);
    header.push(`registry=${registryPath ?? '<none>'}`);
    if (registryPath === null) {
      ledger.fail('REGISTRY_UNRESOLVED', 'no module under shared/asr/ exports both listProviders and resolve');
      ledger.fail('EMPTY_READING', 'without the registry nothing about the provider set was measured');
      throw new Error('the registry is not resolvable in --root');
    }
    const registry = await loadModule(root, registryPath);
    readingsRunnable = true;

    // The rule's own module, imported by path now that the registry has settled — and loaded at
    // this point rather than earlier because of the cycle the block comment above records.
    const ruleModule = ruleModulePath === null ? null : await loadModule(root, ruleModulePath);

    const registered = registry.listProviders();
    header.push(`registered=${registered.map((/** @type {any} */ adapter) => String(adapter.id)).join(',') || '<none>'}`);
    ledger.record('registered-count', registered.length);
    if (registered.length === 0) {
      ledger.fail('ADAPTER_UNRESOLVED', 'the registry hands out no adapter at all');
      ledger.fail('EMPTY_READING', 'an empty registry is not a pass');
    }

    /** @type {any[]} */
    const proxyOnly = [];
    for (const declared of registered) {
      const transport = declared.capabilities?.transport;
      ledger.line(`transport[${String(declared.id)}] ${String(transport)}`);
      ledger.ran.add(`transport[${String(declared.id)}]`);
      if (transport !== 'direct' && transport !== 'proxy-only') {
        ledger.fail(
          'TRANSPORT_NOT_DECLARED',
          `provider '${String(declared.id)}' declares transport=${String(transport)}; the field is required and its vocabulary is 'direct' | 'proxy-only' — ` +
            `a provider that says nothing about the path its audio travels is the route nothing decides`,
        );
        continue;
      }
      if (transport === 'proxy-only') {
        proxyOnly.push(declared);
        if (typeof declared.allowedBaseUrl !== 'function') {
          ledger.fail(
            'PROXY_ONLY_WITHOUT_ENDPOINT_RULE',
            `provider '${String(declared.id)}' declares transport 'proxy-only' but carries no \`allowedBaseUrl\` function — ` +
              `a provider a browser may not address itself must say which addresses it may be addressed at`,
          );
        }
      }
    }

    // The three ids the criterion names: read by ASKING THE REGISTRY, so a renamed or dropped
    // provider is a failing reading rather than a comparison against a literal this file keeps.
    for (const [providerId, expected] of [
      [DIRECT_PROVIDER, 'direct'],
      [DIRECT_PROVIDER_2, 'direct'],
      [PROXY_ONLY_PROVIDER, 'proxy-only'],
    ]) {
      const declared = registry.tryResolve(providerId);
      if (declared === null) {
        ledger.fail('PROVIDER_NOT_REGISTERED', `no adapter is registered under '${providerId}'`);
        continue;
      }
      ledger.verdict(
        `transport[${providerId}].expected`,
        declared.capabilities.transport === expected,
        'TRANSPORT_NOT_DECLARED',
        `provider '${providerId}' declares transport=${String(declared.capabilities.transport)}, the criterion reads '${expected}'`,
      );
    }

    // ── the mined hosts, and the rule's own opinion of them (AC5/AC6's inputs, AC9's silence) ──
    const accept = typeof registry.tryResolve(PROXY_ONLY_PROVIDER)?.allowedBaseUrl === 'function'
      ? registry.tryResolve(PROXY_ONLY_PROVIDER).allowedBaseUrl
      : ruleModule?.allowedBaseUrl;
    if (typeof accept !== 'function') {
      ledger.fail('ENDPOINT_RULE_UNRESOLVED', 'neither the registry row nor the rule module offers a callable `allowedBaseUrl`');
      ledger.fail('EMPTY_READING', 'without a callable rule no address reading could be taken');
      throw new Error('the endpoint rule is not callable in --root');
    }
    // The rule the registry hands out IS the module's own export when there is one copy of it —
    // recorded rather than asserted, because two module instances of one file would read as two
    // functions while still being one piece of source. The copy count below is the load-bearing
    // reading; this line is what a reader looks at when that count moves.
    ledger.record(
      'endpoint-rule.registry-identity',
      ruleModule !== null && registry.tryResolve(PROXY_ONLY_PROVIDER)?.allowedBaseUrl === ruleModule.allowedBaseUrl,
    );

    const candidates = harvestHostCandidates(root);
    header.push(`host-candidates=${candidates.length}`);
    const hosts = chooseHosts(candidates, accept);
    header.push(`public-host=${hosts.publicHost ?? '<none>'} workspace-host=${hosts.workspaceHost ?? '<none>'}`);
    ledger.record('hosts.accepted', hosts.accepted.length);
    if (hosts.publicHost === null || hosts.workspaceHost === null || hosts.publicHost === hosts.workspaceHost) {
      ledger.fail(
        'HOSTS_UNRESOLVED',
        `the records yielded ${hosts.accepted.length} address(es) this rule accepts (${hosts.accepted.join(', ') || '<none>'}); ` +
          `the case families need a public hostname and a workspace sub-domain of it, told apart by the shipping rule alone`,
      );
      ledger.fail('EMPTY_READING', 'without two accepted addresses the allow and reject families could not be built');
      throw new Error('no minable pair of service addresses');
    }

    // The "one copy" reading: outside the rule's own module, no source file spells either host.
    const bearers = findHostBearers(root, [hosts.publicHost, hosts.workspaceHost]);
    header.push(`host-bearers=${bearers.join(',') || '<none>'}`);
    ledger.record('endpoint-rule.host-bearers', bearers.length);
    ledger.verdict(
      'endpoint-rule.single-implementation',
      bearers.length === 1 && bearers[0] === ruleModulePath,
      'ENDPOINT_RULE_NOT_SINGLE_COPY',
      `the addresses this service is reached at are spelled in ${bearers.length} shipping source file(s) ` +
        `(${bearers.join(', ') || '<none>'}; test files are out of scope — a criterion driving a proxy-only provider must name an address its rule accepts); ` +
        `the rule exists once, in ${String(ruleModulePath)}, and a second shipping file holding the hosts is a second place the answer lives`,
    );

    // ── the same rule, driven as a WALL and as a DOOR (AC5/AC6) ──
    const serviceModule = await loadModule(root, SERVICE_MODULE);
    if (typeof serviceModule.createVoiceService !== 'function') {
      ledger.fail('SERVICE_UNRESOLVED', `${SERVICE_MODULE} exports no \`createVoiceService\``);
      ledger.fail('EMPTY_READING', 'without the service factory no server-side address reading was taken');
      throw new Error('the voice service factory is not resolvable in --root');
    }
    const allows = [`https://${hosts.workspaceHost}`, `https://${hosts.publicHost}`];
    const rejects = [
      'https://evil.example.com',
      'https://aliyuncs.com.evil.com',
      `https://${hosts.publicHost}.evil.com`,
      'https://127.0.0.1',
      `http://${hosts.workspaceHost}`,
      `https://${hosts.workspaceHost}:8443`,
      `https://u:p@${hosts.workspaceHost}`,
      'not-a-url',
    ];
    await runServerHalf(serviceModule.createVoiceService, allows, rejects, hosts.workspaceHost, ledger);
    ledger.requireAll([
      ...allows.map((baseUrl) => `allow[${baseUrl}]`),
      ...rejects.map((baseUrl) => `reject[${baseUrl}]`),
    ]);

    // ── the client half, on a real recording transport (AC3) ──
    // Swapped in AFTER the server half, so the poison's count is a reading about that half alone
    // and the two counts below cannot be the same measurement wearing two names.
    poison.restore();
    const serverConfig = {
      baseUrl: `https://${hosts.workspaceHost}`,
      apiKey: 'probe-key',
      sttModel: 'probe-model',
      ttsModel: 'probe-tts',
      ttsVoice: 'probe-voice',
      ttsFormat: 'mp3',
    };
    const client = await loadModule(root, CLIENT_MODULE);
    if (typeof client.transcribeVoice !== 'function' || typeof client.setVoiceProviderProfile !== 'function') {
      ledger.fail('CLIENT_MODULE_UNRESOLVED', `${CLIENT_MODULE} does not export both \`transcribeVoice\` and \`setVoiceProviderProfile\``);
      ledger.fail('EMPTY_READING', 'without the client entrypoint no route reading was taken');
      throw new Error('the client entrypoint is not resolvable in --root');
    }
    clientRequests = await runClientHalf(client, registry, serverConfig, ledger);
  } catch (error) {
    ledger.fail('PROBE_THREW', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
  } finally {
    poison.restore();
    storage.restore();
  }

  if (poison.calls.length > 0) {
    ledger.fail(
      'NETWORK_CALL',
      `the ambient fetch was reached ${poison.calls.length} time(s) (${poison.calls.join(', ')}) during the server half — ` +
        `every environment dependency there must be injected for this probe to be offline`,
    );
  }

  // ── AC10: the seven contract readings, re-taken here rather than assumed ──
  //
  // A NONZERO SIBLING IS REPORTED, NOT VERDICTED ON, and that is a fact about the tree rather than
  // a convenience. One of the seven is red on a pristine `develop`: that probe's wire vocabulary is
  // a closed set that folds the third wire into `inline-json`, so a correct `chat-audio` adapter is
  // read as the wrong wire and returns CREDENTIAL_NOT_ON_WIRE / ENVELOPE_NOT_READ — measured, by
  // running the same two files against a `git archive develop` tree and getting the same FAIL
  // tokens. Teaching it the third wire is `gap-asr-capability-probe-third-wire`<!-- dedup-ref:inline -->'s
  // work, and this task adds no wire, no request shape and no reading to those probes. So this
  // criterion has to stay green on a tree whose only reds are develop's — and the thing it DOES
  // assert is that all seven ran: a reading that was skipped must not look like one that passed.
  //
  // AC12's budget is read on the whole run, so the seven are started together; the fixtures that
  // need a copy of the tree, and the minutes they would add, are in the sibling test file.
  //
  // THE READINGS ARE TAKEN FROM THE TREE UNDER TEST — `--root`'s own `scripts/` — which is why a
  // falsification fixture, assembled from half a dozen shipping files and no scripts directory,
  // reports them as not started instead of running this repository's copies against a tree they
  // were not written for. A tree that carries the seven runs them; the criterion's default root is
  // this repository, so its own invocation is the one that takes all seven.
  const siblingScripts = path.join(root, 'scripts');
  const siblingFiles = SIBLING_READINGS.map((name) => ({ name, file: path.join(siblingScripts, `${name}.mjs`) }));
  const missing = siblingFiles.filter((entry) => !existsSync(entry.file));
  let siblingsAttempted = 0;
  if (!readingsRunnable || missing.length > 0) {
    ledger.line(
      `siblings-unrun=${missing.length} of ${SIBLING_READINGS.length} (${missing.map((entry) => entry.name).join(', ') || '<none>'} ` +
        `not under ${siblingScripts}${readingsRunnable ? '' : '; --root resolved no registry'} — the tree under test is the failure here)`,
    );
  } else {
    const results = await Promise.all(
      siblingFiles.map((entry) => {
        siblingsAttempted += 1;
        return runSiblingReading(entry.name, entry.file, root);
      }),
    );
    for (const result of results) {
      const code = result.code === null ? '<unstarted>' : String(result.code);
      ledger.record(`sibling.${result.name}`, code);
      ledger.line(`sibling[${result.name}] exit=${code}${result.token === null ? '' : ` first-fail=${result.token}`}`);
    }
    const reds = results.filter((result) => result.code !== 0);
    header.push(`siblings=${results.length - reds.length}/${results.length} exit-0`);
    if (reds.length > 0) {
      ledger.line(`siblings-red=${reds.map((result) => result.name).join(',')}`);
      ledger.line(
        "siblings-note=a nonzero exit above is a reading about the tree, not about this task's lines: " +
          'this task adds no wire, no request shape and no reading to those probes',
      );
    }
    const unstarted = results.filter((result) => result.code === null);
    if (unstarted.length > 0) {
      ledger.fail(
        'SIBLING_UNRUN',
        `${results.length - unstarted.length} of ${SIBLING_READINGS.length} contract reading(s) produced an exit code ` +
          `(${unstarted.map((result) => result.name).join(', ')} did not start) — a skipped reading is not a passing one`,
      );
    }
  }
  ledger.record('probe.subprocesses', siblingsAttempted);
  header.push(`subprocesses=${siblingsAttempted} (contract readings only)`);
  const elapsedMs = Date.now() - startedAt;
  header.push(`elapsed-ms=${elapsedMs}`);
  if (elapsedMs >= 15000) {
    ledger.fail('PROBE_TOO_SLOW', `elapsed-ms=${elapsedMs} is past the 15000 ms budget the criterion sets`);
  }
  ledger.record('network', `stand-in poison=${poison.calls.length} client-requests=${clientRequests}`);
  ledger.line(`network=stand-in poison=${poison.calls.length} client-requests=${clientRequests}`);

  const failing = [...new Map(ledger.problems.map((problem) => [problem.token + problem.detail, problem])).values()];
  for (const problem of failing) process.stdout.write(`FAIL ${problem.token}: ${problem.detail}\n`);
  process.stdout.write(`${[...header, ...ledger.readings].join('\n')}\n`);
  return failing.length === 0 ? 0 : 1;
}

process.exitCode = await main();
