// scripts/undici-blocked-ports-preload.test.mjs
//
// Proves the mechanism that removes the server lane's `bad port` lottery — see the WHY block in
// scripts/undici-blocked-ports-preload.mjs. The claim under test is narrow and falsifiable:
// a child started with `--import ./scripts/undici-blocked-ports-preload.mjs` HOLDS the 18 undici
// bad ports, so a `listen(0)` elsewhere in that process tree cannot be handed one.
//
// This file deliberately does NOT `import` the preload module: importing it runs its top-level
// hold, which would make THIS process a holder and make the parent-side EADDRINUSE assertions pass
// for the wrong reason. The port list below is therefore a pinned copy, and the first case ties it
// back to the module by asking a `--import` child to print what it actually holds.
//
// Run: node --test scripts/undici-blocked-ports-preload.test.mjs

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'undici-blocked-ports-preload.mjs');
const PRELOAD_URL = pathToFileURL(PRELOAD).href;
const HOST = '127.0.0.1';

// Pinned copy of the 18 ports undici refuses before opening a socket. The first case fails if this
// ever drifts from scripts/undici-blocked-ports-preload.mjs.
const BLOCKED_PORTS = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
];

// The long-lived child. With `--import <preload>` it waits for the preload's first bind round
// (instead of racing a sleep) and then announces READY; with HOLD=1 it stays alive so the parent
// can probe the ports while it is up. Without `--import` it announces READY immediately.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'undici-preload-test-'));
const CHILD = path.join(SCRATCH, 'hold-child.mjs');
fs.writeFileSync(
  CHILD,
  [
    'const held = globalThis.__undiciBlockedPortsPreload;',
    'if (held) await held;',
    "process.stdout.write('READY\\n');",
    "if (process.env.HOLD === '1') setInterval(() => {}, 1 << 30);",
    '',
  ].join('\n'),
  'utf8',
);
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * @typedef {{ ok: boolean, code?: string }} ListenResult
 */

/**
 * Try to bind one port once. Never rejects; a bind failure is a reading, not an error.
 *
 * @param {number} port
 * @returns {Promise<ListenResult>}
 */
function tryListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) =>
      resolve({ ok: false, code: /** @type {NodeJS.ErrnoException} */ (error).code ?? 'UNKNOWN' }),
    );
    server.listen(port, HOST, () => server.close(() => resolve({ ok: true })));
  });
}

/**
 * Which of the 18 ports are free to verify right now, and which are already held by something
 * else (those are excluded from the criteria and reported).
 *
 * @returns {Promise<{ verifiable: number[], preOccupied: string[] }>}
 */
async function probeFreePorts() {
  const verifiable = [];
  const preOccupied = [];
  for (const port of BLOCKED_PORTS) {
    const result = await tryListen(port);
    if (result.ok) verifiable.push(port);
    else preOccupied.push(`${port}:${result.code}`);
  }
  return { verifiable, preOccupied };
}

/**
 * @param {{ withPreload: boolean, hold: boolean }} options
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnChild({ withPreload, hold }) {
  const args = withPreload ? ['--import', PRELOAD_URL, CHILD] : [CHILD];
  return spawn(process.execPath, args, {
    cwd: HERE,
    env: { ...process.env, HOLD: hold ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Resolve once the child prints its READY line; reject if it exits first.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function waitForReady(child) {
  return new Promise((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('child has no stdout'));
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('READY')) resolve();
    });
    child.stderr?.on('data', (chunk) => {
      err += String(chunk);
    });
    child.once('exit', (code) => reject(new Error(`child exited (${code}) before READY; stderr: ${err}`)));
    child.once('error', reject);
  });
}

/**
 * SIGKILL the child and wait for it to be gone, so its held sockets are released before the next
 * case probes the same ports.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/**
 * Wait for the child to exit on its own, up to `timeoutMs`.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<number | null>}
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child was still alive after ${timeoutMs}ms — the preload pinned it`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('the pinned port list matches what the --import module actually holds', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      PRELOAD_URL,
      '-e',
      'globalThis.__undiciBlockedPortsPreload.then(() => process.stdout.write(JSON.stringify(globalThis.__undiciBlockedPorts)))',
    ],
    { encoding: 'utf8', cwd: HERE },
  );
  assert.equal(result.status, 0, `probe child failed: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), BLOCKED_PORTS);
});

test('a --import child holds every verifiable blocked port against the parent', async () => {
  const { verifiable, preOccupied } = await probeFreePorts();
  assert.ok(
    verifiable.length >= 12,
    `only ${verifiable.length} of the 18 ports were free to verify (<12 required); pre-occupied before this test: ${preOccupied.join(', ') || 'none'}`,
  );

  const child = spawnChild({ withPreload: true, hold: true });
  try {
    await waitForReady(child);
    const open = [];
    for (const port of verifiable) {
      const result = await tryListen(port);
      if (result.ok) open.push(port);
    }
    console.log(
      `undici-blocked-ports-preload: verified ${verifiable.length}/18 ports held by the --import child; pre-occupied and excluded before this test: ${preOccupied.join(', ') || 'none'}`,
    );
    assert.deepEqual(
      open,
      [],
      `ports the --import child failed to hold (the parent could still bind them): ${open.join(', ')}; pre-occupied before this test (excluded): ${preOccupied.join(', ') || 'none'}`,
    );
  } finally {
    await stopChild(child);
  }
});

test('negative control: the same child WITHOUT --import leaves the ports bindable', async () => {
  const { verifiable, preOccupied } = await probeFreePorts();
  assert.ok(
    verifiable.length >= 12,
    `only ${verifiable.length} of the 18 ports were free to verify (<12 required); pre-occupied before this test: ${preOccupied.join(', ') || 'none'}`,
  );

  const child = spawnChild({ withPreload: false, hold: true });
  try {
    await waitForReady(child);
    const bound = [];
    const failed = [];
    for (const port of verifiable) {
      const result = await tryListen(port);
      if (result.ok) bound.push(port);
      else failed.push(`${port}:${result.code}`);
    }
    assert.ok(
      bound.length >= 12,
      `only ${bound.length} ports were bindable without the preload (<12): ${failed.join(', ')} — the EADDRINUSE in the preload case is not attributable to the preload`,
    );
  } finally {
    await stopChild(child);
  }
});

test('a --import child tolerates a blocked port that is already held (EADDRINUSE swallowed)', async () => {
  const holder = net.createServer();
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(6000, HOST, () => resolve());
  }));
  holder.unref();
  try {
    const child = spawnChild({ withPreload: true, hold: false });
    const code = await waitForExit(child, 5000);
    assert.equal(code, 0, 'the --import child treated an already-held port as fatal instead of swallowing it');
  } finally {
    await /** @type {Promise<void>} */ (new Promise((resolve) => holder.close(() => resolve())));
  }
});

test('an idle --import process exits on its own within 5s (holders are unref\'d)', async () => {
  const child = spawnChild({ withPreload: true, hold: false });
  const started = Date.now();
  const code = await waitForExit(child, 5000);
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(elapsed < 5000, `the preload kept the process alive for ${elapsed}ms`);
});
