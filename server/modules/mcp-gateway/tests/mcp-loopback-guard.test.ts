/**
 * `/mcp` local-only guard criterion (AC-242; GOAL-020 exit condition 4, SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §415/§416/§495/§522).
 *
 * While `MCP_OAUTH_ENABLED` is off, `/mcp` must accept ONLY local direct
 * connections: the SOCKET remote address must be one of the three loopback
 * literals, and NO forwarding header may be present. The guard sits BEFORE
 * authentication, so a request it rejects never reaches the token check.
 *
 * The production assembly is exercised for real: a real express 4 application,
 * `mountMcpGateway(app, { env, authorize })` exactly as AC-240/AC-241 wire it,
 * and `node:http` requests — never `fetch`, because undici refuses a fixed list of
 * ports and `listen(0)` lands on one often enough to red a suite run at random
 * (see AC-240's criterion).
 *
 * A remote address other than this host's is produced WITHOUT docker/LAN
 * hardware: `req.socket` is a prototype getter, so a middleware mounted before
 * the gateway defines an OWN `socket` data property on the request, and the guard
 * reads that instead. The real-loopback reading does no such overriding — it is
 * the control that the default `req.socket.remoteAddress` path still works.
 *
 * Readings, one leg each:
 *   (a) address judgment — the three loopback literals are admitted, the three
 *       non-loopback literals and a MISSING address are 403 (plus a real loopback
 *       reading), with `isLoopbackRemoteAddress` pinned directly too;
 *   (b) forwarding-header presence — a loopback socket with any of the four
 *       headers is 403, without one is admitted, and an EMPTY header still counts
 *       as present;
 *   (c) `MCP_OAUTH_ENABLED` — on stands the guard down (non-loopback reaches
 *       authentication and gets 401, not 403); unset keeps it active (403); both
 *       states are read in this one process;
 *   (d) guard BEFORE authentication — the rejected requests carry a bearer token
 *       yet leave the authorize spy at 0; an admitted request invokes it;
 *   (e) source-level — the loopback module decides on the socket address and never
 *       on the trust-proxy accessor, with a synthetic positive control.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express, { type RequestHandler } from 'express';

import {
  isLoopbackRemoteAddress,
  MCP_GATEWAY_PATH,
  mountMcpGateway,
  readMcpOauthEnabled,
} from '../index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const LOOPBACK_SOURCE_PATH = path.join(REPO_ROOT, 'server/modules/mcp-gateway/mcp-gateway.loopback.ts');

/** The Accept a Streamable HTTP client must send; without it the transport answers 406. */
const MCP_ACCEPT = 'application/json, text/event-stream';

/** The three literals the guard admits when OAuth is off. */
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'] as const;

/** The addresses (and the MISSING one) the guard rejects when OAuth is off. */
const NON_LOOPBACK_ADDRESSES: (string | undefined)[] = ['172.17.0.1', '192.168.1.5', '10.0.0.2', undefined];

