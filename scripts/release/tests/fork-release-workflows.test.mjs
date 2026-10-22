#!/usr/bin/env node
/**
 * Static guard for the fork release pipeline (yaleh/claudecodeui).
 *
 * The fork releases diverges from upstream (siteboon) in exactly these shape decisions, and each
 * one is a decision that silently REVERTS the moment someone re-syncs a file from upstream:
 *
 *   1. `package.json` names the fork `@yalehwang/cloudcli` and publishes it publicly. The
 *      upstream `@cloudcli-ai/cloudcli` scope belongs to other maintainers — it can never be
 *      published from here, so a regression back to that name fails the run at the publish step
 *      (after the tag is already made) rather than doing nothing.
 *   2. `.release-it.json` publishes to npm (`npm.publish=true`, `--access public`) in addition to
 *      cutting the GitHub Release, on `develop`, pushing to the `yaleh` remote.
 *   3. `release.yml` authenticates that publish with npm trusted publishing (OIDC, `id-token:
 *      write`), not an npm token: npm rejects 2FA-bypass tokens for publishing.
 *   4. No user-facing install/upgrade command in the repository points at the upstream scope —
 *      every one of them must name `@yalehwang/cloudcli`, or the fork ships users a command that
 *      installs somebody else's package.
 *   5. `desktop-release.yml` builds Windows only. There is no Apple signing certificate, so a
 *      re-added `build-macos` job makes `publish.needs` wait on a job that can never go green, and
 *      a re-added `.dmg` assertion fails the publish step on an asset nobody built.
 *   6. `README.md` sends every download/issue/release link to the fork. Upstream's own services
 *      (docs site, Cloud, Discord, plugin template) are named verbatim and kept, but a navigable
 *      link to `github.com/siteboon/claudecodeui` outside the fork-notice blockquote would take a
 *      fork user to upstream's builds and issue tracker.
 *
 * This is a static guard, not an integration test: it reads the files and asserts the shape. It
 * cannot prove the pipeline runs (that is the task's human-gated AC), only that the decisions have
 * not silently reverted.
 *
 * WHAT IT PRINTS. The readings named by the criterion are printed unconditionally, before the
 * assertions, so a red run still shows which reading was wrong:
 *
 *   pkg.name=@yalehwang/cloudcli  npm.publish=true  auth.env=OIDC  legacy.upgradeCmds=0
 *   requireBranch=develop  pushRepo=yaleh  macos.jobs=0  dmg.refs=0  readme.upstream_refs_outside_notice=0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// `scripts/release/tests/` -> repo root is three levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** This guard's own repo-relative path. @see EXCLUDED_PREFIXES */
const SELF = 'scripts/release/tests/fork-release-workflows.test.mjs';

/**
 * Read a repo-relative file as UTF-8.
 * @param {string} rel @returns {string}
 */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const PKG_JSON = 'package.json';
const RELEASE_IT_JSON = '.release-it.json';
const RELEASE_YML = '.github/workflows/release.yml';
const DESKTOP_YML = '.github/workflows/desktop-release.yml';
const README = 'README.md';

/** @type {Record<string, any>} */
const pkg = JSON.parse(read(PKG_JSON));
const releaseItText = read(RELEASE_IT_JSON);
const releaseYml = read(RELEASE_YML);
const desktopYml = read(DESKTOP_YML);
const readmeText = read(README);

/** @type {Record<string, any>} */
const releaseIt = JSON.parse(releaseItText);
const desktopDoc = parseYaml(desktopYml);

/** @type {Record<string, Record<string, unknown>>} */
const desktopJobs =
  desktopDoc && typeof desktopDoc === 'object' && desktopDoc.jobs ? desktopDoc.jobs : {};

// ── the printed readings ────────────────────────────────────────────────────
// The package name the fork publishes under: upstream's scope is somebody else's.
const FORK_NAME = '@yalehwang/cloudcli';
// The upstream scope a user-facing command must never point at. This guard has to be able to spell
// the pattern it forbids, so it is listed in EXCLUDED_PREFIXES rather than scanned.
const UPSTREAM_NAME = '@cloudcli-ai/cloudcli';

const npmPublish = releaseIt?.npm?.publish;

// How release.yml authenticates the publish: `OIDC` when the release job holds `id-token: write`.
const authEnv = /id-token:\s*write/.test(releaseYml) ? 'OIDC' : 'none';

const requireBranch = releaseIt?.git?.requireBranch;
const pushRepo = releaseIt?.git?.pushRepo;

