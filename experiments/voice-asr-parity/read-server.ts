/**
 * AC-130's server half: the hop the server originates, plus the server half of the
 * response-tolerance reading — driven on the SHIPPED code.
 *
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-asr-parity/read-server.ts
 *
 * What it drives, and nothing else:
 *
 *   proxy-outbound      `createVoiceService(...).transcribe` -> the request the server sends to
 *                       the configured recogniser on the proxy path
 *   response-tolerance  the same service on response bodies that are not JSON, so its tolerance
 *                       (a non-JSON body is used as the transcript) is a reading rather than a
 *                       claim — and so the two paths' tolerances can be compared from one baseline
 *
 * The reader installs the outbound double the service takes as a dependency, calls the shipped
 * symbol, and serializes what it observed. It does not assemble a multipart body and it does not
 * parse a transcription response.
 *
 * A separate reader from the client half because the two alias tables are mutually exclusive: the
 * root tsconfig maps `@/*` to `src/*` and this one maps it to `server/*`, so a single process
 * cannot load both consumer sets. The server imports its own modules through the `@/*` alias while
 * this file — which belongs to neither side — reaches the service by relative path.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createVoiceService } from '../../server/modules/voice/voice.service.ts';

/** The marker every reading line starts with. The probe reads exactly these lines. */
const MARKER = 'ASR-PARITY-READING ';
/** The marker of the one fixture line, so the probe can tie the baseline back to this constant. */
const FIXTURE_MARKER = 'ASR-PARITY-FIXTURE ';

/**
 * The synthetic audio the server readings are taken on. The client reader declares the same bytes
 * for its own hops, and the probe asserts the two declarations and the baseline agree — the
 * baseline holds ONE `audio.sha256`, so a drift between the two readers must be a red rather than
 * two readings that quietly disagree.
 */
const SYNTHETIC_AUDIO_TEXT = 'k-asr-parity-fixture-audio-0123456789abcdef';
const SYNTHETIC_AUDIO_NAME = 'clip.webm';
const SYNTHETIC_AUDIO_MIME = 'audio/webm';

/** The recogniser the server proxy is pointed at, and the key it authenticates with. Made up: the
 * hop is read off the injected outbound function, so no request leaves the process. */
const SERVER_BASE_URL = 'https://voice.backend.invalid/v1';
const SERVER_API_KEY = 'k-server-key';
const SERVER_STT_MODEL = 'k-server-stt';

/** Never reached: the outbound function below answers, so no timeout can fire. */
const TIMEOUT_MS = 1_000;

function syntheticAudio(): Uint8Array {
  return new TextEncoder().encode(SYNTHETIC_AUDIO_TEXT);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type CapturedRequest = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: unknown;
};

