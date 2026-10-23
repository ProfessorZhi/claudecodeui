/**
 * Criterion for the default per-run wrapper (AC-154).
 *
 * Proves that a turn dispatched through the application's real entry point
 * (`providerRuntimeService`) registers exactly one `per-run` host bound to that
 * turn's app session id, and that the host's close reason is computed from how
 * the run actually ended: `turn-complete` for the providers whose terminal frame
 * and run promise settle together, `aborted` when the runtime confirmed a stop,
 * and `released` for Claude's held-stdin window — readable as `lingering` only
 * while the run is still pending.
 *
 * Each provider is driven by a forged runtime rather than a live CLI: codex by
 * mocking the SDK's `Codex.prototype.startThread`, cursor and opencode by a fake
 * executable placed earlier on `PATH`, and claude by a fake CLI at
 * `CLAUDE_CLI_PATH`. The manager is read only through
 * `sessionHostManager.snapshot()`, so every reading below is a reading of the
 * production path rather than of a test double of it.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { createProviderRuntimeService, providerRegistry } from '@/modules/providers/index.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import { createCompleteMessage } from '@/shared/utils.js';
import type { IProvider, IProviderRuntime } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  NormalizedMessage,
  ProcessHost,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

// ---------------------------
//----------------- FIXTURE SCAFFOLDING ------------
/** A writer that keeps every frame, so a leg can be read from either side. */
type FrameLog = ProviderRuntimeWriter & { frames: unknown[] };

function createWriter(): FrameLog {
  const frames: unknown[] = [];
  return {
    userId: null,
    isWebSocketWriter: true,
    frames,
    send(data: unknown) {
      frames.push(data);
    },
    setSessionId() {
      // The runtimes announce the provider-native id here; the readings below
      // do not depend on it, so it is accepted and dropped.
    },
  };
}

function frameKinds(frames: unknown[]): unknown[] {
  return frames.map((frame) => (frame as { kind?: unknown })?.kind);
}

/**
 * Builds the dispatcher under test.
 *
 * Same wiring as the production singleton, but with the registry resolvable
 * from a test-owned map so one provider can be swapped for a forged one and the
 * model/session lookups answer without touching a database.
 */
function createService(overrides: Record<string, IProvider> = {}) {
  const providers = providerRegistry
    .listProviders()
    .map((provider) => overrides[provider.id] ?? provider);
  for (const [id, provider] of Object.entries(overrides)) {
    if (!providers.some((candidate) => candidate.id === id)) {
      providers.push(provider);
    }
  }

  return createProviderRuntimeService({
    listProviders: () => providers,
    resolveProvider(providerName) {
      const provider = providers.find((candidate) => candidate.id === providerName);
      if (!provider) {
        throw new Error(`Missing provider: ${providerName}`);
      }
      return provider;
    },
    resolveProviderSessionId: () => null,
    async resolveResumeModel() {
      return undefined;
    },
    async getProviderModels() {
      return { OPTIONS: [], DEFAULT: 'fake-model' };
    },
  });
}

/** The run context the dispatcher would have built, built by hand. */
function createContext(provider: IProvider): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fake-model' }),
    normalizeMessage: (raw: unknown, sessionId: string | null): NormalizedMessage[] =>
      provider.sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
}

function liveHosts(provider: string): ProcessHost[] {
  return sessionHostManager
    .snapshot()
    .filter((host) => host.provider === provider && host.state !== 'closed');
}

function hostsBoundTo(appSessionId: string): ProcessHost[] {
  return sessionHostManager
    .snapshot()
    .filter((host) => host.bindings.has(appSessionId));
}