// A job counts as macOS if its runner, its id or its display name says so. Any one of the three
// is enough: a re-added `build-macos` is caught even if the runner line is edited.
const macosJobs = Object.entries(desktopJobs).filter(([id, job]) => {
  const runsOn = String(job['runs-on'] ?? '');
  const name = String(job.name ?? '');
  return /macos/i.test(runsOn) || /macos/i.test(name) || /macos/i.test(id);
}).length;

const dmgRefs = (desktopYml.match(/\.dmg/g) ?? []).length;

// A README line that navigates the reader to upstream's download page or repository. The
// `siteboon%2Fclaudecodeui` spelling inside the Trendshift badge URL is deliberately NOT matched:
// it is an encoded badge target, not a link a reader can follow to the upstream repo.
const UPSTREAM_README_REF = /cloudcli\.ai\/download|siteboon\/claudecodeui/;

// Every such line must sit inside the fork-notice blockquote (a line starting with `> `), the one
// place allowed to name upstream. A reference outside it points a fork user at upstream's builds
// and issue tracker instead of the fork's.
const readmeUpstreamRefsOutsideNotice = readmeText
  .split('\n')
  .filter((line) => UPSTREAM_README_REF.test(line))
  .filter((line) => !line.startsWith('> ')).length;

/**
 * Repo-relative prefixes the upgrade-command scan does NOT cover, each for a reason. Documented
 * here so every omission is a decision, not an oversight.
 *
 *  - `docker/`           ships the upstream `cloudcliai/sandbox` image and installs the upstream
 *                        package; changing it is out of this task's scope.
 *  - `redirect-package/` the legacy `@siteboon/…` -> upstream redirect shell; unchanged by design.
 *  - `docs/`             localised READMEs, tracked separately from this change.
 *  - `CHANGELOG.md`      a historical record; never rewritten.
 *  - `tasks/`, `goals/`  the quay ledger: they name the old package as history, not as a command
 *                        a user would ever be told to run.
 *  - `SELF`              this guard spells the forbidden pattern in `UPSTREAM_NAME` above, so it
 *                        necessarily mentions it.
 *
 * The scan is over `git ls-files`, so build output, `node_modules/` and other untracked artifacts
 * are excluded structurally rather than by name.
 */
const EXCLUDED_PREFIXES = [
  'docker/',
  'redirect-package/',
  'docs/',
  'CHANGELOG.md',
  'tasks/',
  'goals/',
  SELF,
];

/**
 * Every tracked, non-binary file that still mentions the upstream package scope, excluding the
 * prefixes above. Returns `file (count)` entries so a red run names the offending files.
 * @returns {string[]}
 */
function scanUpstreamMentions() {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

  const hits = [];
  for (const file of tracked) {
    if (EXCLUDED_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))) continue;
    // `git ls-files` also lists gitlinks (submodules), which are directories on disk, not files.
    if (!statSync(join(ROOT, file)).isFile()) continue;
    const bytes = readFileSync(join(ROOT, file));
    // A NUL byte means binary; only text files can carry a user-facing command.
    if (bytes.includes(0)) continue;
    const count = bytes.toString('utf8').split(UPSTREAM_NAME).length - 1;
    if (count > 0) hits.push(`${file} (${count})`);
  }
  return hits;
}

const upstreamMentions = scanUpstreamMentions();

console.log(`pkg.name=${pkg.name}`);
console.log(`npm.publish=${npmPublish}`);
console.log(`auth.env=${authEnv}`);
console.log(`legacy.upgradeCmds=${upstreamMentions.length}`);
console.log(`requireBranch=${requireBranch}`);
console.log(`pushRepo=${pushRepo}`);
console.log(`macos.jobs=${macosJobs}`);
console.log(`dmg.refs=${dmgRefs}`);
console.log(`readme.upstream_refs_outside_notice=${readmeUpstreamRefsOutsideNotice}`);

// ── the assertions ──────────────────────────────────────────────────────────

test('package.json names the fork and publishes it publicly', () => {
  assert.equal(pkg.name, FORK_NAME, `package.json must name the fork ${FORK_NAME}, not the upstream ${UPSTREAM_NAME}`);
  assert.equal(pkg.publishConfig?.access, 'public', 'a scoped package must opt into public visibility');
  assert.match(
    String(pkg.repository?.url ?? ''),
    /yaleh\/claudecodeui/,
    'package.json must point repository.url at the fork, not at upstream siteboon/claudecodeui',
  );
  assert.match(
    String(pkg.bugs?.url ?? ''),
    /yaleh\/claudecodeui/,
    'package.json must point bugs.url at the fork, not at upstream siteboon/claudecodeui',
  );
  assert.match(
    String(pkg.homepage ?? ''),
    /yaleh\/claudecodeui/,
    'the fork has no site of its own, so homepage must point at the fork repository',
  );
});

