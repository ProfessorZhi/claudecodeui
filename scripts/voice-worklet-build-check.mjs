#!/usr/bin/env node
/**
 * voice-worklet-build-check.mjs — the criterion for "the shipped client loads its AudioWorklet
 * module from built JavaScript".
 *
 * THE FAILURE THIS EXISTS FOR, MEASURED RATHER THAN IMAGINED. `voiceFrameProcessorUrl` used to
 * return `new URL('./voiceFrameProcessor.ts', import.meta.url).href`. The dev server reads that
 * correctly — it transforms the `.ts` on request and serves it as JavaScript — so every development
 * reading was green. A production build treats the same expression as a plain asset reference and
 * copies the file VERBATIM, so the deployed page asked the browser for
 * `/assets/voiceFrameProcessor-<hash>.ts`: TypeScript source, still carrying a bare
 * `@/shared/voiceEndpoint` specifier, under an extension `mime-db` resolves to `video/mp2t`.
 * `audioWorklet.addModule` rejected it as a module MIME type mismatch before a line of it ran, and
 * the microphone button reported "Failed to load worklet module script".
 *
 * WHAT IS JUDGED. The build output of `--root`'s own client build — a fresh one into a scratch
 * directory by default, or an existing output tree with `--built`. The readings are about the
 * ARTIFACT a deploy ships, not about the source that produced it. That is deliberate: a
 * source-shaped check (grep for `new URL(`, grep for `?worker&url`) is green on the bug in its most
 * likely next form, where the URL is computed somewhere the grep does not look.
 *
 * HOW THE WORKLET IS FOUND. Not by file name — the bundler's hash is not this check's business. The
 * module under judgement is the one the browser will FETCH, so it is found the way the browser
 * finds it: read the `/assets/...` URLs the emitted JavaScript chunks actually carry, and keep the
 * ones that resolve to a file registering an `AudioWorkletProcessor`. The marker is
 * `registerProcessor`, a name read off `globalThis` and therefore one no minifier may rename.
 *
 * THE CONTENT-TYPE READING USES THE SERVER'S OWN LIBRARY. `mime-types` is what `send` — and so
 * `express.static`, and so this repository's own dist serving — resolves a served file name
 * through. A hardcoded "`.js` is fine, `.ts` is not" would be this file's opinion; `mime-types` is
 * the mechanism. `source.content-type` is the control that keeps the reading honest: the worklet
 * SOURCE's own name, looked up through the same library, must NOT be a JavaScript type — if it ever
 * were, the extension would have stopped being the defect and this criterion's premise would be
 * gone, which is its own failure.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It starts no browser and no server. `addModule` is not invoked:
 * what the browser refused was a file NAME resolved through a mime database, and both halves of
 * that are read here directly. The price is stated rather than hidden — this criterion cannot see a
 * worklet that is served correctly and then fails to register at runtime, which is what
 * `e2e/voice-streaming-vad.spec.ts` drives a real `AudioContext` for.
 *
 * EXIT CODES. 0 = every reading is the expected one. 1 = at least one is not, each named on stdout.
 * 2 = the measurement could not be made at all (no vite config under `--root`, an unimportable
 * vite, a build that did not finish) — a distinct outcome on purpose, because "could not measure"
 * must not read as "measured, and the property failed".
 *
 * USAGE
 *   node scripts/voice-worklet-build-check.mjs [--root <dir>] [--built <dir>] [--keep]
 *
 *   --root <dir>   the checkout whose client is built (default: this script's own repository)
 *   --built <dir>  judge an existing build output instead of building (a deploy's own dist/)
 *   --keep         keep the scratch build directory (debugging)
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/**
 * `mime-types` — the database `send`, and therefore `express.static`, resolves a served file name
 * through. Reading the content type here is the same computation the static server performs, which
 * is the whole point: the defect was a file NAME, not a header anybody wrote.
 *
 * @type {{ lookup: (name: string) => string | false }}
 */
const mime = createRequire(import.meta.url)('mime-types');

/** The worklet's source, relative to `--root`. Its own name is what the defect ended up serving. */
const WORKLET_SOURCE_REL = 'src/modules/chat/audio/voiceFrameProcessor.ts';

/**
 * The `AudioWorkletGlobalScope` global the processor registers itself with. Read off `globalThis`,
 * so it is a property name and survives minification — which is what makes it usable as the marker
 * for "this emitted file is the worklet".
 */
const PROCESSOR_MARKER = 'registerProcessor';

/** The content types a JavaScript module script may be served under. */
const JS_CONTENT_TYPES = ['text/javascript', 'application/javascript'];

/** Every `/assets/...` URL an emitted chunk carries. */
const ASSET_URL = /\/assets\/[A-Za-z0-9._-]+/g;

