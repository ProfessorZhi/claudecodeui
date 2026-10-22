/**
 * Criterion: the OAuth/MCP request log line.
 *
 * Drives the production logger (`createOAuthRequestLogger`) over real HTTP
 * (`app.listen(0)` + `fetch`) in front of stub routes that answer the way the
 * real ones do: a token endpoint refusing with `invalid_grant`, a consent POST
 * redirecting to a callback whose query carries a code and a state, a consent
 * error page, the SPA consent JSON paths (`/api/oauth/authorize/context` and
 * `/decision`, whose request carries `state`/`code_challenge` in the query or a
 * JSON body and whose response carries a `redirectTo` with a `code` inside the
 * body), and an `/mcp` 401. The claim has two halves:
 *
 *  1. The line says what happened — method, path, status, the OAuth `error` or the
 *     HTML message, the redirect target's origin and path, the client id's first
 *     eight characters, the grant type, the bearer token's class, Cloudflare's
 *     address and ray id — so "never arrived" and "arrived and was refused" can
 *     be told apart from the server's own log.
 *  2. The line never carries a secret. Every sensitive value the requests send
 *     (code, verifier, client secret, refresh token, password, state, a bearer
 *     token, a redirect query, a code challenge) is planted with a unique marker,
 *     and no line may contain any marker.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createOAuthRequestLogger } from '@/modules/oauth/index.js';

const SECRETS = {
  code: 'SECRETCODE-7f3a91',
  verifier: 'SECRETVERIFIER-b82c40',
  clientSecret: 'SECRETCLIENTSECRET-19de55',
  refreshToken: 'ccr_SECRETREFRESH-a0c7d3',
  password: 'SECRETPASSWORD-5e6f21',
  state: 'SECRETSTATE-c4b8a6',
  codeChallenge: 'SECRETCHALLENGE-1e42a8',
  bearer: 'ccp_SECRETBEARER-93ab12',
};
const CLIENT_ID = '3b3dae8d788d0c9c867a1fc7820fde05';
const REDIRECT_URI = 'https://oauth-redirect.example/r/abc';

async function withLoggedApp(run: (call: (path: string, init?: RequestInit) => Promise<Response>, lines: string[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const app = express();
  // The same prefix set the server entrypoint mounts the logger on — including the
  // SPA consent JSON API, which is NOT under `/oauth`.
  app.use(['/oauth', '/api/oauth/authorize', '/mcp'], createOAuthRequestLogger({ log: (line) => lines.push(line) }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.post('/oauth/token', (_req, res) => res.status(400).json({ error: 'invalid_grant' }));
  app.post('/oauth/authorize', (_req, res) =>
    res.redirect(302, `https://oauth-redirect.example/r/abc?code=${SECRETS.code}&state=${SECRETS.state}`));
  app.get('/oauth/authorize', (_req, res) =>
    res.status(400).type('html').send('<html><body><h1>Authorization error</h1><p>redirect_uri is not registered for this client</p></body></html>'));
  // The SPA consent JSON API stubs: the request carries `state`/`code_challenge`
  // (query or body) and the decision response carries a `code` inside its
  // `redirectTo` BODY — a value the logger never reads.
  app.get('/api/oauth/authorize/context', (_req, res) =>
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' }));
  app.post('/api/oauth/authorize/decision', (_req, res) =>
    res.status(200).json({ redirectTo: `${REDIRECT_URI}?code=${SECRETS.code}&state=${SECRETS.state}` }));
  app.post('/mcp', (_req, res) => res.status(401).json({ error: 'invalid_token' }));
  app.get('/api/other', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run((path, init) => fetch(`${base}${path}`, { redirect: 'manual', ...init }), lines);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) };
}

function json(fields: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) };
}

test('(a) a refused token exchange logs the status, the OAuth error, the grant type and the client prefix', async () => {
  await withLoggedApp(async (call, lines) => {
    await call('/oauth/token', form({
      grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRETS.clientSecret,
      code: SECRETS.code, code_verifier: SECRETS.verifier, redirect_uri: 'https://x.example/cb',
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.match(line, /^\[OAuthReq\] POST \/oauth\/token -> 400 invalid_grant /);
    assert.match(line, / client=3b3dae8d /);
    assert.match(line, / grant=authorization_code /);
    console.log(`(a) ${line}`);
  });
});

test('(b) a consent redirect logs the callback origin and path but never its query', async () => {
  await withLoggedApp(async (call, lines) => {
    await call('/oauth/authorize', form({ client_id: CLIENT_ID, password: SECRETS.password, state: SECRETS.state }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(lines[0], / -> 302 redirect=https:\/\/oauth-redirect\.example\/r\/abc /);
    assert.ok(!lines[0].includes('code='), 'the redirect query carries the code and must not be logged');
    console.log(`(b) ${lines[0]}`);
  });
});

test('(c) an HTML error page logs its message', async () => {
  await withLoggedApp(async (call, lines) => {
    await call(`/oauth/authorize?client_id=${CLIENT_ID}&state=${SECRETS.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(lines[0], / -> 400 msg="redirect_uri is not registered for this client" /);
    console.log(`(c) ${lines[0]}`);
  });
});

test('(d) the bearer token is reduced to its class, and Cloudflare headers are reported', async () => {
  await withLoggedApp(async (call, lines) => {
    await call('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRETS.bearer}`, 'cf-connecting-ip': '203.0.113.9', 'cf-ray': 'a4609eab12cd-NRT', 'user-agent': 'Google-Test/1.0' },
    });
    await call('/mcp', { method: 'POST', headers: { authorization: 'Bearer cca_whatever' } });
    await call('/mcp', { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(lines[0], / auth=ccp ip=203\.0\.113\.9 ray=a4609eab12cd-NRT ua="Google-Test\/1\.0"/);
    assert.match(lines[1], / auth=cca /);
    assert.match(lines[2], / auth=none /);
    console.log(`(d) ${lines[0]}`);
  });
});

test('(e) control characters in a header cannot break the line, and unrelated paths log nothing', async () => {
  await withLoggedApp(async (call, lines) => {
    await call('/oauth/token', { ...form({ grant_type: 'authorization_code', client_id: CLIENT_ID }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'evil\tagent' } });
    await call('/api/other');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines.length, 1, 'only the OAuth/MCP prefixes are logged');
    assert.ok(!/[\r\n\t]/.test(lines[0]), 'one request is exactly one line');
  });
});

test('(f) no secret value any request carries appears in any line', async () => {
  await withLoggedApp(async (call, lines) => {
    await call('/oauth/token', form({
      grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: SECRETS.clientSecret, refresh_token: SECRETS.refreshToken,
      code: SECRETS.code, code_verifier: SECRETS.verifier,
    }));
    await call('/oauth/authorize', form({ client_id: CLIENT_ID, password: SECRETS.password, state: SECRETS.state, code_verifier: SECRETS.verifier }));
    await call(`/oauth/authorize?client_id=${CLIENT_ID}&state=${SECRETS.state}&code=${SECRETS.code}`);
    await call(
      `/api/oauth/authorize/context?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&state=${SECRETS.state}&code_challenge=${SECRETS.codeChallenge}`,
    );
    await call('/api/oauth/authorize/decision', json({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: SECRETS.state,
      code_challenge: SECRETS.codeChallenge, code_challenge_method: 'S256', scopes: ['cloudcli:read'], action: 'allow',
    }));
    await call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${SECRETS.bearer}` } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines.length, 6);
    const everything = lines.join('\n');
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!everything.includes(value), `${name} must never appear in a log line`);
      assert.ok(!everything.includes(value.slice(0, 12)), `no prefix of ${name} may appear either`);
    }
    console.log(`(f) 6 lines, ${Object.keys(SECRETS).length} planted secrets, 0 leaked`);
  });
});

test('(g) the SPA consent JSON paths log the path (query stripped), the status and the error, and never the body', async () => {
  await withLoggedApp(async (call, lines) => {
    await call(
      `/api/oauth/authorize/context?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&state=${SECRETS.state}&code_challenge=${SECRETS.codeChallenge}`,
    );
    await call('/api/oauth/authorize/decision', json({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: SECRETS.state,
      code_challenge: SECRETS.codeChallenge, code_challenge_method: 'S256', scopes: ['cloudcli:read'], action: 'allow',
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines.length, 2);
    // The JSON API is logged exactly like the form routes: the query is dropped
    // from the path and the §5.2 `error` is surfaced.
    assert.match(lines[0], /^\[OAuthReq\] GET \/api\/oauth\/authorize\/context -> 400 invalid_request /);
    assert.match(lines[0], / client=3b3dae8d /);
    assert.ok(!lines[0].includes('state='), 'the query string (which carries state/code_challenge) must be dropped');
    // The decision answer is a JSON body carrying `redirectTo` — there is no
    // Location header, so the logger reports none and cannot leak the code.
    assert.match(lines[1], /^\[OAuthReq\] POST \/api\/oauth\/authorize\/decision -> 200 redirect=- /);
    assert.match(lines[1], / client=3b3dae8d /);
    console.log(`(g) ${lines[0]}`);
    console.log(`(g) ${lines[1]}`);
  });
});
