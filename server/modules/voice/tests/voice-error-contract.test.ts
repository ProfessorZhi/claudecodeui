/**
 * The failure envelope of the shipping transcription route: what a failed `POST /api/voice/transcribe`
 * actually answers with (AC-150).
 *
 * WHAT THIS FILE IS FOR. A user whose recording fails is shown a sentence, and the sentence is chosen
 * from the failure's `code`. Before this task the route published a code only for the three refusals
 * that happen *before* the upstream is touched (an unaccepted container, an oversized upload, an
 * address a provider's own rule refuses); every failure the recogniser produced — a rejected key, the
 * service's own rate limit, a model the account has not enabled, an answer with no speech in it, a
 * transport that never connected — arrived as a message and a status number. `422` and `502` are each
 * several different remedies, so a client asked to write the sentence had nothing to pick with. Two
 * properties are therefore worth a criterion, and both are cheap to lose again:
 *
 *   1. every failure of the transcription path names a vocabulary member, and the upstream's own code
 *      string travels beside it when the upstream named one;
 *   2. the wire carries nothing else — not the caller's key, not the `Bearer` form of it, and none of
 *      the upstream's answer text beyond the code string itself.
 *
 * The readings are measurements of four questions, all taken through the SHIPPING modules
 * (`createVoiceRouter` + `createVoiceService`, assembled the way `voice.module.ts` assembles them),
 * with an injected offline `fetchBackend`, a stand-in `parseAudioUpload` and no socket or port:
 *
 *   · AC2 — do all four kinds of failure (pre-check, upstream, no-speech, unreachable) answer with
 *     `error` AND a code that is a member of the shipping vocabulary?
 *   · AC3 — is `upstreamCode`, when present, shaped like a code, bounded in length, and a slice of the
 *     body the upstream actually sent — and absent, not invented, when the upstream named nothing, when
 *     nothing was ever sent, and when the only candidate is too long to be one?
 *   · AC4 — is the zero on the leak side a zero measured against positive controls (the key really is
 *     on the upstream request, the sentinel really is in the upstream answer)?
 *   · AC7 — is the vocabulary read off the shipping table rather than copied into this file?
 *
 * HOW IT IS STRUCTURED, and why that matters to a reader of a red: the readings live in one exported
 * function so that the FALSIFYING file (`voice-error-contract.false-forms.test.ts`) can run this very
 * list against a text-mutated copy of `voice.service.ts` and require the readings it predicts to go
 * red. Registering them as `node:test` cases is guarded by `IS_ENTRY`, so importing this file
 * registers nothing and the falsify run measures only what it asked for.
 *
 * AC5's falsifying forms and AC6's exit codes live in that other file, and the split is forced by AC1's
 * own budget: six `npx tsx --test` subprocesses plus `npm run typecheck` and `npm run lint` are most of
 * this criterion's fifteen seconds, and AC1 requires THIS file to start none.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { VoiceSettings, VoiceSettingsService } from '../../../shared/types.js';
import type { VoiceService } from '../../../shared/types.js';
// The VOCABULARY, read off the shipping module rather than restated here: `PROVIDER_ERROR_STATUS` is
// the one table that says which codes exist, and a criterion holding its own array of code strings
// would go on passing after a code was renamed. The import is STATIC and always the shipping path,
// even when a mutation case drives a copy of the service: AC7 asks which codes the RUNNING SYSTEM
// has, and a mutated copy that dropped a code from its table would otherwise move the standard the
// mutant is measured against.
import { PROVIDER_ERROR_STATUS } from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — three levels above this file (`server/modules/voice/tests/`). */
const SERVER_DIR = path.resolve(HERE, '../../..');

/** The shipping service module: the dispatch under test, and the file a mutation case copies. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping routes module: the envelope under test, and the other file a mutation case snapshots. */
export const SHIPPING_ROUTES_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.routes.ts');

/** This file, read as text by the `AC1 scope` reading — see the decision list in the header. */
const SELF_MODULE = fileURLToPath(import.meta.url);

// ── the fixture ───────────────────────────────────────────────────────────────────────────────

