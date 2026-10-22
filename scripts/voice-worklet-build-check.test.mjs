#!/usr/bin/env node
/**
 * voice-worklet-build-check.test.mjs — the false forms for AC "the shipped client loads its
 * AudioWorklet module from built JavaScript".
 *
 * WHAT A FALSE FORM HAS TO SHOW. Not that the criterion prints a lot of lines, but that the reading
 * it publishes can be turned wrong by the defect it names, on a tree that was green a moment
 * earlier. So every case here is a pair: the unmutated tree passes, the mutated one fails, and the
 * failure names the reading the mutation was aimed at.
 *
 * THE MUTATION IS THE SHIPPED BUG, NOT A MODEL OF IT. The defect was
 * `new URL('./voiceFrameProcessor.ts', import.meta.url).href` — the bundle asks for the source file
 * by its own path, and a production build copies that file verbatim instead of compiling it. The
 * case writes exactly that expression back into the URL module and nothing else. A synthetic
 * "broken-looking" build output would only prove the checker can read a fixture; this proves it can
 * read the defect.
 *
 * THE TREE IS A `git worktree`, NOT A COPY. The worktree is a real checkout of HEAD with this
 * checkout's `node_modules` symlinked in — the client build has to resolve the shipped module graph,
 * so a tree that could not do that would fail for a reason that is not the mutation. It lives under
 * the OS temp directory, so a crashed case cannot leave scratch inside the checkout that gets
 * merged. The mutation is applied there, and the case asserts this checkout's own copy is untouched.
 *
 * COST, STATED RATHER THAN HIDDEN. Each run builds the real client (~15 s on this host) and the
 * suite builds three times: this checkout, the worktree before its mutation, and the worktree
 * after. The middle one is not decoration — without it, "the mutated tree is red" is compatible
 * with a criterion that is simply always red.
 *
 * Usage: `npm run test:scripts` (or `node --test scripts/voice-worklet-build-check.test.mjs`).
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROBE = path.join(HERE, 'voice-worklet-build-check.mjs');

/** The module the criterion reads the worklet's URL out of, relative to a tree's root. */
const WORKLET_URL_REL = path.join('src', 'modules', 'chat', 'audio', 'voiceFrameProcessorUrl.ts');

/**
 * The pre-fix URL source, verbatim in behaviour: the same expression, from the same directory, over
 * the same source path. `./voiceFrameProcessor.ts` resolves to the file the old function lived in,
 * so this reproduces the shipped build output rather than approximating it.
 */
const PRE_FIX_URL_SOURCE = `/**
 * The worklet module's own URL, for \`AudioWorklet.addModule\`.
 *
 * (false-form fixture) The expression the shipped defect used: \`import.meta.url\` over the source
 * path. The dev server transforms that file on request; a production build copies it verbatim.
 */
export function voiceFrameProcessorUrl(): string | null {
  try {
    return new URL('./voiceFrameProcessor.ts', import.meta.url).href;
  } catch {
    return null;
  }
}
`;

/**
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string, stderr: string, text: string }}
 */