/** Reads the host the wrapper opened for this turn, waiting for a target state. */
async function waitForHost(
  appSessionId: string,
  predicate: (host: ProcessHost) => boolean,
  label: string,
): Promise<ProcessHost> {
  const deadline = Date.now() + 10_000;
  let host = hostsBoundTo(appSessionId)[0];
  while (!host || !predicate(host)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label} (last state: ${host?.state ?? 'none'})`);
    }
    await delay(15);
    host = hostsBoundTo(appSessionId)[0];
  }
  return host;
}

async function writeExecutable(binDir: string, name: string, source: string): Promise<string> {
  const scriptPath = path.join(binDir, name);
  await writeFile(scriptPath, source, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

/** Runs `body` with the given environment overrides, restoring them after. */
async function withEnv<T>(overrides: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// ---------------------------
//----------------- PROVIDER FORGES ------------
/**
 * Cursor's terminal `result` line is deliberately absent: the runtime settles
 * the run in its process-exit handler, which is the shape AC4 asserts on.
 * Emitting `result` would settle the run from a later macrotask instead.
 */
const CURSOR_FAKE_SOURCE = `#!/usr/bin/env node
const line = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'cursor-fake-1',
  model: 'fake-model',
  cwd: process.cwd(),
});
process.stdout.write(line + '\\n', () => process.exit(0));
`;

const OPENCODE_FAKE_SOURCE = `#!/usr/bin/env node
const events = [
  { type: 'text', sessionID: 'opencode-fake-1', text: 'assistant response' },
  { type: 'step_finish', sessionID: 'opencode-fake-1' },
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n', () => process.exit(0));
`;

/** Stays alive until a leg kills it, and announces itself once it is up. */
const OPENCODE_ABORT_FAKE_SOURCE = `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.SESSION_HOSTS_FAKE_READY, 'ready');
setInterval(() => {}, 100);
`;

/**
 * Fake Claude Code CLI speaking the SDK's stream-json protocol.
 *
 * With `SESSION_HOSTS_FAKE_BACKGROUND` set, the assistant turn carries a
 * `Monitor` tool call — that is what makes the runtime hold the CLI open after
 * the turn's `result`. The process then stays alive until the test creates
 * `SESSION_HOSTS_FAKE_RELEASE`; without the flag it exits as soon as the
 * runtime closes stdin, which is the ordinary end of a turn.
 */
const CLAUDE_FAKE_SOURCE = `#!/usr/bin/env node
const sid = 'claude-fake-1';
const background = process.env.SESSION_HOSTS_FAKE_BACKGROUND === '1';
const releaseFile = process.env.SESSION_HOSTS_FAKE_RELEASE;
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    }
  }
});
process.stdin.on('end', () => { setTimeout(() => process.exit(0), 20); });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const content = [{ type: 'text', text: 'hello from fake' }];
if (background) {
  content.push({ type: 'tool_use', id: 'tool-1', name: 'Monitor', input: {} });
}
(async () => {
  await delay(20);
  out({ type: 'system', subtype: 'init', session_id: sid, tools: [], mcp_servers: [], model: 'fake-model', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', cwd: process.cwd(), agents: [], output_style: 'default', uuid: 'uuid-1' });
  await delay(20);
  out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'uuid-2' });
  await delay(20);
  out({ type: 'result', subtype: 'success', session_id: sid, is_error: false, result: 'ok', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: 'uuid-3' });
  if (background && releaseFile) {
    const timer = setInterval(() => {
      if (require('node:fs').existsSync(releaseFile)) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 20);
  }
})();
`;

type Fakes = {
  claudeCli: string;
  cleanup(): Promise<void>;
  install(): Promise<void>;
  run<T>(body: () => Promise<T>): Promise<T>;
};

/**
 * Installs the three forged runtimes for one test.
 *
 * `run` keeps the forged `PATH` and `CLAUDE_CLI_PATH` in place for the whole
 * body — including the awaits — because cursor and opencode spawn their CLI
 * from an async continuation, after dispatch has already returned.
 */
async function createFakes(): Promise<Fakes> {
  const cursorBin = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-cursor-'));
  const opencodeBin = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-opencode-'));
  const claudeBin = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-claude-'));
  const claudeCli = await writeExecutable(claudeBin, 'claude', CLAUDE_FAKE_SOURCE);
  const previousPath = process.env.PATH;

  return {
    claudeCli,
    async install() {
      await writeExecutable(cursorBin, 'cursor-agent', CURSOR_FAKE_SOURCE);
      await writeExecutable(opencodeBin, 'opencode', OPENCODE_FAKE_SOURCE);
    },
    run<T>(body: () => Promise<T>): Promise<T> {
      process.env.PATH = `${cursorBin}${path.delimiter}${opencodeBin}${path.delimiter}${previousPath ?? ''}`;
      return withEnv({ CLAUDE_CLI_PATH: claudeCli }, body).finally(() => {
        process.env.PATH = previousPath;
      });
    },
    async cleanup() {
      await rm(cursorBin, { recursive: true, force: true });
      await rm(opencodeBin, { recursive: true, force: true });
      await rm(claudeBin, { recursive: true, force: true });
    },
  };
}

/** A codex thread whose stream is the supplied events, with a fixed id. */
function createCodexThread(events: unknown[]): Thread {
  return {
    id: 'thread-default-wrap',
    async runStreamed() {
      return {
        events: (async function* streamEvents() {
          for (const event of events) {
            yield event;
          }
        })(),
      };
    },
  } as unknown as Thread;
}

const CODEX_TURN_EVENTS: unknown[] = [
  { type: 'thread.started', thread_id: 'thread-default-wrap' },
  { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'hello from codex' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
];

/** Dispatches one turn through the service under test. */
function dispatch(
  service: ReturnType<typeof createService>,
  provider: LLMProvider,
  appSessionId: string,
) {
  const writer = createWriter();
  const runPromise = service.run(
    provider,
    'hello there',
    { sessionId: appSessionId, cwd: process.cwd() },
    writer,
  );
  // Aborted and killed legs end by rejecting on purpose; the rejection is
  // captured here so the leg that expects it can assert on it.
  const settled = runPromise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { writer, settled };
}

// ---------------------------
//----------------- CRITERION ------------

/**
 * AC2 — and it runs first, so `direct-run-hosts=0` is a reading of a manager
 * that has not yet seen a host. The bypassed dispatch writes a real terminal
 * frame, so "0 hosts" cannot be explained by a run that never happened.
 */
test('AC2: hosts are registered only by the real dispatch entry', async () => {
  const fakeRuntime: IProviderRuntime = {
    async run(_command, options, writer) {
      writer.send(
        createCompleteMessage({
          provider: 'claude',
          sessionId: (options.sessionId as string | undefined) ?? null,
          exitCode: 0,
        }),
      );
    },
    abort: () => false,
  };
  const fakeProvider = {
    id: 'claude' as LLMProvider,
    runtime: fakeRuntime,
    sessions: { normalizeMessage: () => [] },
  } as unknown as IProvider;

  const service = createService({ claude: fakeProvider });

  const directWriter = createWriter();
  await fakeProvider.runtime.run(
    'hello there',
    { sessionId: 'ac2-direct' },
    directWriter,
    createContext(fakeProvider),
  );
  const directHosts = hostsBoundTo('ac2-direct');
  console.log(`direct-run-hosts=${directHosts.length}`);
  assert.equal(directHosts.length, 0);
  assert.deepEqual(frameKinds(directWriter.frames), ['complete']);

  const viaWriter = createWriter();
  await service.run('claude', 'hello there', { sessionId: 'ac2-via-service' }, viaWriter);
  const viaHosts = hostsBoundTo('ac2-via-service');
  console.log(`via-service-hosts=${viaHosts.length}`);
  assert.equal(viaHosts.length, 1);
  assert.deepEqual(frameKinds(viaWriter.frames), ['complete']);
});

/**
 * AC3 — all four providers are dispatched first and read from one snapshot, so
 * the reading is "one live host per provider at the same moment" rather than
 * four unrelated readings.
 */
test('AC3: a running turn registers one per-run host per provider', async (t) => {
  t.mock.method(Codex.prototype, 'startThread', () => createCodexThread(CODEX_TURN_EVENTS));
  const fakes = await createFakes();
  const service = createService();
  const sessions: Record<string, string> = {
    codex: 'ac3-codex',
    cursor: 'ac3-cursor',
    opencode: 'ac3-opencode',
    claude: 'ac3-claude',
  };

  try {
    await fakes.install();
    await fakes.run(async () => {
      const dispatched = {
        codex: dispatch(service, 'codex', sessions.codex),
        cursor: dispatch(service, 'cursor', sessions.cursor),
        opencode: dispatch(service, 'opencode', sessions.opencode),
        claude: dispatch(service, 'claude', sessions.claude),
      };

      // One snapshot, read synchronously after the four dispatches, so the
      // reading is "one live host per provider at the same moment".
      const snapshot = sessionHostManager.snapshot();
      const readings = (['codex', 'cursor', 'opencode', 'claude'] as const).map((provider) => {
        const hosts = snapshot.filter(
          (host) => host.provider === provider && host.state !== 'closed',
        );
        const host = hosts.find((candidate) => candidate.bindings.has(sessions[provider]));
        const bindingKeys = host ? [...host.bindings.keys()] : [];
        console.log(
          `provider=${provider} hosts=${hosts.length} mode=${host?.mode} state=${host?.state} appSessionId=${bindingKeys.join(',')}`,
        );
        return { provider, hosts, host, bindingKeys };
      });

      // Every leg is awaited inside the fake-PATH scope — and before any
      // assertion, so a failing reading cannot leave a run (and its CLI child)
      // behind for the file to hang on.
      for (const provider of ['codex', 'cursor', 'opencode', 'claude'] as const) {
        const outcome = await dispatched[provider].settled;
        assert.equal(outcome.ok, true, `${provider} run rejected`);
      }

      for (const { provider, hosts, host, bindingKeys } of readings) {
        assert.equal(hosts.length, 1, `expected exactly one live ${provider} host`);
        assert.equal(host?.provider, provider);
        assert.equal(host?.mode, 'per-run');
        assert.equal(host?.state, 'busy');
        assert.deepEqual(bindingKeys, [sessions[provider]]);
        assert.deepEqual(
          host?.bindings.get(sessions[provider])?.leases.map((lease) => lease.kind),
          ['turn'],
          `expected one turn lease on the ${provider} binding`,
        );
      }
    });
  } finally {
    await fakes.cleanup();
  }
});

/**
 * AC4 — the three providers whose terminal frame and run promise settle in the
 * same tick. Claude is excluded on purpose: its promise settles only once the
 * CLI process has exited, which is the window AC6 reads as `lingering`.
 */
test('AC4: finished turns close their host turn-complete', async (t) => {
  t.mock.method(Codex.prototype, 'startThread', () => createCodexThread(CODEX_TURN_EVENTS));
  const fakes = await createFakes();
  const service = createService();

  try {
    await fakes.install();
    await fakes.run(async () => {
      for (const provider of ['codex', 'cursor', 'opencode'] as const) {
        const appSessionId = `ac4-${provider}`;
        const leg = dispatch(service, provider, appSessionId);
        const outcome = await leg.settled;
        assert.equal(outcome.ok, true, `${provider} run rejected`);

        const host = hostsBoundTo(appSessionId)[0];
        console.log(`provider=${provider} state=${host?.state} closeReason=${host?.closeReason}`);
        assert.equal(host?.state, 'closed');
        assert.equal(host?.closeReason, 'turn-complete');
        assert.equal(liveHosts(provider).length, 0, `expected no live ${provider} host`);
        assert.ok(
          frameKinds(leg.writer.frames).includes('session_created'),
          `the ${provider} forged stream produced no session_created frame`,
        );
        // The terminal frame is unchanged in shape: the wrapper adds nothing.
        assert.equal(frameKinds(leg.writer.frames).at(-1), 'complete');
      }
    });
  } finally {
    await fakes.cleanup();
  }
});

/**
 * AC5 — dispatch, then stop the turn through the same call the websocket
 * `chat.abort` path uses. The fake announces itself so the abort cannot race the
 * spawn, and the run is expected to reject once its process is killed.
 */
test('AC5: an aborted turn closes its host aborted', async () => {
  const opencodeBin = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-abort-'));
  const readyFile = path.join(opencodeBin, 'ready');
  const previousPath = process.env.PATH;
  const service = createService();

  try {
    await writeExecutable(opencodeBin, 'opencode', OPENCODE_ABORT_FAKE_SOURCE);
    process.env.PATH = `${opencodeBin}${path.delimiter}${previousPath ?? ''}`;
    await withEnv({ SESSION_HOSTS_FAKE_READY: readyFile }, async () => {
      const leg = dispatch(service, 'opencode', 'ac5-opencode');

      const deadline = Date.now() + 10_000;
      while (!existsSync(readyFile)) {
        if (Date.now() > deadline) {
          throw new Error('the fake opencode CLI never announced itself');
        }
        await delay(15);
      }

      const hostId = hostsBoundTo('ac5-opencode')[0]?.hostId;
      const aborted = await service.abort('opencode', 'ac5-opencode');
      const host = hostsBoundTo('ac5-opencode')[0];
      console.log(`provider=opencode abort=${aborted} closeReason=${host?.closeReason}`);
      assert.equal(aborted, true);
      assert.equal(host?.hostId, hostId);
      assert.equal(host?.state, 'closed');
      assert.equal(host?.closeReason, 'aborted');

      // The killed run rejects; the host must stay aborted rather than be
      // re-closed by the settling promise.
      const outcome = await leg.settled;
      assert.equal(outcome.ok, false);
      assert.equal(hostsBoundTo('ac5-opencode')[0]?.closeReason, 'aborted');
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(opencodeBin, { recursive: true, force: true });
  }
});

/**
 * AC6 — Claude's holding period, with the codex leg as its positive control.
 *
 * Both runs live in the same window: by the time Claude reads `lingering`, the
 * codex turn — same terminal frame, no hold — is already `closed` with
 * `turn-complete`, so the reading cannot be true of every provider.
 */
test('AC6: a held run reads lingering and is released when it settles', async (t) => {
  t.mock.method(Codex.prototype, 'startThread', () => createCodexThread(CODEX_TURN_EVENTS));
  const claudeBin = await mkdtemp(path.join(os.tmpdir(), 'session-hosts-hold-'));
  const claudeCli = await writeExecutable(claudeBin, 'claude', CLAUDE_FAKE_SOURCE);
  const releaseFile = path.join(claudeBin, 'release');
  const service = createService();

  try {
    await withEnv(
      {
        CLAUDE_CLI_PATH: claudeCli,
        SESSION_HOSTS_FAKE_BACKGROUND: '1',
        SESSION_HOSTS_FAKE_RELEASE: releaseFile,
      },
      async () => {
        const claudeLeg = dispatch(service, 'claude', 'ac6-claude');
        const codexLeg = dispatch(service, 'codex', 'ac6-codex');

        // The held reading is captured while the run is still pending. Both the
        // release and the awaits happen before any assertion, so a failed held
        // reading cannot leave a held CLI (and its pending run) behind.
        let heldReadingFailed = false;
        try {
          await waitForHost(
            'ac6-claude',
            (host) => host.state === 'lingering',
            'the claude host to read lingering',
          );
        } catch {
          heldReadingFailed = true;
        }

        const heldHost = hostsBoundTo('ac6-claude')[0];
        const codexHost = hostsBoundTo('ac6-codex')[0];
        console.log(`provider=claude state=${heldHost?.state} closeReason=${heldHost?.closeReason}`);
        console.log(
          `provider=codex state=${codexHost?.state} closeReason=${codexHost?.closeReason} (positive control)`,
        );

        await writeFile(releaseFile, 'release', 'utf8');
        const claudeOutcome = await claudeLeg.settled;
        const codexOutcome = await codexLeg.settled;
        const released = hostsBoundTo('ac6-claude')[0];
        console.log(
          `provider=claude state=${released?.state} closeReason=${released?.closeReason}`,
        );

        assert.equal(heldReadingFailed, false, 'the claude host never read lingering');
        assert.equal(heldHost?.state, 'lingering');
        assert.equal(heldHost?.closeReason, null);
        assert.equal(
          heldHost?.bindings.get('ac6-claude')?.state,
          'idle',
          'the turn lease must already be gone while the host is held',
        );
        assert.equal(codexHost?.state, 'closed');
        assert.equal(codexHost?.closeReason, 'turn-complete');
        assert.equal(claudeOutcome.ok, true, 'the released claude run rejected');
        assert.equal(released?.state, 'closed');
        assert.equal(released?.closeReason, 'released');
        assert.equal(codexOutcome.ok, true);
      },
    );
  } finally {
    await rm(claudeBin, { recursive: true, force: true });
  }
});

/**
 * AC9 — the wrapper only observes.
 *
 * The same forged stream is run twice: once straight into the runtime, once
 * through the dispatcher. `id` and `timestamp` are dropped from the comparison
 * because `createNormalizedMessage` mints them per frame as it sends — envelope
 * bookkeeping that no wrapper could carry across two runs. The claim under test
 * is that no frame is added, reordered or swallowed.
 */
test('AC9: the dispatched frame sequence is identical to the unwrapped one', async (t) => {
  t.mock.method(Codex.prototype, 'startThread', () => createCodexThread(CODEX_TURN_EVENTS));
  const codexProvider = providerRegistry.resolveProvider('codex');
  const service = createService();

  const directWriter = createWriter();
  await codexProvider.runtime.run(
    'hello there',
    { sessionId: 'ac9-direct', cwd: process.cwd() },
    directWriter,
    createContext(codexProvider),
  );

  const viaWriter = createWriter();
  await service.run(
    'codex',
    'hello there',
    { sessionId: 'ac9-via-service', cwd: process.cwd() },
    viaWriter,
  );

  const stable = (frames: unknown[]) =>
    frames.map((frame) => {
      const copy = { ...(frame as Record<string, unknown>) };
      delete copy.id;
      delete copy.timestamp;
      return copy;
    });

  console.log(
    `frames-direct=${directWriter.frames.length} frames-via-service=${viaWriter.frames.length}`,
  );
  assert.ok(directWriter.frames.length > 1, 'the forged stream must produce more than the complete frame');
  assert.equal(viaWriter.frames.length, directWriter.frames.length);
  assert.deepEqual(stable(viaWriter.frames), stable(directWriter.frames));
  assert.deepEqual(frameKinds(directWriter.frames), frameKinds(viaWriter.frames));
});