/**
 * The provider the arms are addressed to, and why this one.
 *
 * The no-speech arm needs an upstream that says "I heard nothing" as a 200, and only this recogniser's
 * envelope distinguishes that from "the answer was not mine" (`readAnswerContent` returns `null` for
 * the latter, which is an `UPSTREAM_UNAVAILABLE`). So the whole criterion rides on the proxy-only provider,
 * which also means every arm goes through the endpoint rule on the way — the address below is the
 * service's own, which is the address that rule accepts.
 */
const PROVIDER_ID = 'dashscope-omni';
const FAKE_KEY = 'fake-dashscope-key-7f3a91';
const FAKE_ENDPOINT = 'https://dashscope.aliyuncs.com';

/**
 * The text that must be in the upstream's answer and must NOT be in the page's response.
 *
 * It is deliberately prose-free of any `x.y` adjacency (a sentence's full stop followed by a word
 * would itself look like a dotted candidate), so "the sentinel is absent" cannot be satisfied by the
 * extractor having taken a piece of surrounding prose instead of the sentinel.
 */
const SENTINEL = 'SENTINEL-LEAK-CANARY-7f3a';

/** A candidate that is a code by SHAPE and not by length: 200 characters, the AC's own over-long arm. */
const OVERLONG_CANDIDATE = `A${'a'.repeat(199)}`;

/** The deployment's own configuration: the service's fallback for every field the user has not set. */
const DEFAULTS = {
  baseUrl: FAKE_ENDPOINT,
  apiKey: FAKE_KEY,
  sttModel: 'qwen3.8-omni-flash',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user who has saved nothing: every provider-declared field is empty, so the defaults above win. */
const EMPTY_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

/** The parser's ceiling, in the shape multer reports it — the same shape the shipping router reads. */
function ceilingError(): Error {
  return Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' });
}

/**
 * One arm: how the upload arrives, what the stand-in upstream answers, and what the route owes.
 *
 * `expectedStatus` is a RULE rather than a number wherever a number would be a second copy of
 * something the shipping module already decides: `'table'` means "the row `PROVIDER_ERROR_STATUS`
 * holds for whatever code came back" and `'carrier'` means "the upstream's own status, which the one
 * code that carries it is answered with". Reading them that way keeps the criterion about the
 * envelope — which failure names which code, and what else is on the wire — instead of about the
 * table's contents, which AC-139 already reads row by row.
 */
type ArmFixture = {
  name: string;
  /** The parser stand-in: fail with this error, or hand over this file (or none at all). */
  upload: { error: unknown } | { file: { mimetype: string } | null };
  /** The stand-in transport: refuse to connect, or answer with this status and body. */
  upstream: { reject: true } | { status: number; body: string };
  /** What the route owes. `'table'` and `'carrier'` are resolved at run time — see above. */
  expectedStatus: number | 'table' | 'carrier';
  /** The code string the upstream's body names, for the arms that answer with one. */
  bodyCode: string | null;
  /** Whether the attempt reached the transport at all, so "no answer to read" is a reading. */
  sent: boolean;
};

const ARM_FIXTURES: readonly ArmFixture[] = [
  // ── the pre-check arm: refused before any provider is reached ────────────────────────────────
  {
    name: 'parser-ceiling',
    upload: { error: ceilingError() },
    upstream: { status: 200, body: '{}' },
    expectedStatus: 413,
    bodyCode: null,
    sent: false,
  },
  {
    name: 'parser-other',
    upload: { error: new Error('Unexpected field') },
    upstream: { status: 200, body: '{}' },
    expectedStatus: 400,
    bodyCode: null,
    sent: false,
  },
  {
    name: 'missing-file',
    upload: { file: null },
    upstream: { status: 200, body: '{}' },
    expectedStatus: 400,
    bodyCode: null,
    sent: false,
  },
  {
    name: 'format-refusal',
    upload: { file: { mimetype: 'audio/x-m4a' } },
    upstream: { status: 200, body: '{}' },
    expectedStatus: 415,
    bodyCode: null,
    sent: false,
  },

  // ── the upstream arm: five distinct upstream statuses, four of them naming a code ────────────
  {
    name: 'upstream-401',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { status: 401, body: JSON.stringify({ code: 'InvalidApiKey' }) },
    expectedStatus: 'table',
    bodyCode: 'InvalidApiKey',
    sent: true,
  },
  {
    name: 'upstream-403',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: {
      status: 403,
      body: JSON.stringify({
        code: 'AccessDenied.Unpurchased',
        message: `${SENTINEL} the model is not enabled for this account`,
      }),
    },
    expectedStatus: 'table',
    bodyCode: 'AccessDenied.Unpurchased',
    sent: true,
  },
  {
    name: 'upstream-429',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { status: 429, body: JSON.stringify({ code: 'Throttling.RateQuota' }) },
    expectedStatus: 'table',
    bodyCode: 'Throttling.RateQuota',
    sent: true,
  },
  {
    name: 'upstream-404',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { status: 404, body: JSON.stringify({ error: { code: 'Model.NotFound' } }) },
    // The one code whose answer is DATA: a 404 is carried through as 404 rather than folded into the
    // table's row for `UPSTREAM_UNAVAILABLE`.
    expectedStatus: 'carrier',
    bodyCode: 'Model.NotFound',
    sent: true,
  },
  {
    name: 'upstream-500',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: {
      status: 500,
      body: JSON.stringify({ message: `${SENTINEL} the recogniser is having a bad day` }),
    },
    expectedStatus: 'carrier',
    // The non-fabrication control: an answer with no code-shaped string in it must answer with a code
    // (`UPSTREAM_UNAVAILABLE`) and NO `upstreamCode`.
    bodyCode: null,
    sent: true,
  },
  {
    name: 'upstream-500-overlong',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { status: 500, body: JSON.stringify({ code: OVERLONG_CANDIDATE }) },
    expectedStatus: 'carrier',
    // The length bound: the body's only candidate is 200 characters, which is a code by shape and not
    // by length, so the field must be absent rather than the first 64 characters of it.
    bodyCode: null,
    sent: true,
  },

  // ── the no-speech arm: the upstream answered, and heard nothing ──────────────────────────────
  {
    name: 'no-speech',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) },
    expectedStatus: 'table',
    bodyCode: null,
    sent: true,
  },

  // ── the unreachable arm: no answer exists to read a code out of ──────────────────────────────
  {
    name: 'unreachable',
    upload: { file: { mimetype: 'audio/webm' } },
    upstream: { reject: true },
    expectedStatus: 'table',
    bodyCode: null,
    sent: false,
  },
];

