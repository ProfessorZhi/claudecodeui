import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

import type { McpWriteToolDeps } from '../index.js';

// Temporary DB/workspaces always follow the launcher-owned artifact TMPDIR.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'mcp-project-delete-'));
process.env.DATABASE_PATH = path.join(scratch, 'projects.db');
process.env.JWT_SECRET = 'isolated-project-delete-test-only';
const { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { deleteOrArchiveProject } = await import('@/modules/projects/index.js');
const { createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');
await initializeDatabase();
getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('project-delete-owner', 'fixture');
const tokens = createAccessTokensService({ now: () => new Date() });
function issue(scopes: string[]): string {
  const result = tokens.issueToken({ userId: 1, scopes });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Fixture scope issuance failed.');
  return result.token.token;
}
const controlToken = issue(['cloudcli:session:control']);
const readToken = issue(['cloudcli:read']);
const app = express();
app.use(express.json());
mountMcpGateway(app, {
  env: { MCP_ENABLED: 'true' },
  authorize: createMcpAuthMiddleware(tokens),
  writeTools: {
    // The REAL service under test, not a stand-in: the acceptance reading is that
    // "delete" means what the projects module already means by it.
    projectDelete: {
      readProject: (projectId: string) => {
        const row = projectsDb.getProjectById(projectId);
        return row === null ? null : { projectId: row.project_id, path: row.project_path, isArchived: row.isArchived !== 0 };
      },
      deleteProject: deleteOrArchiveProject,
    },
  } as unknown as McpWriteToolDeps,
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as AddressInfo).port;
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
});

let requestId = 0;
async function rpc(method: string, params: Record<string, unknown>, token?: string): Promise<{ status: number; body: any }> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        const body = text.startsWith('event:') || text.startsWith('data:')
          ? JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))!.slice(5))
          : JSON.parse(text);
        resolve({ status: res.statusCode!, body });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
async function call(args: Record<string, unknown>, token = controlToken): Promise<any> {
  const result = await rpc('tools/call', { name: 'project_delete', arguments: args }, token);
  assert.equal(result.status, 200);
  return result.body.result;
}
function assertError(result: any, code: string): void {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.code, code, JSON.stringify(result));
  assert.equal(result.structuredContent.retryable, false);
}

/** One project directory plus one session row whose transcript file really exists. */
function fixture(label: string): { projectId: string; directory: string; transcript: string; sessionId: string } {
  const directory = path.join(scratch, label);
  mkdirSync(directory, { recursive: true });
  const transcript = path.join(scratch, `${label}.jsonl`);
  writeFileSync(transcript, '{"type":"fixture"}\n');
  const created = projectsDb.createProjectPath(directory, label);
  assert.equal(created.outcome, 'created', 'the fixture project row must be created');
  const row = created.project;
  assert.ok(row, 'the created project must come back with its row');
  const sessionId = `${label}-session`;
  const stamp = new Date().toISOString();
  sessionsDb.createSession(sessionId, 'claude', directory, `${label} session`, stamp, stamp, transcript);
  return { projectId: row.project_id, directory, transcript, sessionId };
}

test('project_delete is authenticated, discoverable, and accurately annotated', async () => {
  assert.equal((await rpc('tools/list', {})).status, 401);
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'project-delete-acceptance', version: '1' } }, controlToken);
  assert.equal(initialized.status, 200);
  assert.ok(initialized.body.result.serverInfo);
  const listed = await rpc('tools/list', {}, controlToken);
  const tool = listed.body.result.tools.find((entry: any) => entry.name === 'project_delete');
  assert.ok(tool, 'project_delete must be advertised by the real mount');
  assert.deepEqual(tool.inputSchema.required, ['projectId']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.ok(tool._meta['cloudcli/errorCodes'].includes('PROJECT_NOT_FOUND'));
  assert.equal(tool._meta['cloudcli/handlerBound'], true);
});

test('a read-only token cannot archive or remove anything', async () => {
  const f = fixture('scope-denied');
  assertError(await call({ project: f.projectId }, readToken), 'INSUFFICIENT_SCOPE');
  assert.ok(projectsDb.getProjectById(f.projectId), 'the refused call must leave the row in place');
  assert.equal(projectsDb.getProjectById(f.projectId)!.isArchived, 0);
});

test('the default archives the row and leaves the directory and transcript alone', async () => {
  const f = fixture('archived');
  const result = await call({ projectId: f.projectId });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.structuredContent, {
    projectId: f.projectId,
    path: f.directory,
    wasArchived: false,
    archived: true,
    deleted: false,
    directoryRemoved: false,
  });
  assert.equal(projectsDb.getProjectById(f.projectId)!.isArchived, 1);
  assert.ok(existsSync(f.directory), 'archiving must not touch the project directory');
  assert.ok(existsSync(f.transcript), 'archiving must not touch any transcript');
});

test('force removes the rows and the transcript files but never the directory', async () => {
  const f = fixture('removed');
  const result = await call({ projectId: f.projectId, force: true });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.deleted, true);
  assert.equal(result.structuredContent.archived, false);
  assert.equal(result.structuredContent.directoryRemoved, false, 'the tool must say plainly that it does not remove directories');
  assert.equal(projectsDb.getProjectById(f.projectId), null);
  assert.equal(sessionsDb.getSessionById(f.sessionId), null);
  assert.equal(existsSync(f.transcript), false, 'force delete removes the stored transcripts');
  assert.ok(existsSync(f.directory), 'the directory is the caller\'s to remove, not this tool\'s');
});

test('an unknown project id is PROJECT_NOT_FOUND and repeats are the same honest refusal', async () => {
  assertError(await call({ projectId: 'no-such-project' }), 'PROJECT_NOT_FOUND');
  const f = fixture('twice');
  assert.equal((await call({ projectId: f.projectId, force: true })).isError, undefined);
  // The second call finds no row: it reports NOT_FOUND rather than a second
  // "deleted", so a lost response cannot be mistaken for a no-op success.
  assertError(await call({ projectId: f.projectId, force: true }), 'PROJECT_NOT_FOUND');
});