/** The four headers whose mere presence rejects a loopback request. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip'] as const;

// --------------------------- HTTP (node:http, never fetch) ---------------------------

type Exchange = { status: number; contentType: string | null; body: string };

function request(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { headers?: Record<string, string>; body?: unknown; accept?: string } = {},
): Promise<Exchange> {
  const url = new URL(requestPath, baseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = { ...options.headers };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (options.accept) {
    headers.accept = options.accept;
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/** POSTs a JSON-RPC `tools/list` to `/mcp` with the given extra headers. */
function postToolsList(baseUrl: string, headers: Record<string, string> = {}): Promise<Exchange> {
  return request(baseUrl, 'POST', MCP_GATEWAY_PATH, {
    headers,
    accept: MCP_ACCEPT,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
}

// --------------------------- remote-address control ---------------------------

/**
 * What the pre-gateway middleware should make the guard SEE. `real` leaves the
 * genuine socket in place (the `127.0.0.1` listen address); `fake` overrides
 * `req.socket` with an own data property so a non-local address can be produced
 * without docker/LAN hardware.
 */
type RemotePlan = { kind: 'real' } | { kind: 'fake'; remoteAddress: string | undefined };

type PlanBox = { current: RemotePlan };

/** A probe token that makes "the guard ran before auth" observable via a spy count. */
const PROBE_AUTHORIZATION = `Bearer ccp_${'a'.repeat(64)}`;

// --------------------------- auth spy ---------------------------

type AuthSpy = {
  handler: RequestHandler;
  count: () => number;
  setDeny: (deny: boolean) => void;
};

/**
 * A counting friend of `deps.authorize`: every call increments `count` and then,
 * in deny mode, answers 401 (the shape AC-241's real middleware uses). The count
 * is what makes the MIDDLEWARE ORDER measurable — a rejected request must leave
 * it untouched.
 */
function createAuthSpy(): AuthSpy {
  let count = 0;
  let deny = false;
  const handler: RequestHandler = (_req, res, next) => {
    count += 1;
    if (deny) {
      res.status(401).json({ error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' });
      return;
    }
    next();
  };

  return { handler, count: () => count, setDeny: (value) => { deny = value; } };
}

// --------------------------- harness ---------------------------

type Harness = { baseUrl: string; spy: AuthSpy; plan: PlanBox };

/**
 * Runs `run` against one real express app mounted exactly as the production
 * assembly does, with the socket-overriding middleware in front. `env` is the
 * object the mount-time gate AND the per-request loopback guard read, so passing
 * `{}` vs `{ MCP_OAUTH_ENABLED: 'true' }` reads both switch states in one process.
 */
async function withGuardServer(env: NodeJS.ProcessEnv, run: (harness: Harness) => Promise<void>): Promise<void> {
  const spy = createAuthSpy();
  const plan: PlanBox = { current: { kind: 'real' } };
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => {
    const current = plan.current;
    if (current.kind === 'fake') {
      Object.defineProperty(req, 'socket', {
        value: { remoteAddress: current.remoteAddress },
        configurable: true,
      });
    }
    next();
  });
  mountMcpGateway(app, { env, authorize: spy.handler });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, spy, plan });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The env that mounts `/mcp` with OAuth OFF (the guard active). */
const OAUTH_OFF_ENV: NodeJS.ProcessEnv = { MCP_ENABLED: 'true' };
/** The env that mounts `/mcp` with OAuth ON (the guard stood down). */
const OAUTH_ON_ENV: NodeJS.ProcessEnv = { MCP_ENABLED: 'true', MCP_OAUTH_ENABLED: 'true' };

// --------------------------- source scan ---------------------------

/** The 1-based lines of `source` matching `pattern` (non-global regex). */
function matchingLines(source: string, pattern: RegExp): string[] {
  return source
    .split('\n')
    .map((line, index) => `${index + 1}:${line}`)
    .filter((entry) => pattern.test(entry));
}

/** The trust-proxy-derived client accessor the guard must NOT consult. */
const TRUST_PROXY_ACCESSOR = /req\.ip/;
/** Either spelling of the direct socket-address read the guard MUST use. */
const SOCKET_ADDRESS_READ = /socket\?\.remoteAddress|\.socket\.remoteAddress/;

// --------------------------- criteria ---------------------------

test('(a) the three loopback literals are admitted, non-loopback and missing are 403', async () => {
  await withGuardServer(OAUTH_OFF_ENV, async (h) => {
    // The control: NO socket overriding — the genuine 127.0.0.1 listen address.
    const real = await postToolsList(h.baseUrl);

    const admitted: { label: string; status: number }[] = [];
    for (const address of LOOPBACK_ADDRESSES) {
      h.plan.current = { kind: 'fake', remoteAddress: address };
      const response = await postToolsList(h.baseUrl);
      admitted.push({ label: address, status: response.status });
    }

    const rejected: { label: string; status: number }[] = [];
    for (const address of NON_LOOPBACK_ADDRESSES) {
      h.plan.current = { kind: 'fake', remoteAddress: address };
      const response = await postToolsList(h.baseUrl);
      rejected.push({ label: address ?? '<missing>', status: response.status });
    }

    console.log(
      [
        `(a) real socket 127.0.0.1 -> ${real.status}`,
        `(a) loopback literals: ${admitted.map((r) => `${r.label}=${r.status}`).join(' | ')}`,
        `(a) non-loopback/missing: ${rejected.map((r) => `${r.label}=${r.status}`).join(' | ')}`,
        `(a) predicate isLoopbackRemoteAddress: ${LOOPBACK_ADDRESSES.map((a) => `${a}=${isLoopbackRemoteAddress(a)}`).join(' ')} ${NON_LOOPBACK_ADDRESSES.map((a) => `${a ?? '<missing>'}=${isLoopbackRemoteAddress(a)}`).join(' ')}`,
      ].join('\n'),
    );

    // The real loopback reading reaches the transport: 200, not merely "not 403".
    assert.equal(real.status, 200, `a real loopback request must reach the transport (got ${real.status})`);

    // The seven required readings, verbatim.
    for (const reading of admitted) {
      assert.notEqual(reading.status, 403, `${reading.label} is loopback and must not be 403 (got ${reading.status})`);
    }
    for (const reading of rejected) {
      assert.equal(reading.status, 403, `${reading.label} must be 403 (got ${reading.status})`);
    }

    // The predicate itself is pinned, so a redefinition of "loopback" reds here too.
    for (const address of LOOPBACK_ADDRESSES) {
      assert.equal(isLoopbackRemoteAddress(address), true, `${address} must be loopback`);
    }
    for (const address of NON_LOOPBACK_ADDRESSES) {
      assert.equal(isLoopbackRemoteAddress(address), false, `${address ?? '<missing>'} must not be loopback`);
    }
  });
});

test('(b) any forwarding header present on a loopback socket is 403; absent is admitted', async () => {
  await withGuardServer(OAUTH_OFF_ENV, async (h) => {
    h.plan.current = { kind: 'fake', remoteAddress: '127.0.0.1' };

    // `x-forwarded-for` deliberately claims the LOOPBACK address: a guard that
    // trusted a forwarded loopback value would admit it, so this leg is sensitive
    // to exactly that mutation.
    const forwardedValues: Record<string, string> = {
      'x-forwarded-for': '127.0.0.1',
      forwarded: 'for=203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
    };
    const forwarded: { label: string; status: number }[] = [];
    for (const header of FORWARDING_HEADERS) {
      const value = forwardedValues[header];
      const response = await postToolsList(h.baseUrl, { [header]: value });
      forwarded.push({ label: `${header}=${value}`, status: response.status });
    }

    // Existence, not value: an empty string still counts as the header appearing.
    const emptyValue = await postToolsList(h.baseUrl, { 'x-forwarded-for': '' });
    const noHeader = await postToolsList(h.baseUrl);

    console.log(
      [
        `(b) loopback socket + forwarding header: ${forwarded.map((r) => `${r.label}=${r.status}`).join(' | ')}`,
        `(b) loopback socket + empty x-forwarded-for -> ${emptyValue.status}`,
        `(b) loopback socket + no header -> ${noHeader.status}`,
      ].join('\n'),
    );

    for (const reading of forwarded) {
      assert.equal(reading.status, 403, `a loopback request carrying ${reading.label} must be 403 (got ${reading.status})`);
    }
    assert.equal(emptyValue.status, 403, `an EMPTY forwarding header is still present and must be 403 (got ${emptyValue.status})`);
    assert.notEqual(noHeader.status, 403, `a loopback request with no forwarding header must be admitted (got ${noHeader.status})`);
  });
});

test('(c) MCP_OAUTH_ENABLED stands the guard down (401, not 403); unset keeps it (403)', async () => {
  // Both switch states are read in THIS process by two differently-valued env objects.
  assert.equal(readMcpOauthEnabled({ MCP_OAUTH_ENABLED: 'true' }), true, 'MCP_OAUTH_ENABLED=true must open the guard');
  assert.equal(readMcpOauthEnabled({}), false, 'an unset MCP_OAUTH_ENABLED must keep the guard closed');
  assert.equal(readMcpOauthEnabled({ MCP_OAUTH_ENABLED: 'false' }), false, 'MCP_OAUTH_ENABLED=false must keep the guard closed');

  let oauthOnNonLoopback = 0;
  let oauthOnForwarded = 0;
  let oauthOffNonLoopback = 0;

  await withGuardServer(OAUTH_ON_ENV, async (h) => {
    h.spy.setDeny(true);
    h.plan.current = { kind: 'fake', remoteAddress: '172.17.0.1' };
    oauthOnNonLoopback = (await postToolsList(h.baseUrl)).status;
    const forwarded = await postToolsList(h.baseUrl, { 'x-forwarded-for': '203.0.113.7' });
    oauthOnForwarded = forwarded.status;
  });

  await withGuardServer(OAUTH_OFF_ENV, async (h) => {
    h.spy.setDeny(true);
    h.plan.current = { kind: 'fake', remoteAddress: '172.17.0.1' };
    oauthOffNonLoopback = (await postToolsList(h.baseUrl)).status;
  });

  console.log(
    [
      `(c) MCP_OAUTH_ENABLED=true  non-loopback -> ${oauthOnNonLoopback} (must be 401, not 403)`,
      `(c) MCP_OAUTH_ENABLED=true  + x-forwarded-for -> ${oauthOnForwarded} (must be 401, not 403)`,
      `(c) MCP_OAUTH_ENABLED unset non-loopback -> ${oauthOffNonLoopback} (must be 403)`,
    ].join('\n'),
  );

  assert.equal(oauthOnNonLoopback, 401, 'with OAuth on a non-loopback request must reach auth and get 401');
  assert.notEqual(oauthOnNonLoopback, 403, 'with OAuth on a non-loopback request must NOT be 403');
  assert.equal(oauthOnForwarded, 401, 'with OAuth on a forwarded request must reach auth and get 401');
  assert.notEqual(oauthOnForwarded, 403, 'with OAuth on a forwarded request must NOT be 403');
  assert.equal(oauthOffNonLoopback, 403, 'with OAuth off the same non-loopback request must be 403');
});

test('(d) the guard runs before authentication: rejected requests never reach the spy', async () => {
  await withGuardServer(OAUTH_OFF_ENV, async (h) => {
    h.plan.current = { kind: 'fake', remoteAddress: '172.17.0.1' };

    const beforeNonLoopback = h.spy.count();
    const nonLoopback = await postToolsList(h.baseUrl, { authorization: PROBE_AUTHORIZATION });
    const afterNonLoopback = h.spy.count();

    h.plan.current = { kind: 'fake', remoteAddress: '127.0.0.1' };
    const beforeForwarded = h.spy.count();
    const forwarded = await postToolsList(h.baseUrl, {
      authorization: PROBE_AUTHORIZATION,
      'x-forwarded-for': '203.0.113.7',
    });
    const afterForwarded = h.spy.count();

    const beforeAdmitted = h.spy.count();
    const admitted = await postToolsList(h.baseUrl, { authorization: PROBE_AUTHORIZATION });
    const afterAdmitted = h.spy.count();

    console.log(
      [
        `(d) non-loopback reject: status=${nonLoopback.status} spy ${beforeNonLoopback}->${afterNonLoopback}`,
        `(d) loopback+forwarded reject: status=${forwarded.status} spy ${beforeForwarded}->${afterForwarded}`,
        `(d) loopback admitted: status=${admitted.status} spy ${beforeAdmitted}->${afterAdmitted}`,
      ].join('\n'),
    );

    assert.equal(nonLoopback.status, 403, 'a non-loopback request must be 403');
    assert.equal(afterNonLoopback, 0, 'a rejected request must not reach authentication (spy count 0)');

    assert.equal(forwarded.status, 403, 'a loopback+forwarded request must be 403');
    assert.equal(afterForwarded, 0, 'a rejected request must not reach authentication (spy count 0)');

    // Positive control: the spy CAN be invoked, so the zeros above are order, not a dead spy.
    assert.notEqual(admitted.status, 403, 'an admitted loopback request must not be 403');
    assert.ok(afterAdmitted >= 1, `an admitted request must reach authentication (spy count ${afterAdmitted})`);
  });
});

test('(e) the source decides on the socket address, never on the trust-proxy accessor', () => {
  const source = readFileSync(LOOPBACK_SOURCE_PATH, 'utf8');
  const trustProxyHits = matchingLines(source, TRUST_PROXY_ACCESSOR);
  const socketReadHits = matchingLines(source, SOCKET_ADDRESS_READ);

  // Positive control: the same accessor pattern DOES match a synthetic line, so a
  // green above is not a regex that can never fire.
  const synthetic = "const probe = 'const a = req.ip;';";
  const syntheticHits = matchingLines(synthetic, TRUST_PROXY_ACCESSOR);

  console.log(
    [
      `(e) req.ip hits in mcp-gateway.loopback.ts: ${trustProxyHits.length}`,
      `(e) socket remoteAddress hits: ${socketReadHits.map((line) => line.trim()).join(' || ')}`,
      `(e) synthetic positive control hits: ${syntheticHits.length} (${syntheticHits.join(' || ')})`,
    ].join('\n'),
  );

  assert.equal(trustProxyHits.length, 0, `the guard must not read req.ip; found: ${trustProxyHits.join(' | ')}`);
  assert.ok(socketReadHits.length >= 1, 'the guard must read the socket remote address');
  assert.ok(syntheticHits.length >= 1, 'the accessor pattern must be able to match (positive control)');
});