// ── driving one arm through the shipping router ───────────────────────────────────────────────

export type CriterionModules = {
  /** A path to use in place of the shipping service module (a mutation case's copy). */
  service?: string;
  /** A path to use in place of the shipping routes module. */
  routes?: string;
};

/** One arm's measurement: the response the page would have received, plus what the transport saw. */
type ArmMeasurement = {
  name: string;
  status: number;
  body: Record<string, unknown>;
  /** The answer text the stand-in handed back, or `null` when no request was made. */
  upstreamBody: string | null;
  /** The status the stand-in answered with, or `null` when it refused to connect. */
  upstreamStatus: number | null;
  /** The `Authorization` header the stand-in received, or `''` when no request was made. */
  authorization: string;
  /** How many requests the stand-in saw. */
  requestCount: number;
  /** Whether the transport was reached at all, from the arm's own fixture. */
  sent: boolean;
  /** What the route owes this arm. */
  expectedStatus: number | 'table' | 'carrier';
  /** The code string the upstream's body names, or `null`. */
  bodyCode: string | null;
};

type ServiceModule = { createVoiceService: (dependencies: unknown) => VoiceService };
type RoutesModule = { createVoiceRouter: (dependencies: unknown) => unknown };
type Router = (
  request: unknown,
  response: unknown,
  next: (error?: unknown) => void,
) => void;

/**
 * Drives ONE arm through the shipping router and the shipping service, assembled the way the
 * composition root assembles them.
 *
 * THE ROUTER IS INVOKED AS THE MIDDLEWARE FUNCTION IT IS rather than through a listening socket: a
 * test that bound a port would be reporting the platform's ephemeral-port lottery on the runs where it
 * went red, and AC1 requires this file to open none. The service is the SHIPPING one, so the dispatch,
 * the gates and the envelope are the ones the app mounts; the only things replaced are the two
 * dependencies the composition root gets from the environment — the outbound transport and the upload
 * parser.
 *
 * THE RESPONSE IS AWAITED THROUGH A DEFERRED rather than read straight after the call, because the
 * handler bridges multer's callback API into an async service call: for every arm that reaches the
 * transport, the answer is written a few microtasks after `router(...)` returns, and reading the
 * captured status immediately would read the zero it started as.
 */
