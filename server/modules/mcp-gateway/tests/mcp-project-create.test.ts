import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import fsPromises from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

import type { McpWriteToolDeps } from '../index.js';

// Temporary DB/workspaces always follow the launcher-owned artifact TMPDIR.
const scratch = mkdtempSync(path.join(os.tmpdir(), 'mcp-project-create-'));
const workspaceRoot = path.join(scratch, 'workspaces');
mkdirSync(workspaceRoot);
process.env.DATABASE_PATH = path.join(scratch, 'projects.db');
process.env.WORKSPACES_ROOT = workspaceRoot;
process.env.JWT_SECRET = 'isolated-project-create-test-only';
const { closeConnection, getConnection, initializeDatabase, projectsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const projects = await import('@/modules/projects/index.js');
const { createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');
await initializeDatabase();
getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('project-create-owner', 'fixture');
const tokens = createAccessTokensService({ now: () => new Date() });
function issue(scopes: string[]): string {
  const result = tokens.issueToken({ userId: 1, scopes });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Fixture scope issuance failed.');
  return result.token.token;
}
const createToken = issue(['cloudcli:session:create']);
const readToken = issue(['cloudcli:read']);
let configuredRoot: string | undefined = workspaceRoot;
const app = express();
app.use(express.json());
mountMcpGateway(app, {
  env: { MCP_ENABLED: 'true' },
  authorize: createMcpAuthMiddleware(tokens),
  writeTools: {
    projectCreate: {
      createProject: (input: { projectPath: string; customName?: string | null }) => {
        // Dynamic access lets the red test report the missing tool on the wire.
        const create = (projects as unknown as Record<string, (request: typeof input, root?: string) => Promise<unknown>>).createProjectWithinWorkspaceRoot;
        assert.equal(typeof create, 'function');
        return create(input, configuredRoot);
      },
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
async function call(args: Record<string, unknown>, token = createToken): Promise<any> {
  const result = await rpc('tools/call', { name: 'project_create', arguments: args }, token);
  assert.equal(result.status, 200);
  return result.body.result;
}
function assertError(result: any, code: string): void {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.code, code, JSON.stringify(result));
  assert.equal(result.structuredContent.retryable, false);
}

test('project_create is authenticated, discoverable, and accurately annotated', async () => {
  assert.equal((await rpc('tools/list', {})).status, 401);
  const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'project-create-acceptance', version: '1' } }, createToken);
  assert.equal(initialized.status, 200);
  assert.ok(initialized.body.result.serverInfo);
  const listed = await rpc('tools/list', {}, createToken);
  const tool = listed.body.result.tools.find((entry: any) => entry.name === 'project_create');
  assert.ok(tool, 'project_create must be advertised by the real mount');
  assert.deepEqual(tool.inputSchema.required, ['projectPath']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.ok(tool._meta['cloudcli/errorCodes'].includes('INVALID_ARGUMENT'));
});

test('read-only token cannot create directories or project rows', async () => {
  const projectPath = path.join(workspaceRoot, 'scope-denied');
  assertError(await call({ projectPath }, readToken), 'INSUFFICIENT_SCOPE');
  assert.equal(existsSync(projectPath), false);
  assert.equal(projectsDb.getProjectPath(projectPath), null);
});

test('create returns the real DB identity and duplicate active path is a conflict', async () => {
  const projectPath = path.join(workspaceRoot, 'nested', 'new-project');
  const result = await call({ projectPath, customName: 'New project' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.structuredContent;
  assert.ok(content.projectId);
  assert.equal(content.path, projectPath);
  assert.equal(content.displayName, 'New project');
  assert.equal(content.outcome, 'created');
  assert.equal(content.isArchived, false);
  assert.equal(projectsDb.getProjectPath(projectPath)?.project_id, content.projectId);
  assert.equal(existsSync(projectPath), true);
  assertError(await call({ projectPath, customName: 'Different name' }), 'PROJECT_ALREADY_EXISTS');
  assert.equal(projectsDb.getProjectPath(projectPath)?.custom_project_name, 'New project');
});

test('concurrent same-path calls create one row and report the other as conflict', async () => {
  const projectPath = path.join(workspaceRoot, 'concurrent-project');
  const results = await Promise.all([call({ projectPath }), call({ projectPath })]);
  assert.equal(results.filter((result) => result.isError !== true).length, 1);
  assertError(results.find((result) => result.isError), 'PROJECT_ALREADY_EXISTS');
});

test('archived reuse reports its original identity and archived state truthfully', async () => {
  const projectPath = path.join(workspaceRoot, 'archive');
  mkdirSync(projectPath);
  const previous = projectsDb.createProjectPath(projectPath, 'Archive').project!;
  getConnection().prepare('UPDATE projects SET isArchived = 1 WHERE project_id = ?').run(previous.project_id);
  const result = await call({ projectPath });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.projectId, previous.project_id);
  assert.equal(result.structuredContent.outcome, 'reactivated_archived');
  assert.equal(result.structuredContent.isArchived, false);
});

test('unconfigured root, relative paths, equal root, traversal and sibling-prefix escapes are refused', async () => {
  configuredRoot = undefined;
  try { assertError(await call({ projectPath: path.join(workspaceRoot, 'unconfigured') }), 'PROJECT_WORKSPACE_ROOT_REQUIRED'); }
  finally { configuredRoot = workspaceRoot; }
  for (const projectPath of ['relative-project', workspaceRoot, path.join(workspaceRoot, '..', 'escaped'), `${workspaceRoot}-sibling/project`]) {
    assertError(await call({ projectPath }), 'INVALID_PROJECT_PATH');
    assert.equal(projectsDb.getProjectPath(projectPath), null);
  }
  assert.equal(existsSync(path.join(scratch, 'escaped')), false);
  // Root-looking caller input is not authority and cannot override device config.
  assertError(await call({ projectPath: path.join(scratch, 'caller-escape'), workspaceRoot: scratch }), 'INVALID_PROJECT_PATH');
  assert.equal(existsSync(path.join(scratch, 'caller-escape')), false);
});

test('every existing descendant is checked: deep missing paths through a symlink cannot escape', async () => {
  const outside = path.join(scratch, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(workspaceRoot, 'escape-link'), 'dir');
  const inside = path.join(workspaceRoot, 'inside-target');
  mkdirSync(inside);
  symlinkSync(inside, path.join(workspaceRoot, 'inside-link'), 'dir');
  for (const projectPath of [path.join(workspaceRoot, 'escape-link', 'missing', 'nested', 'new'), path.join(workspaceRoot, 'inside-link', 'new')]) {
    assertError(await call({ projectPath }), 'INVALID_PROJECT_PATH');
    assert.equal(projectsDb.getProjectPath(projectPath), null);
  }
  assert.equal(existsSync(path.join(outside, 'missing')), false);
  assert.equal(existsSync(path.join(inside, 'new')), false);
});

test('file path, empty input and malformed names cannot become project directories', async () => {
  const file = path.join(workspaceRoot, 'file');
  writeFileSync(file, 'fixture');
  assertError(await call({ projectPath: file }), 'INVALID_PROJECT_PATH');
  assert.equal(readFileSync(file, 'utf8'), 'fixture');
  assertError(await call({ projectPath: '' }), 'INVALID_ARGUMENT');
  assertError(await call({ projectPath: path.join(workspaceRoot, 'wrong-name'), customName: 42 }), 'INVALID_ARGUMENT');
});


test('requireFresh is advertised and strict success carries a real fresh-directory proof', async () => {
  const listed = await rpc('tools/list', {}, createToken);
  const tool = listed.body.result.tools.find((entry: any) => entry.name === 'project_create');
  assert.equal(tool.inputSchema.properties.requireFresh.type, 'boolean');
  const projectPath = path.join(workspaceRoot, 'strict-success');
  const result = await call({ projectPath, requireFresh: true });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.freshDirectoryCreated, true);
  assert.equal(result.structuredContent.outcome, 'created');
  assert.equal(projectsDb.getProjectPath(projectPath)?.project_id, result.structuredContent.projectId);
});

test('requireFresh refuses an unregistered directory and every registered path without changing rows', async () => {
  const existingDirectory = path.join(workspaceRoot, 'strict-existing-directory');
  mkdirSync(existingDirectory);
  assertError(await call({ projectPath: existingDirectory, requireFresh: true }), 'PROJECT_ALREADY_EXISTS');
  assert.equal(projectsDb.getProjectPath(existingDirectory), null);
  const archivedPath = path.join(workspaceRoot, 'strict-archived');
  mkdirSync(archivedPath);
  const archived = projectsDb.createProjectPath(archivedPath, 'Archived').project!;
  getConnection().prepare('UPDATE projects SET isArchived=1 WHERE project_id=?').run(archived.project_id);
  assertError(await call({ projectPath: archivedPath, requireFresh: true }), 'PROJECT_ALREADY_EXISTS');
  assert.equal(projectsDb.getProjectPath(archivedPath)?.isArchived, 1);
  const registeredMissing = path.join(workspaceRoot, 'strict-registered-missing');
  const missing = projectsDb.createProjectPath(registeredMissing, 'Missing').project!;
  assertError(await call({ projectPath: registeredMissing, requireFresh: true }), 'PROJECT_ALREADY_EXISTS');
  assert.equal(existsSync(registeredMissing), false);
  assert.equal(projectsDb.getProjectPath(registeredMissing)?.project_id, missing.project_id);
});

test('concurrent requireFresh calls yield exactly one fresh creation and one conflict', async () => {
  const projectPath = path.join(workspaceRoot, 'strict-concurrent');
  const results = await Promise.all([call({ projectPath, requireFresh: true }), call({ projectPath, requireFresh: true })]);
  const successes = results.filter((result) => result.isError !== true);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].structuredContent.freshDirectoryCreated, true);
  assertError(results.find((result) => result.isError), 'PROJECT_ALREADY_EXISTS');
});

test('requireFresh final mkdir refuses a directory created after preflight without registering it', async (context) => {
  const projectPath = path.join(workspaceRoot, 'strict-mkdir-race');
  const originalMkdir = fsPromises.mkdir;
  let injected = false;
  context.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof fsPromises.mkdir>) => {
    if (String(args[0]) === projectPath && !injected) {
      injected = true;
      await originalMkdir(projectPath);
    }
    return originalMkdir(...args);
  });
  assertError(await call({ projectPath, requireFresh: true }), 'PROJECT_ALREADY_EXISTS');
  assert.equal(injected, true, 'the competing mkdir must run at the final component');
  assert.equal(projectsDb.getProjectPath(projectPath), null);
});

test('requireFresh persistence cannot reactivate an archived row inserted after exclusive mkdir', async (context) => {
  const projectPath = path.join(workspaceRoot, 'strict-db-race');
  const originalMkdir = fsPromises.mkdir;
  let injectedId: string | undefined;
  context.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof fsPromises.mkdir>) => {
    const result = await originalMkdir(...args);
    if (String(args[0]) === projectPath && !injectedId) {
      injectedId = projectsDb.createProjectPath(projectPath, 'Concurrent archived').project!.project_id;
      getConnection().prepare('UPDATE projects SET isArchived=1 WHERE project_id=?').run(injectedId);
    }
    return result;
  });
  assertError(await call({ projectPath, requireFresh: true }), 'PROJECT_ALREADY_EXISTS');
  assert.ok(injectedId);
  const row = projectsDb.getProjectPath(projectPath)!;
  assert.equal(row.project_id, injectedId);
  assert.equal(row.isArchived, 1);
});
