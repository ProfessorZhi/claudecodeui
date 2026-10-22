import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import { connectedClients } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withProviderServer(
  run: (baseUrl: string, workspacePath: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-rename-route-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, path.join(tempDirectory, 'workspace'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const rename = (baseUrl: string, sessionId: string, body: unknown) =>
  fetch(`${baseUrl}/api/providers/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const storedName = (sessionId: string): { name: string | null; source: string | null } => {
  const row = sessionsDb.getSessionById(sessionId);
  return { name: row?.custom_name ?? null, source: row?.name_source ?? null };
};

/** The title the session list reports for one session. */
async function listedTitle(baseUrl: string, sessionId: string): Promise<string | undefined> {
  const response = await fetch(`${baseUrl}/api/providers/sessions/recent`);
  const payload = await response.json() as {
    data: { conversations: Array<{ sessionId: string; sessionTitle: string }> };
  };
  return payload.data.conversations.find((entry) => entry.sessionId === sessionId)?.sessionTitle;
}

test('renaming a session through the route records it as manual and lists the new name', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createSession('cli-rename-1', 'claude', workspacePath, 'first prompt');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The session-hosts listing is read by the sidebar's resident-mark rows, and a rename changes the name
    // that row publishes. So the rename has to announce a listing revision the same way a host transition
    // does — otherwise the mark's row waits out the fallback poll instead of catching up in the next beat.
    // The composition root turns this announcement into the `hosts_changed` frame; what this reading fixes
    // is the rename path's own half: the manager really is told.
    const revisions: number[] = [];
    const unsubscribe = sessionHostManager.onChange((rev) => revisions.push(rev));

    let response: Awaited<ReturnType<typeof rename>>;
    try {
      response = await rename(baseUrl, 'cli-rename-1', { summary: 'Renamed From The UI' });
    } finally {
      unsubscribe();
    }

    assert.equal(response.status, 200);
    const payload = await response.json() as { data: { sessionId: string; summary: string } };
    assert.equal(payload.data.summary, 'Renamed From The UI');
    assert.deepEqual(storedName('cli-rename-1'), { name: 'Renamed From The UI', source: 'manual' });
    assert.equal(await listedTitle(baseUrl, 'cli-rename-1'), 'Renamed From The UI');
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'cli-rename-1');
    assert.equal(
      revisions.length,
      1,
      `a rename must announce exactly one listing revision; the manager saw ${revisions.length}`,
    );
  });
});

test('renaming a session that does not exist changes nothing and tells no one', async () => {
  await withProviderServer(async (baseUrl) => {
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    // The control for the case above: a rename that found nothing must announce no listing revision, so the
    // "exactly one" there is a reading of the successful path rather than of a manager that always fires.
    const revisions: number[] = [];
    const unsubscribe = sessionHostManager.onChange((rev) => revisions.push(rev));

    let response: Awaited<ReturnType<typeof rename>>;
    try {
      response = await rename(baseUrl, 'never-existed', { summary: 'Renamed From The UI' });
    } finally {
      unsubscribe();
    }

    assert.equal(response.status, 404);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'SESSION_NOT_FOUND');
    assert.equal(
      sessionsDb.getSessionById('never-existed'),
      null,
      'a rename must not create the session it could not find',
    );
    assert.deepEqual(connection.frames, []);
    assert.equal(revisions.length, 0, 'a rename that changed nothing must announce nothing');
  });
});

test('a rename the provider cannot write back is still stored, broadcast, and answered 200', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    // Codex keeps no writable session title, so this rename has nowhere to go
    // on disk. That must not be visible in the response: the app-side half of a
    // rename is complete on its own, and a rename that reached no provider store
    // is still a rename the user made and every client has to hear about.
    const transcriptPath = path.join(workspacePath, 'rollout-codex-1.jsonl');
    await mkdir(workspacePath, { recursive: true });
    await writeFile(transcriptPath, '{"type":"session_meta"}\n', 'utf8');
    sessionsDb.createSession(
      'codex-rename-1',
      'codex',
      workspacePath,
      'first prompt',
      undefined,
      undefined,
      transcriptPath,
    );
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    const response = await rename(baseUrl, 'codex-rename-1', { summary: 'Renamed On Codex' });

    assert.equal(response.status, 200);
    assert.deepEqual(storedName('codex-rename-1'), { name: 'Renamed On Codex', source: 'manual' });
    assert.equal(connection.frames.length, 1);
    assert.equal(connection.frames[0].sessionId, 'codex-rename-1');
    assert.equal(
      await readFile(transcriptPath, 'utf8'),
      '{"type":"session_meta"}\n',
      'a provider with no writable title must leave its own files alone',
    );
  });
});

test('an empty or over-long name is rejected without touching the stored one', async () => {
  await withProviderServer(async (baseUrl, workspacePath) => {
    sessionsDb.createSession('cli-rename-2', 'claude', workspacePath, 'first prompt');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);

    for (const body of [
      { summary: '' },
      { summary: '   ' },
      { summary: 'x'.repeat(501) },
      { notASummary: 'Renamed From The UI' },
    ]) {
      const response = await rename(baseUrl, 'cli-rename-2', body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 40)}`);
      const payload = await response.json() as { error: { code: string } };
      assert.equal(payload.error.code, 'INVALID_SESSION_SUMMARY');
    }

    assert.deepEqual(storedName('cli-rename-2'), { name: 'first prompt', source: 'derived' });
    assert.deepEqual(connection.frames, []);

    // The longest name the route does accept still lands.
    const accepted = await rename(baseUrl, 'cli-rename-2', { summary: 'x'.repeat(500) });
    assert.equal(accepted.status, 200);
    assert.equal(storedName('cli-rename-2').name?.length, 500);
  });
});