async function driveArm(
  serviceModule: ServiceModule,
  routesModule: RoutesModule,
  fixture: ArmFixture,
): Promise<ArmMeasurement> {
  const seen = { answers: [] as string[], authorizations: [] as string[] };

  const service = serviceModule.createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: 1_000,
    fetchBackend: async (_url: string, init: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.authorizations.push(String(headers.Authorization ?? ''));
      if ('reject' in fixture.upstream) {
        // A transport that refuses to connect: no answer exists, which is the arm's whole point.
        throw new TypeError('fetch failed');
      }
      seen.answers.push(fixture.upstream.body);
      return new Response(fixture.upstream.body, {
        status: fixture.upstream.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const settingsService: VoiceSettingsService = {
    getSettings: () => EMPTY_SETTINGS,
    saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
    maskForReadback: (settings) => settings,
  };

  const router = routesModule.createVoiceRouter({
    voiceService: service,
    voiceSettingsService: settingsService,
    // The three parameters are annotated rather than inferred: this file drives the router through its
    // OWN module type (so a mutation case can point it at a copy), and a contextual type that flows
    // from the real `express.RequestHandler` would not reach through that indirection.
    parseAudioUpload: (
      request: unknown,
      _response: unknown,
      callback: (error?: unknown) => void,
    ) => {
      if ('error' in fixture.upload) {
        callback(fixture.upload.error);
        return;
      }
      const file = fixture.upload.file;
      if (file !== null) {
        (request as unknown as { file?: unknown }).file = {
          buffer: Buffer.alloc(2_048),
          mimetype: file.mimetype,
          originalname: 'recording.webm',
        };
      }
      callback(undefined);
    },
  }) as Router;

  let settled = false;
  let resolveSettled: () => void = () => {};
  const answered = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const settle = (): void => {
    if (!settled) {
      settled = true;
      resolveSettled();
    }
  };

  let status = 0;
  let body: Record<string, unknown> = {};
  let handlerError: unknown = null;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      settle();
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      settle();
      return this;
    },
  };

  router(
    {
      method: 'POST',
      url: '/transcribe',
      // The provider is selected the way the settings page selects it: a per-request override naming
      // the id. Nothing else about the request is read, and no credential travels on it — the key the
      // upstream request must carry comes from the deployment's own configuration.
      headers: { 'x-voice-provider': PROVIDER_ID },
    },
    response,
    (error?: unknown) => {
      handlerError = error ?? null;
      settle();
    },
  );

  await answered;
  assert.equal(
    handlerError,
    null,
    `the router forwarded an error for arm '${fixture.name}', so the envelope was never written`,
  );

  return {
    name: fixture.name,
    status,
    body,
    upstreamBody: seen.answers.length === 0 ? null : seen.answers[0],
    upstreamStatus: 'reject' in fixture.upstream ? null : fixture.upstream.status,
    authorization: seen.authorizations.length === 0 ? '' : seen.authorizations[0],
    requestCount: seen.authorizations.length,
    sent: fixture.sent,
    expectedStatus: fixture.expectedStatus,
    bodyCode: fixture.bodyCode,
  };
}

/** Runs every arm, in the fixture's order, against the modules the caller named. */
async function measure(modules: CriterionModules): Promise<ArmMeasurement[]> {
  const service = (await import(
    pathToFileURL(modules.service ?? SHIPPING_SERVICE_MODULE).href
  )) as unknown as ServiceModule;
  const routes = (await import(
    pathToFileURL(modules.routes ?? SHIPPING_ROUTES_MODULE).href
  )) as unknown as RoutesModule;

  const arms: ArmMeasurement[] = [];
  for (const fixture of ARM_FIXTURES) {
    arms.push(await driveArm(service, routes, fixture));
  }
  return arms;
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

export type ReadingOutcome = { name: string; value: string; ok: boolean };

/** Every code the run observed on a response body, in the order the arms produced them. */
function observedCodes(arms: readonly ArmMeasurement[]): string[] {
  const codes: string[] = [];
  for (const arm of arms) {
    if (typeof arm.body.code === 'string') codes.push(arm.body.code);
  }
  return codes;
}

/** Says "none" for an absent value rather than printing an empty space a reader could miss. */
function shown(value: unknown): string {
  return value === undefined || value === null || value === '' ? 'none' : String(value);
}

/** The status the route owes one arm, resolved the way `providerFailureStatus` resolves it. */
function owedStatus(arm: ArmMeasurement, vocabulary: Readonly<Record<string, number>>): number | null {
  if (typeof arm.expectedStatus === 'number') return arm.expectedStatus;
  if (arm.expectedStatus === 'carrier') return arm.upstreamStatus;
  const code = arm.body.code;
  return typeof code === 'string' ? vocabulary[code] ?? null : null;
}

const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

type Reading = { name: string; run: (arms: readonly ArmMeasurement[]) => { value: string; ok: boolean } };

const READINGS: readonly Reading[] = [
  // ── AC2: every arm answers with an error AND a code ──────────────────────────────────────────
  ...ARM_FIXTURES.map((fixture) => ({
    name: `AC2 arm/${fixture.name}`,
    run: (arms: readonly ArmMeasurement[]) => {
      const arm = arms.find((entry) => entry.name === fixture.name);
      assert.ok(arm, `no measurement for arm '${fixture.name}'`);
      const code = arm.body.code;
      const hasError = typeof arm.body.error === 'string' && arm.body.error !== '';
      const owes = owedStatus(arm, PROVIDER_ERROR_STATUS);
      const ok =
        arm.status === owes && typeof code === 'string' && code !== '' && hasError;
      return {
        value:
          `arm=${arm.name} status=${arm.status} code=${shown(code)} hasError=${String(hasError)} ` +
          `upstreamCode=${shown(arm.body.upstreamCode)} owed=${shown(owes)}`,
        ok,
      };
    },
  })),
  {
    name: 'AC2 tally',
    run: (arms) => {
      const coded = arms.filter(
        (arm) => typeof arm.body.code === 'string' && arm.body.code !== '',
      ).length;
      const upstreamStatuses = [
        ...new Set(
          arms.filter((arm) => arm.sent).map((arm) => arm.upstreamStatus ?? 'refused'),
        ),
      ];
      return {
        value:
          `arms=${arms.length} coded=${coded} errored=${
            arms.filter((arm) => typeof arm.body.error === 'string' && arm.body.error !== '').length
          } upstream-statuses=${upstreamStatuses.length} [${upstreamStatuses.join(' ')}]`,
        ok: coded === arms.length && upstreamStatuses.length >= 3,
      };
    },
  },

  // ── AC3: `upstreamCode` is read, shaped, bounded, and never invented ─────────────────────────
  ...ARM_FIXTURES.filter((fixture) => fixture.bodyCode !== null).map((fixture) => ({
    name: `AC3 code/${fixture.name}`,
    run: (arms: readonly ArmMeasurement[]) => {
      const arm = arms.find((entry) => entry.name === fixture.name);
      assert.ok(arm, `no measurement for arm '${fixture.name}'`);
      const value = arm.body.upstreamCode;
      const compliant = typeof value === 'string' && CODE_SHAPE.test(value);
      const bounded = typeof value === 'string' && value.length <= 64;
      const fromBody = typeof value === 'string' && (arm.upstreamBody ?? '').includes(value);
      return {
        value:
          `arm=${arm.name} upstreamCode=${shown(value)} codeCompliant=${String(compliant)} ` +
          `lengthBounded=${String(bounded)} isSubstringOfBody=${String(fromBody)} ` +
          `bodyNames=${shown(fixture.bodyCode)}`,
        ok: compliant && bounded && fromBody && value === fixture.bodyCode,
      };
    },
  })),
  {
    name: 'AC3 control/no-code-answer',
    run: (arms) => {
      const arm = arms.find((entry) => entry.name === 'upstream-500');
      assert.ok(arm, 'the no-code upstream arm did not run');
      const code = arm.body.code;
      return {
        value:
          `arm=${arm.name} code=${shown(code)} upstreamCode=${shown(arm.body.upstreamCode)} ` +
          `bodyHasCodeString=${String(
            typeof arm.upstreamBody === 'string' && CODE_SHAPE.test(arm.upstreamBody),
          )}`,
        ok: typeof code === 'string' && code !== '' && arm.body.upstreamCode === undefined,
      };
    },
  },
  {
    name: 'AC3 control/unreachable-answer',
    run: (arms) => {
      const arm = arms.find((entry) => entry.name === 'unreachable');
      assert.ok(arm, 'the unreachable arm did not run');
      return {
        value:
          `arm=${arm.name} code=${shown(arm.body.code)} upstreamCode=${shown(arm.body.upstreamCode)} ` +
          `attempted=${String(arm.requestCount)}`,
        ok: arm.body.upstreamCode === undefined && arm.requestCount === 1,
      };
    },
  },
  {
    name: 'AC3 control/no-speech-answer',
    run: (arms) => {
      const arm = arms.find((entry) => entry.name === 'no-speech');
      assert.ok(arm, 'the no-speech arm did not run');
      return {
        value: `arm=${arm.name} code=${shown(arm.body.code)} upstreamCode=${shown(arm.body.upstreamCode)}`,
        ok: arm.body.upstreamCode === undefined,
      };
    },
  },
  {
    name: 'AC3 bound/overlong-candidate',
    run: (arms) => {
      const arm = arms.find((entry) => entry.name === 'upstream-500-overlong');
      assert.ok(arm, 'the over-long candidate arm did not run');
      const value = arm.body.upstreamCode;
      const length = typeof value === 'string' ? value.length : 0;
      const responseText = JSON.stringify(arm.body);
      return {
        value:
          `upstreamCode=${shown(value)} oversizeArmLen=${length} ` +
          `candidateLen=${OVERLONG_CANDIDATE.length} candidateInResponse=${String(
            responseText.includes(OVERLONG_CANDIDATE),
          )}`,
        ok: (value === undefined || length <= 64) && !responseText.includes(OVERLONG_CANDIDATE),
      };
    },
  },

  {
    name: 'AC3 summary',
    run: (arms) => {
      // AC1's print format for this AC, in one line: the values the per-arm readings above already
      // carry, gathered so a reader does not have to reassemble them from six lines.
      const named = arms.filter((arm) => typeof arm.body.upstreamCode === 'string');
      const codes = named.map((arm) => `${arm.name}:${String(arm.body.upstreamCode)}`);
      const compliant = named.every(
        (arm) =>
          typeof arm.body.upstreamCode === 'string' && CODE_SHAPE.test(arm.body.upstreamCode),
      );
      const fromBody = named.every(
        (arm) =>
          typeof arm.body.upstreamCode === 'string' &&
          (arm.upstreamBody ?? '').includes(arm.body.upstreamCode),
      );
      const noBodyArm = arms.find((arm) => arm.name === 'upstream-500');
      const unreachableArm = arms.find((arm) => arm.name === 'unreachable');
      const overlong = arms.find((arm) => arm.name === 'upstream-500-overlong');
      const overlongValue = overlong?.body.upstreamCode;
      return {
        value:
          `upstreamCode=[${codes.join(' ')}] codeCompliant=${String(compliant)} ` +
          `isSubstringOfBody=${String(fromBody)} ` +
          `noBodyArm=${shown(noBodyArm?.body.upstreamCode)} ` +
          `unreachableArm=${shown(unreachableArm?.body.upstreamCode)} ` +
          `oversizeArmLen=${typeof overlongValue === 'string' ? overlongValue.length : 0}`,
        ok:
          compliant &&
          fromBody &&
          codes.length > 0 &&
          noBodyArm?.body.upstreamCode === undefined &&
          unreachableArm?.body.upstreamCode === undefined,
      };
    },
  },

  // ── AC4: the leak zero, measured against positive controls ───────────────────────────────────
  {
    name: 'AC4 control/positive',
    run: (arms) => {
      const withAnswer = arms.filter((arm) => arm.upstreamBody !== null);
      const sentinelInUpstream = withAnswer.some((arm) => (arm.upstreamBody ?? '').includes(SENTINEL));
      const keyInUpstreamRequest = arms.some((arm) => arm.authorization === `Bearer ${FAKE_KEY}`);
      return {
        value:
          `sentinelInUpstream=${String(sentinelInUpstream)} ` +
          `keyInUpstreamRequest=${String(keyInUpstreamRequest)} ` +
          `answered-arms=${withAnswer.length} addressed-arms=${arms.filter((arm) => arm.sent).length}`,
        ok: sentinelInUpstream && keyInUpstreamRequest && withAnswer.length > 0,
      };
    },
  },
  {
    name: 'AC4 leak/serialized-response',
    run: (arms) => {
      // The positive control first: the two zeros below are only readings if the two things they are
      // zeros OF are demonstrably true of this run. A run where the stand-in answered nothing would
      // leave the sentinel absent from the page for the wrong reason.
      const withAnswer = arms.filter((arm) => arm.upstreamBody !== null);
      const sentinelInUpstream = withAnswer.some((arm) => (arm.upstreamBody ?? '').includes(SENTINEL));
      const keyInUpstreamRequest = arms.some((arm) => arm.authorization === `Bearer ${FAKE_KEY}`);

      const serialized = JSON.stringify(arms.map((arm) => arm.body));
      const sentinelInResponse = serialized.includes(SENTINEL);
      const keyInResponse = serialized.includes(FAKE_KEY);
      const bearerInResponse = serialized.includes(`Bearer ${FAKE_KEY}`);

      // The two fields that carry an upstream's words are read on their own as well: a leak confined
      // to one of them is the shape this task could actually introduce.
      const fields = withAnswer.map((arm) => `${String(arm.body.error ?? '')} ${String(arm.body.upstreamCode ?? '')}`);
      const fieldsClean = fields.every(
        (field) => !field.includes(SENTINEL) && !field.includes(FAKE_KEY) && !field.includes('Bearer '),
      );

      return {
        value:
          `sentinelInUpstream=${String(sentinelInUpstream)} ` +
          `keyInUpstreamRequest=${String(keyInUpstreamRequest)} ` +
          `sentinelInResponse=${String(sentinelInResponse)} keyInResponse=${String(keyInResponse)} ` +
          `bearerInResponse=${String(bearerInResponse)} field-level-clean=${String(fieldsClean)} ` +
          `bodies=${arms.length}`,
        ok:
          sentinelInUpstream &&
          keyInUpstreamRequest &&
          !sentinelInResponse &&
          !keyInResponse &&
          !bearerInResponse &&
          fieldsClean,
      };
    },
  },

  // ── AC7: the vocabulary is read, not restated ───────────────────────────────────────────────
  {
    name: 'AC7 vocab/members',
    run: (arms) => {
      const keys = Object.keys(PROVIDER_ERROR_STATUS);
      const codes = observedCodes(arms);
      const allMembers = codes.every((code) => keys.includes(code));
      return {
        value:
          `vocab-size=${keys.length} observed-codes=[${[...new Set(codes)].join(' ')}] ` +
          `observed=${codes.length} all-members=${String(allMembers)} ` +
          `unobserved=[${keys.filter((key) => !codes.includes(key)).join(' ')}]`,
        ok: allMembers && codes.length === arms.length,
      };
    },
  },

  // ── AC8: what this criterion covers, and what it deliberately does not ───────────────────────
  {
    name: 'AC8 registration',
    run: (arms) => {
      const scoped = [
        'route envelope (error + code + upstreamCode)',
        'upstream code-string extraction and its bound',
        'leak readings against positive controls',
        'failures: pre-check, upstream, no-speech, unreachable',
      ].join('; ');
      const outOfScope = [
        'vocabulary expansion and the classifier (AC-149)',
        'localised copy (AC-151)',
        'direct-path parity (AC-152)',
        'a real browser (AC-153)',
        'ADR-004 revision',
        'a real upstream (the stand-in answers the bodies this file builds)',
        'the voice.transcribe line shape (unchanged by this task)',
      ].join('; ');
      // The two groups are split by whether the attempt reached the transport at all, which is a
      // counter rather than the arm's own label: the unreachable arm is a PROVIDER-path failure whose
      // request was made and refused, so it belongs with the upstream arms and not with the refusals
      // that never left the process.
      const neverSent = arms.filter((arm) => arm.requestCount === 0);
      const attempted = arms.filter((arm) => arm.requestCount > 0);
      // The two criteria this task's envelope moved, printed here as well as in the completion record
      // because "I only added a field" is exactly the claim a connected change falsifies: one existing
      // reading pinned the old shape, and one existing PROBE pinned it for a goal record.
      const connected = [
        'voiceTranscribeGaps:196 re-pinned (the non-ceiling parser failure now carries UNSUPPORTED_MIME, was: no code)',
        'scripts/asr-mime-size-gaps-check.mjs AC3 control (reads a vocabulary member that is not OVERSIZE, was: no code at all)',
      ].join('; ');
      return {
        value:
          `scope=[${scoped}] out-of-scope=[${outOfScope}] connected-changes=[${connected}] ` +
          `pre-check-code-values=[${neverSent
            .map((arm) => `${arm.name}:${shown(arm.body.code)}`)
            .join(' ')}] ` +
          `provider-path=[${attempted
            .map(
              (arm) =>
                `${arm.name}:code=${shown(arm.body.code)}/upstreamCode=${shown(arm.body.upstreamCode)}`,
            )
            .join(' ')}]`,
        ok: arms.length === ARM_FIXTURES.length,
      };
    },
  },
];

/**
 * Runs every reading against one measurement, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsify run has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 */
export async function collectReadings(modules: CriterionModules = {}): Promise<ReadingOutcome[]> {
  const arms = await measure(modules);

  const outcomes: ReadingOutcome[] = [];
  for (const reading of READINGS) {
    let outcome: ReadingOutcome;
    try {
      const measured = reading.run(arms);
      outcome = { name: reading.name, value: measured.value, ok: measured.ok };
    } catch (error) {
      outcome = {
        name: reading.name,
        value: `threw: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ────

/**
 * The doors this criterion must not have opened, as the quoted specifiers an import would carry.
 *
 * Every entry is assembled from parts at run time, because the `AC1 scope` reading reads THIS file's
 * source: a pattern written whole would match the pattern rather than an import, and the reading would
 * then report a door that was never opened. The list is the template the capture criterion keeps, and
 * the reason it holds here is the same one: `npx tsx --test <file>` runs the cases in THIS process, so
 * "no subprocess and no socket" is a property of what this file imports rather than of how it is
 * launched.
 */
const quoted = (parts: readonly string[]): string => `'${parts.join('')}'`;
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  quoted(['node:', 'child', '_process']),
  quoted(['node:', 'net']),
  quoted(['node:', 'http']),
  quoted(['node:', 'https']),
  quoted(['node:', 'dgram']),
  quoted(['node:', 'cluster']),
  quoted(['expr', 'ess']),
  quoted(['mult', 'er']),
];

/** The doors THIS file has open, computed from its own text. */
function openDoors(): string[] {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return FORBIDDEN_SPECIFIERS.filter((candidate) => source.includes(candidate));
}

const STARTED_AT = Date.now();
const IS_ENTRY = path.resolve(process.argv[1] ?? '') === SELF_MODULE;

if (IS_ENTRY) {
  let driven = 0;
  let measuredOnce: Promise<ReadingOutcome[]> | undefined;
  const readingsOnce = (): Promise<ReadingOutcome[]> => (measuredOnce ??= collectReadings());

  for (const reading of READINGS) {
    test(reading.name, async () => {
      const outcomes = await readingsOnce();
      const outcome = outcomes.find((entry) => entry.name === reading.name);
      assert.ok(outcome, `the reading list produced no outcome for '${reading.name}'`);
      driven += 1;
      // Printed BEFORE the assertion, so a red names itself and its measured value in the log rather
      // than only in the assertion's diff.
      process.stdout.write(`reading ${outcome.name} = ${outcome.value}\n`);
      assert.equal(outcome.ok, true, `reading '${outcome.name}' measured ${outcome.value}`);
    });
  }

  test('AC1 budget and scope', () => {
    const elapsed = Date.now() - STARTED_AT;
    const doors = openDoors();

    // AC1's own words: the run prints `elapsed-ms=<n>` at the end, and the target-side gate gives it
    // sixty seconds. The budget below is the criterion's, four times under the gate's ceiling.
    process.stdout.write(`elapsed-ms=${elapsed}\n`);
    process.stdout.write(
      `reading AC1 scope = elapsed-ms=${elapsed} subprocess-or-socket-imports=${doors.length} ` +
        `[${doors.join(' ')}] readings=${driven}/${READINGS.length}\n`,
    );

    assert.equal(
      driven,
      READINGS.length,
      `${driven} readings ran but the list has ${READINGS.length}: a reading was skipped, which reads ` +
        'exactly like a shorter green list',
    );
    assert.ok(elapsed < 15_000, `the criterion took ${elapsed}ms, past its own 15s budget`);
    assert.deepEqual(
      doors,
      [],
      `this criterion imports a module that can open a socket or start a process: ${doors.join(', ')}`,
    );
  });
}