/** The specifier of an emitted module's own `import ... from` / `export ... from`. */
const FROM_SPECIFIER = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;

/** The bare side-effect form, `import '...'`, which carries no `from`. */
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;

/**
 * @typedef {{ root: string, built: string | null, keep: boolean }} Options
 * @typedef {{ rel: string, abs: string, text: string }} Emitted
 */

// ── arguments ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const options = { root: DEFAULT_ROOT, built: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--built') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} needs a directory`);
      if (arg === '--root') options.root = path.resolve(value);
      else options.built = path.resolve(value);
      i += 1;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/voice-worklet-build-check.mjs [--root <dir>] [--built <dir>] [--keep]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// ── reading a build output ───────────────────────────────────────────────────────────────────

/**
 * Every regular file under `dir`, recursively.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function listFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(abs));
    else if (entry.isFile()) found.push(abs);
  }
  return found;
}

/**
 * The emitted JavaScript chunks of a build output, with their text.
 *
 * Source maps are skipped: they are not served as modules, and a `.map` naming an asset would be a
 * reference the browser never follows.
 *
 * @param {string} buildOut
 * @returns {Emitted[]}
 */
function emittedChunks(buildOut) {
  /** @type {Emitted[]} */
  const chunks = [];
  for (const abs of listFiles(buildOut)) {
    if (!abs.endsWith('.js') || abs.endsWith('.map')) continue;
    chunks.push({ rel: path.relative(buildOut, abs).split(path.sep).join('/'), abs, text: readFileSync(abs, 'utf8') });
  }
  return chunks;
}

/**
 * The specifiers a chunk imports or re-exports, from both the `from` form and the bare form.
 *
 * @param {string} text
 * @returns {string[]}
 */