/** Reads the headers the service declared, sorted so the reading does not depend on order. */
function readHeaders(headers: unknown): Array<[string, string]> {
  if (!headers || typeof headers !== 'object') return [];
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return entries
    .map(([name, value]) => [String(name).toLowerCase(), String(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Normalizes a captured FormData body into a boundary-independent reading.
 *
 * The boundary is generated fresh by the platform encoder on every serialization, so raw bytes
 * would be red on every run. Only the boundary is replaced; part names, filenames, part content
 * types and the audio bytes are kept verbatim. The encoding is the platform's (`Request`), not
 * this reader's. `latin1` maps byte to character one-to-one, so the text round-trips exactly.
 */
async function readMultipartBody(body: FormData): Promise<Record<string, string>> {
  const encoded = new Request('http://asr.invalid/', { method: 'POST', body });
  const contentType = encoded.headers.get('content-type') ?? '';
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const text = bytes.toString('latin1');
  const normalized = boundary ? text.split(boundary).join('BOUNDARY') : text;
  return {
    boundary: 'BOUNDARY',
    text: normalized,
    sha256: sha256Hex(Buffer.from(normalized, 'latin1')),
  };
}

async function readCaptured(captured: CapturedRequest): Promise<Record<string, unknown>> {
  const body = captured.body;
  return {
    url: captured.url,
    method: captured.method,
    headers: captured.headers,
    body:
      body instanceof FormData
        ? { kind: 'multipart', ...(await readMultipartBody(body)) }
        : { kind: 'other', text: String(body) },
  };
}

/**
 * The service with the outbound function replaced by a double that records the call and answers
 * with `respond()`. The dependencies are the service's own injected ports — nothing global is
 * patched — so what the reading sees is the request the service really builds.
 */
function makeService(calls: CapturedRequest[], respond: () => Response) {
  return createVoiceService({
    defaults: {
      baseUrl: SERVER_BASE_URL,
      apiKey: SERVER_API_KEY,
      sttModel: SERVER_STT_MODEL,
      ttsModel: '',
      ttsVoice: '',
    },
    timeoutMs: TIMEOUT_MS,
    fetchBackend: async (url, options) => {
      calls.push({
        url,
        method: String(options.method ?? 'GET').toUpperCase(),
        headers: readHeaders(options.headers),
        body: options.body,
      });
      return respond();
    },
  });
}

/** The upload the service is handed: the synthetic fixture, under the same name the client uses. */
function audioUpload() {
  return {
    bytes: Buffer.from(syntheticAudio()),
    mimeType: SYNTHETIC_AUDIO_MIME,
    fileName: SYNTHETIC_AUDIO_NAME,
  };
}

/**
 * The absolute path of the shipping module the reading was taken on, resolved by the loader rather
 * than spelled out here: a declared path would keep printing an old location after a move, which
 * is precisely the move `--explain-sites` exists to make visible.
 */
function siteOf(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(MARKER + JSON.stringify(line) + '\n');
}

/** One response-tolerance case: the backend body, and what the service made of it. */
async function toleranceCase(name: string, body: string): Promise<Record<string, unknown>> {
  const service = makeService([], () => new Response(body, { status: 200 }));
  const result = await service.transcribe({ audio: audioUpload(), overrides: {} });
  return result.ok
    ? { name, outcome: 'ok', text: result.value.text }
    : { name, outcome: 'error', status: result.status, error: result.error };
}

async function main(): Promise<void> {
  const calls: CapturedRequest[] = [];
  const service = makeService(
    calls,
    () => new Response(JSON.stringify({ text: 'k-asr-answer' }), { status: 200 }),
  );

  const result = await service.transcribe({ audio: audioUpload(), overrides: {} });
  if (!result.ok) {
    throw new Error(`proxy-outbound: the service refused the transcribe (${result.error})`);
  }
  if (calls.length !== 1) {
    throw new Error(`proxy-outbound: expected exactly one outbound request, saw ${calls.length}`);
  }

  const serviceSite = siteOf('../../server/modules/voice/voice.service.ts');
  emit({
    group: 'proxy-outbound',
    site: { symbol: 'createVoiceService', file: serviceSite },
    value: await readCaptured(calls[0]),
  });

  emit({
    group: 'response-tolerance',
    half: 'proxy',
    site: { symbol: 'createVoiceService', file: serviceSite },
    value: {
      // The case list is the client reader's, word for word, so the two halves of this group are
      // read on the same inputs and the asymmetry between the two tolerances is the only thing
      // that can differ (a non-JSON body is used as the transcript here, and throws there).
      cases: [
        await toleranceCase('non-json-body', 'k-asr-not-json'),
        await toleranceCase('json-text', JSON.stringify({ text: 'k-asr-answer' })),
        await toleranceCase('json-numeric-text', JSON.stringify({ text: 0 })),
        await toleranceCase('json-without-text', JSON.stringify({ other: 'k-asr-answer' })),
        await toleranceCase('json-null', 'null'),
      ],
    },
  });

  const bytes = syntheticAudio();
  process.stdout.write(
    FIXTURE_MARKER +
      JSON.stringify({
        source: 'synthetic',
        name: SYNTHETIC_AUDIO_NAME,
        mimeType: SYNTHETIC_AUDIO_MIME,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
      }) +
      '\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`read-server: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