function runCheck(args) {
  const result = spawnSync(process.execPath, [PROBE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  return { status: result.status, stdout, stderr, text: `${stdout}${stderr}` };
}

/**
 * The worklet URL a run published, as an absolute path to the file the app will fetch.
 *
 * @param {string} stdout
 * @returns {string} the path inside the judged build output
 */
function publishedWorkletFile(stdout) {
  const match = stdout.match(/^worklet\.file=(.+)$/m);
  assert.ok(match, `the run published no worklet.file\n${stdout}`);
  const out = stdout.match(/^build\.out=(.+)$/m);
  assert.ok(out, `the run published no build.out\n${stdout}`);
  return path.join(out[1], match[1]);
}

/**
 * A detached worktree of this checkout at HEAD, with `node_modules` linked in so the client build
 * can resolve the shipped graph. Removed on the case's exit whether it passed or not.
 *
 * @param {import('node:test').TestContext} t
 * @returns {string} the worktree path
 */
function makeTree(t) {
  const parent = mkdtempSync(path.join(tmpdir(), 'worklet-build-ctrl-'));
  const tree = path.join(parent, 'tree');
  execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', tree, 'HEAD'], { encoding: 'utf8' });
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
  t.after(() => {
    try {
      execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', tree], { encoding: 'utf8' });
    } catch {
      // The case may already have removed it; the recursive removal below is the backstop.
    }
    rmSync(parent, { recursive: true, force: true });
  });
  return tree;
}

/**
 * The readings every green run must carry: the worklet is shipped, it is served as JavaScript, and
 * it is a built, self-contained module rather than a copied source file.
 *
 * @param {string} text
 */
function assertGreenReadings(text) {
  assert.match(text, /^build=ok$/m, text);
  assert.match(text, /^worklet\.url=\/assets\/[^/]+\.js$/m, text);
  assert.match(text, /^worklet\.content-type=text\/javascript$/m, text);
  assert.match(text, /^worklet\.bare-specifiers=0$/m, text);
  assert.match(text, /^worklet\.unresolved-imports=0$/m, text);
  assert.match(text, /^worklet\.verbatim-copies=0$/m, text);
  assert.doesNotMatch(text, /^FAIL /m, text);
}

test('AC1 this checkout builds a worklet the app loads as JavaScript', () => {
  const run = runCheck([]);
  assert.equal(run.status, 0, run.text);
  assertGreenReadings(run.stdout);
  // The control that keeps the content-type reading about the defect: looked up through the same
  // mime database, the worklet's own source name is NOT a JavaScript type.
  assert.match(run.stdout, /^source\.content-type=video\/mp2t$/m, run.text);
});

test('AC2 the shipped defect — import.meta.url over the source path — reds the tree that was green', (t) => {
  const tree = makeTree(t);
  const target = path.join(tree, WORKLET_URL_REL);
  const pristine = readFileSync(target, 'utf8');

  // The control half: the same tree, unmutated, must pass — otherwise the second half proves only
  // that this criterion is red for some other reason.
  const before = runCheck(['--root', tree]);
  assert.equal(before.status, 0, before.text);
  assertGreenReadings(before.stdout);

  writeFileSync(target, PRE_FIX_URL_SOURCE);
  assert.notEqual(readFileSync(target, 'utf8'), pristine, 'the mutation changed nothing');
  assert.equal(
    readFileSync(path.join(ROOT, WORKLET_URL_REL), 'utf8'),
    pristine,
    'the mutation reached this checkout through the worktree',
  );

  const after = runCheck(['--root', tree, '--keep']);
  assert.equal(after.status, 1, `the pre-fix URL source must be red\n${after.text}`);
  // Red on the property, not on the measurement: a build that failed would have been exit 2.
  assert.match(after.stdout, /^build=ok$/m, after.text);
  assert.match(after.stdout, /^worklet\.content-type=video\/mp2t$/m, after.text);
  assert.match(after.stdout, /^worklet\.bare-specifiers=1 list=@\/shared\/voiceEndpoint$/m, after.text);
  assert.match(after.stdout, /^FAIL .*addModule rejects that with a MIME type mismatch/m, after.text);
  // The file the defect served really is the source: that is what makes the content type the defect.
  assert.equal(
    readFileSync(publishedWorkletFile(after.stdout), 'utf8'),
    readFileSync(path.join(tree, 'src', 'modules', 'chat', 'audio', 'voiceFrameProcessor.ts'), 'utf8'),
    'the URL the mutated build ships must resolve to the verbatim source',
  );

  const kept = after.stdout.match(/^scratch\.kept=(.+)$/m);
  assert.ok(kept, `the red run must publish the build output it judged\n${after.text}`);
  t.after(() => rmSync(path.dirname(kept[1]), { recursive: true, force: true }));

  // `--built` judges that same output again without building: the option a human points at a
  // deploy's own dist/. Same artifact, same verdict, and no build claimed.
  const reread = runCheck(['--root', tree, '--built', kept[1]]);
  assert.equal(reread.status, 1, `judging the same output again must reach the same verdict\n${reread.text}`);
  assert.doesNotMatch(reread.stdout, /^build=ok$/m, 'a --built run builds nothing and must not claim to have');
  assert.match(reread.stdout, /^worklet\.content-type=video\/mp2t$/m, reread.text);
  assert.match(reread.stdout, /^FAIL .*addModule rejects that with a MIME type mismatch/m, reread.text);
});

test('AC3 a tree with no client build is "could not measure", not a failed property', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'worklet-build-empty-'));
  try {
    const run = runCheck(['--root', empty]);
    assert.equal(run.status, 2, `exit 2 is the "could not measure" contract\n${run.text}`);
    assert.match(run.stdout, /^build=failed reason=no vite\.config\.js under /m, run.text);
    assert.doesNotMatch(run.stdout, /^FAIL /m, 'no property was measured, so none may be reported failed');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