function moduleSpecifiers(text) {
  /** @type {string[]} */
  const specifiers = [];
  for (const pattern of [FROM_SPECIFIER, BARE_IMPORT]) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Whether a specifier names another module rather than a package: a path the build output is
 * expected to satisfy on its own.
 *
 * @param {string} specifier
 * @returns {boolean}
 */
function isRelativeSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/**
 * The emitted file a `/assets/...` URL names, or null when the output holds no such file.
 *
 * @param {string} buildOut
 * @param {string} url
 * @returns {string | null} absolute path
 */
function assetTarget(buildOut, url) {
  const abs = path.join(buildOut, url.replace(/^\//, ''));
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

/**
 * WHAT THE PAGE LOADS, walked from the entry document rather than taken as "every file in the
 * output".
 *
 * The distinction is not pedantry — `build.emptyOutDir` is `false` in this repository on purpose,
 * so a `dist/` that has been built more than once holds the chunks of every earlier build beside
 * the current ones. Reading the whole directory would find the worklet URL of a build from last
 * week alongside this one's and report the app as shipping two of them. So the walk starts at
 * `index.html`, follows the `/assets/...` URLs it names, and then the ones those chunks name, which
 * is exactly the set a browser can be sent to.
 *
 * Falls back to every chunk when there is no `index.html` to root the walk at, so the readings are
 * about the whole output rather than about nothing; the `entry.rooted` line says which happened.
 *
 * @param {string} buildOut
 * @param {Emitted[]} chunks
 * @returns {{ loaded: Emitted[], carriers: Map<string, string[]>, rooted: boolean }}
 */
function loadedGraph(buildOut, chunks) {
  /** @type {Map<string, string[]>} */
  const carriers = new Map();
  /**
   * @param {string} url
   * @param {string} carrier
   */
  const note = (url, carrier) => {
    const list = carriers.get(url) ?? [];
    list.push(carrier);
    carriers.set(url, list);
  };

  const indexPath = path.join(buildOut, 'index.html');
  if (!existsSync(indexPath)) {
    for (const chunk of chunks) for (const match of chunk.text.matchAll(ASSET_URL)) note(match[0], chunk.rel);
    return { loaded: chunks, carriers, rooted: false };
  }

  const byRel = new Map(chunks.map((chunk) => [chunk.rel, chunk]));
  /** @type {string[]} */
  const queue = [...readFileSync(indexPath, 'utf8').matchAll(ASSET_URL)].map((match) => match[0]);
  /** @type {Emitted[]} */
  const loaded = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < queue.length; i += 1) {
    const rel = queue[i].replace(/^\//, '');
    if (seen.has(rel)) continue;
    const chunk = byRel.get(rel);
    if (chunk === undefined) continue;
    seen.add(rel);
    loaded.push(chunk);
    for (const match of chunk.text.matchAll(ASSET_URL)) {
      note(match[0], chunk.rel);
      queue.push(match[0]);
    }
  }
  return { loaded, carriers, rooted: true };
}

// ── the build ────────────────────────────────────────────────────────────────────────────────

/**
 * Builds `root`'s client into `outDir`.
 *
 * A failure here is "could not measure", not "the property failed": the tree may legitimately have
 * no vite, and a build broken for an unrelated reason says nothing about the worklet's URL.
 *
 * @param {string} root
 * @param {string} outDir
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function buildClient(root, outDir) {
  const configFile = path.join(root, 'vite.config.js');
  if (!existsSync(configFile)) return { ok: false, reason: `no vite.config.js under ${root}` };

  /** @type {typeof import('vite')} */
  let vite;
  try {
    vite = await import('vite');
  } catch (error) {
    return { ok: false, reason: `vite is not importable from this check: ${String(error)}` };
  }

  /** @type {import('vite').InlineConfig} */
  const config = {
    configFile,
    root,
    mode: 'production',
    logLevel: 'error',
    build: { outDir, emptyOutDir: true },
  };
  try {
    await vite.build(config);
  } catch (error) {
    return { ok: false, reason: `the client build failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}

// ── the readings ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ lines: string[], problems: string[] }} Reading
 */

/**
 * Judges one build output.
 *
 * @param {string} root
 * @param {string} buildOut
 * @returns {Reading}
 */
function judge(root, buildOut) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const problems = [];

  const chunks = emittedChunks(buildOut);
  if (chunks.length === 0) {
    problems.push(`no emitted JavaScript under ${buildOut} — there is nothing to read`);
    return { lines, problems };
  }

  const graph = loadedGraph(buildOut, chunks);
  lines.push(`entry.rooted=${graph.rooted ? 'index.html' : '<no index.html: every emitted chunk>'}`);
  lines.push(`entry.loaded-chunks=${graph.loaded.length}`);
  lines.push(`emitted.chunks=${chunks.length}`);

  // The files the page can be sent to: every `/assets/...` URL a loaded chunk carries, resolved to
  // an emitted file. The worklet is then found the way the browser finds it — one of THOSE that
  // registers a processor. Both halves matter: an unreferenced `.js` that happens to register one
  // is not what the page loads.
  /** @type {{ url: string, abs: string, rel: string, carriers: string[], text: string }[]} */
  const shipped = [];
  for (const [url, carriers] of graph.carriers) {
    const abs = assetTarget(buildOut, url);
    if (abs === null) continue;
    const rel = path.relative(buildOut, abs).split(path.sep).join('/');
    shipped.push({ url, abs, rel, carriers, text: readFileSync(abs, 'utf8') });
  }

  const worklets = shipped.filter((file) => file.text.includes(PROCESSOR_MARKER));

  if (worklets.length === 0) {
    problems.push(
      `no /assets/... URL the loaded chunks carry resolves to a file registering an AudioWorkletProcessor` +
        ` (${graph.carriers.size} asset URL(s) read, ${graph.loaded.length} loaded chunk(s) scanned)`,
    );
    return { lines, problems };
  }
  if (worklets.length > 1) {
    problems.push(
      `the app ships ${worklets.length} worklet URLs, expected exactly 1: ${worklets.map((w) => w.url).join(' ')}`,
    );
  }

  const worklet = worklets[0];
  const rel = worklet.rel;
  lines.push(`worklet.url=${worklet.url}`);
  lines.push(`worklet.file=${rel}`);
  lines.push(`worklet.carried-by=${worklet.carriers.join(',')}`);

  // The MIME reading, through the server's own library. This is the reading the shipped defect
  // failed: `video/mp2t` for a file the app hands to `addModule`.
  const served = mime.lookup(rel);
  lines.push(`worklet.content-type=${served === false ? '<unmapped>' : served}`);
  if (served === false || !JS_CONTENT_TYPES.includes(served)) {
    problems.push(
      `the shipped worklet ${rel} is served as ${served === false ? '<unmapped>' : served}, not a JavaScript type` +
        ` (${JS_CONTENT_TYPES.join(' | ')}) — addModule rejects that with a MIME type mismatch`,
    );
  }

  // The control. `mime-types` must NOT call the worklet's own source name a JavaScript type; if it
  // ever did, the extension would no longer be the defect and the reading above would be measuring
  // the wrong thing.
  const sourceType = mime.lookup(WORKLET_SOURCE_REL);
  lines.push(`source.content-type=${sourceType === false ? '<unmapped>' : sourceType}`);
  if (sourceType !== false && JS_CONTENT_TYPES.includes(sourceType)) {
    problems.push(
      `the control failed: ${WORKLET_SOURCE_REL} resolves to ${sourceType}, a JavaScript type — serving the source` +
        ' would be loadable and this criterion would no longer be about the defect it claims to judge',
    );
  }

  // Self-containment. `addModule` runs the file as a module script from its own URL, so every
  // specifier it carries has to be one the output already answers: a bare name (`@/...`,
  // `@shared/...`, a package) is a resolution the browser cannot make.
  const specifiers = moduleSpecifiers(readFileSync(worklet.abs, 'utf8'));
  const bare = specifiers.filter((specifier) => !isRelativeSpecifier(specifier));
  const unresolved = specifiers
    .filter(isRelativeSpecifier)
    .filter((specifier) => !existsSync(path.resolve(path.dirname(worklet.abs), specifier)));
  lines.push(`worklet.bare-specifiers=${bare.length}${bare.length > 0 ? ` list=${bare.join(',')}` : ''}`);
  lines.push(`worklet.unresolved-imports=${unresolved.length}${unresolved.length > 0 ? ` list=${unresolved.join(',')}` : ''}`);
  if (bare.length > 0) {
    problems.push(
      `the shipped worklet imports ${bare.length} bare specifier(s) the browser cannot resolve: ${bare.join(', ')}`,
    );
  }
  if (unresolved.length > 0) {
    problems.push(`the shipped worklet imports ${unresolved.length} path(s) the build output does not hold: ${unresolved.join(', ')}`);
  }

  // Verbatim copies. The defect's other half: the build did not compile the worklet, it copied it.
  // Read as content, not as a name, so a rename cannot hide it — and read over the files the page
  // can actually be sent to, so a copy an earlier build left behind in this directory is clutter
  // rather than a shipped source file.
  const sourcePath = path.join(root, WORKLET_SOURCE_REL);
  if (existsSync(sourcePath)) {
    const source = readFileSync(sourcePath, 'utf8');
    /** @type {Map<string, string>} */
    const shippedText = new Map();
    for (const file of graph.loaded) shippedText.set(file.rel, file.text);
    for (const file of shipped) shippedText.set(file.rel, file.text);
    const copies = [...shippedText].filter(([, text]) => text === source).map(([file]) => file);
    lines.push(`worklet.verbatim-copies=${copies.length}${copies.length > 0 ? ` list=${copies.join(',')}` : ''}`);
    if (copies.length > 0) {
      problems.push(
        `the build output holds ${copies.length} verbatim copy/copies of ${WORKLET_SOURCE_REL}: ${copies.join(', ')}` +
          ' — the worklet was copied, not built',
      );
    }
  } else {
    lines.push(`worklet.verbatim-copies=<unreadable: no ${WORKLET_SOURCE_REL} under ${root}>`);
    problems.push(
      `cannot show the worklet was built rather than copied: ${WORKLET_SOURCE_REL} is not readable under ${root}`,
    );
  }

  return { lines, problems };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} the process exit code */
async function main() {
  /** @type {Options} */
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!existsSync(options.root) || !statSync(options.root).isDirectory()) {
    process.stdout.write(`root is not a directory: ${options.root}\n`);
    return 2;
  }

  /** @type {string | null} */
  let scratch = null;
  /** @type {string} */
  let buildOut;
  if (options.built !== null) {
    buildOut = options.built;
    if (!existsSync(buildOut) || !statSync(buildOut).isDirectory()) {
      process.stdout.write(`--built is not a directory: ${buildOut}\n`);
      return 2;
    }
  } else {
    // Beside the tree rather than in the OS temp directory: the build writes ~11 MB of chunks and
    // this host's temp filesystem is not the one the checkout lives on.
    scratch = mkdtempSync(path.join(path.dirname(options.root), 'voice-worklet-build-'));
    buildOut = scratch;
    const built = await buildClient(options.root, buildOut);
    if (!built.ok) {
      process.stdout.write(`voice-worklet-build-check root=${options.root}\n`);
      process.stdout.write(`build=failed reason=${built.reason}\n`);
      rmSync(scratch, { recursive: true, force: true });
      return 2;
    }
  }

  const reading = judge(options.root, buildOut);
  process.stdout.write(`voice-worklet-build-check root=${options.root}\n`);
  if (options.built === null) process.stdout.write('build=ok\n');
  process.stdout.write(`build.out=${buildOut}\n`);
  for (const line of reading.lines) process.stdout.write(`${line}\n`);

  const failing = [...new Set(reading.problems)];
  for (const problem of failing) process.stdout.write(`FAIL ${problem}\n`);

  if (scratch !== null && !options.keep) rmSync(scratch, { recursive: true, force: true });
  if (scratch !== null && options.keep) process.stdout.write(`scratch.kept=${scratch}\n`);

  return failing.length === 0 ? 0 : 1;
}

process.exitCode = await main();
