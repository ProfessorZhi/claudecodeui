import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { searchConversations, sessionsService } from '@/modules/providers/index.js';
import projectsRoutes from '@/modules/projects/projects.routes.js';

const PROJECT_PATH = '/workspace/filter-project';
const OTHER_PROJECT_PATH = '/workspace/unfiltered-project';

async function withServer(run: (baseUrl: string, projectId: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-session-filter-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoutes);
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: { message: error.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    // 30 sessions: 20 named "...-task-worker", 10 human ones; distinct timestamps for stable ordering.
    for (let index = 0; index < 30; index += 1) {
      const isWorker = index < 20;
      const stamp = `2026-01-01 00:${String(index).padStart(2, '0')}:00`;
      sessionsDb.createSession(
        `sess-${index}`,
        'claude',
        PROJECT_PATH,
        isWorker ? `role-${index}-task-worker` : `human-${index}`,
        stamp,
        stamp,
      );
    }
    sessionsDb.createSession('other-1', 'claude', OTHER_PROJECT_PATH, 'x-task-worker', '2026-02-01 00:00:00', '2026-02-01 00:00:00');
    const project = projectsDb.getProjectPath(PROJECT_PATH);
    assert.ok(project);
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, project.project_id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function putFilter(baseUrl: string, projectId: string, hide: unknown) {
  return fetch(`${baseUrl}/api/projects/${projectId}/session-filter`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hide }),
  });
}

type Page = { sessions: Array<{ id: string }>; sessionMeta: { total: number; hasMore: boolean; hiddenCount: number }; hiddenCount: number };

async function getPage(baseUrl: string, projectId: string, query: string): Promise<Page> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/sessions?${query}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Page>;
}

test('server-side name filter paginates consistently and honours includeHidden / keepSessionIds', async () => {
  await withServer(async (baseUrl, projectId) => {
    const saved = await putFilter(baseUrl, projectId, ['-task-worker$']);
    assert.equal(saved.status, 200);

    const seen: string[] = [];
    for (let offset = 0; ; offset += 5) {
      const page = await getPage(baseUrl, projectId, `limit=5&offset=${offset}`);
      assert.equal(page.sessionMeta.total, 10);
      assert.equal(page.sessionMeta.hiddenCount, 20);
      assert.equal(page.hiddenCount, 20);
      assert.equal(page.sessionMeta.hasMore, offset + page.sessions.length < 10);
      seen.push(...page.sessions.map((session) => session.id));
      if (!page.sessionMeta.hasMore) break;
    }
    assert.equal(seen.length, 10);
    assert.ok(seen.every((id) => Number(id.replace('sess-', '')) >= 20));

    const all = await getPage(baseUrl, projectId, 'limit=200&includeHidden=true');
    assert.equal(all.sessions.length, 30);
    assert.equal(all.sessionMeta.total, 30);

    const kept = await getPage(baseUrl, projectId, 'limit=200&keepSessionIds=sess-3,sess-4');
    assert.equal(kept.sessions.length, 12);
    assert.ok(kept.sessions.some((session) => session.id === 'sess-3'));
    assert.equal(kept.hiddenCount, 18);
  });
});

test('invalid filters return 400 with a line number and preview never writes', async () => {
  await withServer(async (baseUrl, projectId) => {
    const bad = await putFilter(baseUrl, projectId, ['fine', '(broken']);
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await bad.json()), /Line 2/);
    assert.equal(projectsDb.getProjectSessionFilterById(projectId), null);

    const preview = await fetch(`${baseUrl}/api/projects/${projectId}/session-filter/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hide: ['-task-worker$'] }),
    });
    assert.equal(preview.status, 200);
    const body = await preview.json() as { data: { preview: { matchedCount: number; unmatchedCount: number; matchedSessionNames: string[] } } };
    assert.equal(body.data.preview.matchedCount, 20);
    assert.equal(body.data.preview.unmatchedCount, 10);
    assert.equal(body.data.preview.matchedSessionNames.length, 5);
    assert.equal(projectsDb.getProjectSessionFilterById(projectId), null);
  });
});

test('title search flags hidden sessions and recent list excludes them per project rule', async () => {
  await withServer(async (baseUrl, projectId) => {
    assert.equal((await putFilter(baseUrl, projectId, ['-task-worker$'])).status, 200);

    const search = await searchConversations('task-worker', 50);
    const hitIds = search.titleResults.map((result) => result.sessionId);
    assert.ok(hitIds.includes('sess-0'));
    assert.ok(search.titleResults.filter((result) => result.sessionId.startsWith('sess-')).every((result) => result.filtered === true));
    const otherProject = search.titleResults.find((result) => result.sessionId === 'other-1');
    assert.equal(otherProject?.filtered, false);

    const recent = sessionsService.listRecentSessions(100, 0);
    const recentIds = recent.conversations.map((conversation) => conversation.sessionId);
    assert.ok(!recentIds.includes('sess-0'));
    assert.ok(recentIds.includes('sess-25'));
    assert.ok(recentIds.includes('other-1'));
    assert.equal(recent.total, 11);
  });
});
