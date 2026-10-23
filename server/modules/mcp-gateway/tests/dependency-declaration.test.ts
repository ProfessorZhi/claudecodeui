/**
 * Criterion for AC-239 (GOAL-020 exit condition 1; SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §105 and §514): production installs
 * with `npm install -g`, which does NOT install devDependencies, so
 * `@modelcontextprotocol/sdk` and `zod` must be declared as real top-level
 * `dependencies` — not left to the transitively-installed peer copies that the
 * gateway would otherwise be at the mercy of.
 *
 * Reads the LIVE `package.json`, `package-lock.json`, and the two installed
 * packages under `node_modules/` as JSON (never text-matched), and asserts four
 * independent readings (a)-(d). Imports only node builtins: importing the
 * transitively-installed `semver` would fail `npm run typecheck` under
 * `server/tsconfig.json` strict (there is no `@types/semver`), so the range
 * check uses a minimal local `satisfies()` covering `~x.y.z`, `^x.y.z`, exact
 * `x.y.z`, and `*` — the four forms this criterion needs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The criterion lives at server/modules/mcp-gateway/tests/, four levels below the repo root.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');

const SDK = '@modelcontextprotocol/sdk';
const ZOD = 'zod';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type LockPackage = {
  version?: string;
  dev?: boolean;
  peer?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Lockfile = {
  packages: Record<string, LockPackage>;
};

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

const pkg = readJson<PackageJson>(path.join(REPO_ROOT, 'package.json'));
const lock = readJson<Lockfile>(path.join(REPO_ROOT, 'package-lock.json'));
const installedSdk = readJson<{ version: string }>(
  path.join(REPO_ROOT, 'node_modules', SDK, 'package.json'),
);
const installedZod = readJson<{ version: string }>(
  path.join(REPO_ROOT, 'node_modules', ZOD, 'package.json'),
);

const rootDeps = pkg.dependencies ?? {};
const rootLockDeps = lock.packages['']?.dependencies ?? {};
const rootLockDevDeps = lock.packages['']?.devDependencies ?? {};

/**
 * Minimal semver range check for the four forms this criterion needs: `*`,
 * `~x.y.z` (same major.minor, patch >=), `^x.y.z` (compatible: same major when
 * major > 0, same minor when major == 0 and minor > 0, else exact), exact
 * `x.y.z`.
 */
function satisfies(range: string, version: string): boolean {
  if (range === '*') return true;
  const [vMaj, vMin, vPat] = version.split('.').map(Number);
  if (range.startsWith('~')) {
    const [rMaj, rMin, rPat] = range.slice(1).split('.').map(Number);
    return vMaj === rMaj && vMin === rMin && vPat >= rPat;
  }
  if (range.startsWith('^')) {
    const [rMaj, rMin, rPat] = range.slice(1).split('.').map(Number);
    if (rMaj !== 0) return vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPat >= rPat));
    if (rMin !== 0) return vMaj === 0 && vMin === rMin && vPat >= rPat;
    return vMaj === 0 && vMin === 0 && vPat === rPat;
  }
  return version === range;
}

// (a) dependencies declares both packages, and neither appears only in dev/peer.
test('AC-239(a): dependencies declares both packages, not only dev/peer', () => {
  console.log(
    `AC-239(a) package.json dependencies: ${JSON.stringify({ [SDK]: rootDeps[SDK], [ZOD]: rootDeps[ZOD] })}`,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(rootDeps, SDK),
    `${SDK} must be a top-level dependency, got ${JSON.stringify(rootDeps[SDK])}`,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(rootDeps, ZOD),
    `${ZOD} must be a top-level dependency, got ${JSON.stringify(rootDeps[ZOD])}`,
  );
  for (const name of [SDK, ZOD]) {
    const devRange = pkg.devDependencies?.[name];
    const peerRange = pkg.peerDependencies?.[name];
    assert.ok(
      !(rootDeps[name] === undefined && (devRange !== undefined || peerRange !== undefined)),
      `${name} must not be present only in devDependencies/peerDependencies (dev=${JSON.stringify(devRange)}, peer=${JSON.stringify(peerRange)})`,
    );
  }
});

// (b) the SDK range is a tilde lock on the 1.29 line; the zod range accepts the installed 4.x.
test('AC-239(b): SDK range is tilde-locked to the 1.29 line; zod range accepts the 4.x install', () => {
  const sdkRange = rootDeps[SDK];
  const zodRange = rootDeps[ZOD];
  console.log(
    `AC-239(b) sdkRange=${JSON.stringify(sdkRange)} zodRange=${JSON.stringify(zodRange)} installedZod=${installedZod.version}`,
  );
  assert.match(sdkRange, /^~1\.29\.\d+$/);
  assert.ok(
    satisfies(zodRange, installedZod.version),
    `zod range ${JSON.stringify(zodRange)} must accept installed ${installedZod.version}`,
  );
  assert.match(installedZod.version, /^4\./);
});

// (c) the installed node_modules copies satisfy their declared ranges.
test('AC-239(c): installed node_modules versions satisfy their declared ranges', () => {
  console.log(
    `AC-239(c) installed ${SDK}@${installedSdk.version} range=${JSON.stringify(rootDeps[SDK])}; ${ZOD}@${installedZod.version} range=${JSON.stringify(rootDeps[ZOD])}`,
  );
  assert.ok(
    satisfies(rootDeps[SDK], installedSdk.version),
    `${SDK}@${installedSdk.version} must satisfy ${JSON.stringify(rootDeps[SDK])}`,
  );
  assert.ok(
    satisfies(rootDeps[ZOD], installedZod.version),
    `${ZOD}@${installedZod.version} must satisfy ${JSON.stringify(rootDeps[ZOD])}`,
  );
});

// (d) the lock root dependencies match package.json and neither package is marked dev.
test('AC-239(d): lock root deps match package.json and neither is marked dev', () => {
  console.log(
    `AC-239(d) lock root deps=${JSON.stringify({ [SDK]: rootLockDeps[SDK], [ZOD]: rootLockDeps[ZOD] })}; lock root devDeps contains=${JSON.stringify([SDK, ZOD].filter((name) => name in rootLockDevDeps))}`,
  );
  assert.equal(rootLockDeps[SDK], rootDeps[SDK]);
  assert.equal(rootLockDeps[ZOD], rootDeps[ZOD]);
  assert.deepEqual(
    { [SDK]: rootLockDeps[SDK], [ZOD]: rootLockDeps[ZOD] },
    { [SDK]: rootDeps[SDK], [ZOD]: rootDeps[ZOD] },
  );
  for (const name of [SDK, ZOD]) {
    assert.ok(!(name in rootLockDevDeps), `${name} must not be in the lock root devDependencies`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry !== undefined, `lock must contain node_modules/${name}`);
    assert.notEqual(entry.dev, true, `node_modules/${name} must not be marked dev`);
  }
});
