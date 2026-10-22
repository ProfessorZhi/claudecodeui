// ⛔ 溯源（勿删）：本文件是 model-library 的**网关端到端判据**（AC-025）—— 测试内起 mock Anthropic
// 兼容端点，经真实 chat.send（options.model = 模型条目 id、⛔ 不携带任何 env）跑一轮，断言请求真的打到
// mock、认证头来自模型条目的 secret 行、且宿主 ANTHROPIC_API_KEY 不出现。它钉住的是一条真实链路，
// 不是 mock 自证。权威记录：goals/AC-025-gateway-request-lands-with-the-credential-from-a-model-entry.md
// （criterion 即本文件）。
//
// 本文件原居 server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts，由 1d76cac6
// （gap-launch-profiles-relocate-shared-compile-layer，搬迁共享编译层）整体迁到 providers，内容逐字
// 未改（新旧路径 git diff 为空，五个用例一个不减）；随后 b34a662e（拆除 launch-profiles 实体）删掉了
// 整个旧目录，旧路径已不复存在。
//
// 因此：随共享编译层**再次搬迁是允许的**，但搬迁必须同步修正 AC-025 记录的 criterion 路径（见
// gap-ac-025-criterion-repoint-to-migrated-test）。**删除本文件、或放宽其中任一断言不是允许的** ——
// 那会让 AC-025 失去它唯一钉住的属性。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, providerModelsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { createProviderRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

const SESSION_ID = 'model-gateway-e2e-session';
const MODEL_ID = 'gw-custom-model';
const MODEL_SECRET = 'model-row-secret-token';
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

type Received = { url: string; authorization: string | undefined; apiKey: string | undefined; headers: Record<string, string | string[] | undefined> };

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Minimal valid streaming `/v1/messages` reply. */
function messageStream(): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

async function startMockAnthropic(): Promise<{ received: Received[]; baseUrl: string; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
        headers: { ...req.headers },
      });
      if ((req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(messageStream());
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/** Drives one real `chat.send` through the real Claude runtime and waits for the run to finish. */
async function runChatSend(
  modelRows: ProviderModelEnvRow[],
  model: string,
  extraOptions: Record<string, unknown>,
  waitMs: number,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'model-gateway-e2e-'));
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
  // The host default endpoint is a dead local port: a run that ignores the model entry can never reach the mock.
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await initializeDatabase();
  const user = userDb.createUser('model-gateway-e2e', 'unused-hash');

  const socket = createFakeSocket();
  const runtime = createProviderRuntimeService();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Model gateway session', now, now, null);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run(SESSION_ID);
    providerModelsDb.createCustomProviderModel('claude', { id: MODEL_ID, model: MODEL_ID, config: { env: modelRows } });

    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'hello',
      options: { cwd: tempDirectory, model, permissionMode: 'default', ...extraOptions },
    }));

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !socket.frames.some((frame) => frame.kind === 'complete')) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  } finally {
    await runtime.abort('claude', SESSION_ID).catch(() => false);
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // The aborted SDK child can still be flushing into `claude-config` for a moment; under suite
    // concurrency that turned the teardown into ENOTEMPTY. `maxRetries` re-runs the removal on it.
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

function messagesRequests(received: Received[]): Received[] {
  return received.filter((request) => request.url.startsWith('/v1/messages'));
}

function gatewayRows(baseUrl: string, withUnset: boolean): ProviderModelEnvRow[] {
  const rows: ProviderModelEnvRow[] = [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
  ];
  if (withUnset) rows.push({ key: 'ANTHROPIC_API_KEY', kind: 'unset' });
  return rows;
}

/** The anti-leak contract: the host Anthropic key must appear in no header the gateway received. */
function assertNoHostKeyLeak(received: Received[]): void {
  for (const request of received) {
    assert.ok(request.apiKey === undefined, 'no x-api-key header reaches the gateway');
    assert.ok(
      !JSON.stringify(request.headers).includes(HOST_SENTINEL),
      'host ANTHROPIC_API_KEY sentinel must not appear in any header',
    );
  }
}

test('(a) custom model: chat.send reaches the mock endpoint with the secret-row credential', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await runChatSend(gatewayRows(mock.baseUrl, true), MODEL_ID, {}, 60_000);
    const requests = messagesRequests(mock.received);
    assert.ok(requests.length >= 1, 'mock received at least one /v1/messages request');
    for (const request of requests) {
      assert.strictEqual(request.authorization, `Bearer ${MODEL_SECRET}`);
    }
  } finally {
    await mock.close();
  }
});

test('(b) unset row: the host ANTHROPIC_API_KEY never reaches the gateway', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await runChatSend(gatewayRows(mock.baseUrl, true), MODEL_ID, {}, 60_000);
    assert.ok(messagesRequests(mock.received).length >= 1, 'request reached the mock');
    assertNoHostKeyLeak(mock.received);
  } finally {
    await mock.close();
  }
});

test('(b-fake) without the unset row the leak assertion goes red', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await runChatSend(gatewayRows(mock.baseUrl, false), MODEL_ID, {}, 60_000);
    assert.ok(messagesRequests(mock.received).length >= 1, 'request reached the mock');
    assert.throws(() => assertNoHostKeyLeak(mock.received), 'removing the unset row must trip the anti-leak assertion');
  } finally {
    await mock.close();
  }
});

test('(c) built-in model: the request does not reach the mock', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await runChatSend(gatewayRows(mock.baseUrl, true), 'sonnet', {}, 8_000);
    assert.strictEqual(mock.received.length, 0);
  } finally {
    await mock.close();
  }
});

test('(d) forged options.env is ignored: the model entry credential and endpoint win', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    await runChatSend(gatewayRows(mock.baseUrl, true), MODEL_ID, {
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'forged-token', ANTHROPIC_API_KEY: 'forged-key' },
    }, 60_000);
    const requests = messagesRequests(mock.received);
    assert.ok(requests.length >= 1, 'request still reached the mock despite forged env');
    for (const request of requests) {
      assert.strictEqual(request.authorization, `Bearer ${MODEL_SECRET}`);
    }
    assertNoHostKeyLeak(mock.received);
    assert.ok(!JSON.stringify(mock.received).includes('forged'), 'no forged value reaches the gateway');
  } finally {
    await mock.close();
  }
});