test('.release-it.json publishes to npm from the fork release path', () => {
  assert.equal(npmPublish, true, `npm.publish must be true: the fork publishes ${FORK_NAME}`);
  const publishArgs = releaseIt?.npm?.publishArgs;
  assert.ok(Array.isArray(publishArgs), 'npm.publishArgs must be an array');
  // release-it joins the array with spaces before running `npm publish …`, so both
  // `["--access", "public"]` and `["--access public"]` are accepted here.
  assert.match(publishArgs.join(' '), /--access[= ]public/, 'npm.publishArgs must grant public access');
  assert.equal(requireBranch, 'develop', 'release-it must run on develop, the fork release branch');
  assert.equal(pushRepo, 'yaleh', 'release-it must push to the yaleh remote, never origin (upstream)');
  // release-it's own default is requireUpstream:true; `develop` in this fork has no tracking
  // branch, so without this the dry run (and the workflow) abort before doing anything.
  assert.equal(releaseIt?.git?.requireUpstream, false, 'release-it must not require a pre-existing upstream branch');
  assert.equal(releaseIt?.github?.release, true, 'the GitHub Release must stay enabled');
});

test('release.yml authenticates the npm publish with trusted publishing (OIDC)', () => {
  assert.equal(authEnv, 'OIDC', 'release.yml must grant id-token: write for npm trusted publishing');
  assert.doesNotMatch(releaseYml, /NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/, 'release.yml must not use an npm token');
  assert.match(
    releaseYml,
    /registry-url:\s*['"]?https:\/\/registry\.npmjs\.org/,
    'setup-node must point npm at the public registry',
  );
  assert.doesNotMatch(releaseYml, /--no-npm\.publish/, 'release.yml must not suppress the npm publish');
});

test('no user-facing command points at the upstream package scope', () => {
  assert.deepEqual(
    upstreamMentions,
    [],
    `the repository still tells users to install the upstream package: ${upstreamMentions.join(', ')}`,
  );
});

test('desktop-release.yml drops the macOS build', () => {
  assert.equal(macosJobs, 0, `desktop-release.yml builds a macOS job again (${macosJobs})`);
  assert.equal(dmgRefs, 0, `desktop-release.yml still references a .dmg (${dmgRefs})`);
  assert.doesNotMatch(desktopYml, /macos-latest/, 'desktop-release.yml must not use a macOS runner');
  assert.doesNotMatch(desktopYml, /SHASUMS256-macos\.txt/, 'desktop-release.yml must not stage macOS checksums');
  // `secrets.CSC_LINK` / `secrets.APPLE_*` are the Apple-signing surface. The bare `CSC_LINK` env
  // KEY survives inside the Windows job (electron-builder reads that name for the Windows cert),
  // so the check is anchored to the secret reference, not the string.
  assert.doesNotMatch(desktopYml, /secrets\.CSC_LINK\b/, 'desktop-release.yml must not reference the macOS signing certificate');
  assert.doesNotMatch(desktopYml, /secrets\.CSC_KEY_PASSWORD\b/, 'desktop-release.yml must not reference the macOS certificate password');
  assert.doesNotMatch(desktopYml, /APPLE_/, 'desktop-release.yml must not reference Apple notarization secrets');
});

test('README points every upstream-repo reference at the fork notice', () => {
  assert.equal(
    readmeUpstreamRefsOutsideNotice,
    0,
    'README names upstream outside the fork-notice blockquote, so a fork user is sent to upstream downloads/issues',
  );
  assert.match(readmeText, /github\.com\/yaleh\/claudecodeui\/releases/, 'README must link the fork GitHub Releases');
  assert.match(readmeText, /github\.com\/yaleh\/claudecodeui\/issues/, 'README must link the fork issue tracker');
});

test('desktop-release.yml publish.needs only names real jobs', () => {
  const publish = desktopJobs.publish;
  assert.ok(publish, 'desktop-release.yml needs a publish job');
  const rawNeeds = publish.needs;
  const needs = Array.isArray(rawNeeds) ? rawNeeds : [rawNeeds];
  assert.ok(!needs.includes('build-macos'), 'publish.needs must not require the removed build-macos job');
  for (const id of needs) {
    assert.ok(desktopJobs[String(id)], `publish.needs references a job that does not exist: ${String(id)}`);
  }
});
