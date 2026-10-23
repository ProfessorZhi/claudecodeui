import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * The AC-226 criterion: the `/api/agent` surface and the plaintext API-key
 * mechanism are gone from production code.
 *
 * Every reading comes from the TypeScript SYNTAX TREE, never from grepped text.
 * That is not decoration. The retirement deliberately leaves prose behind — the
 * `schema.ts` and `migrations.ts` comments explain what was removed and why a
 * fresh database must not carry it, and `api-docs.html` is rewritten rather than
 * deleted — so a text scan would either trip over the explanation or have to be
 * hand-taught to ignore comments, which is exactly what a parse gets right for
 * free. `(d)` proves the scanner in the SAME run: synthetic sources put the
 * three identifiers in code, in a comment, and in a string, and the counts must
 * separate them.
 *
 * `(a)`–`(c)` and `(e)` are the retirement readings; `(d)` is their positive
 * control, so a zero from `(c)` is a real zero and not a dead scanner. `(e)` has
 * two branches — the docs page was rewritten (this repo) or deleted — and both
 * are implemented below; the branch this repo takes is the existence branch.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const ENTRYPOINT = path.join(SERVER_DIR, 'index.ts');
const DATABASE_BARREL = path.join(SERVER_DIR, 'modules', 'database', 'index.ts');
const AGENT_DIR = path.join(SERVER_DIR, 'modules', 'agent');
const API_DOCS = path.join(REPO_ROOT, 'public', 'api-docs.html');

/** The three identifiers AC-226 removes from the production surface. */
const RETIRED_IDENTIFIERS = ['apiKeysDb', 'createAgentModule', 'API_KEYS_TABLE_SCHEMA_SQL'] as const;

type Scan = {
  identifiers: string[];
  importSpecifiers: string[];
  appUsePaths: string[];
  stringLiterals: string[];
};

/** `.tsx` must be parsed as TSX, or JSX reads as a type assertion. */
function scriptKindFor(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Parses one source text and collects the four readings the retirement is taken
 * through. Comments are trivia and produce no node at all, which is why they can
 * never appear in any of the four arrays.
 */
function scanSource(filePath: string, text: string): Scan {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const scan: Scan = { identifiers: [], importSpecifiers: [], appUsePaths: [], stringLiterals: [] };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      scan.identifiers.push(node.text);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      scan.importSpecifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const target = appUsePath(node);
      if (target !== null) scan.appUsePaths.push(target);
    }
    if (ts.isStringLiteral(node)) {
      scan.stringLiterals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return scan;
}

/**
 * The first argument of an `app.use('<path>', ...)` call, or null when the call
 * is anything else. The receiver name, the property name and the literal-ness of
 * the first argument are all checked, so a call on another object — or an
 * `app.use` whose path is a variable — is not read as a mount.
 */
function appUsePath(node: ts.CallExpression): string | null {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  if (expression.name.text !== 'use') return null;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'app') return null;
  if (node.arguments.length === 0) return null;
  const firstArgument = node.arguments[0];
  return ts.isStringLiteral(firstArgument) ? firstArgument.text : null;
}

function isTestPath(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  const fileName = segments[segments.length - 1];
  if (segments.some((segment) => segment === 'tests' || segment === 'test')) return true;
  return /\.(test|spec)\.tsx?$/.test(fileName);
}

/**
 * Every `.ts`/`.tsx` file under `root` that is NOT a test, walking the directory
 * tree directly — so the reading is of what is on disk, not of whatever a
 * tsconfig happens to include. `node_modules` and built `dist*` directories are
 * pruned; test files are excluded by path segment or by filename suffix.
 */
function collectSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name.startsWith('dist'))) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (/\.tsx?$/.test(entry.name)) {
        const relative = path.relative(REPO_ROOT, absolute);
        if (!isTestPath(relative)) found.push(absolute);
      }
    }
  };
  walk(root);
  return found;
}

// The `(d)` controls are spelled as joined strings rather than written inline as
// live code, so this criterion's own text never contains a stranded retired
// identifier that a reader could mistake for a real hit.
const D1_SOURCE = [
  'const apiKeysDb = 1;',
  'function createAgentModule() {}',
  'const API_KEYS_TABLE_SCHEMA_SQL = 1;',
  '// apiKeysDb createAgentModule API_KEYS_TABLE_SCHEMA_SQL',
  'const asString = "apiKeysDb createAgentModule API_KEYS_TABLE_SCHEMA_SQL";',
].join('\n');

const D3_ENTRYPOINT_SOURCE = [
  "import { x } from './modules/agent/index.js';",
  "app.use('/api/agent', r);",
  "// app.use('/api/agent')",
  'const plain = "modules/agent";',
].join('\n');

const D3_STRING_SOURCE = 'const docsPath = "/api-docs.html";';

function countIdentifier(scan: Scan, name: string): number {
  return scan.identifiers.filter((identifier) => identifier === name).length;
}

test('(a) the agent module directory is gone', () => {
  const exists = fs.existsSync(AGENT_DIR);
  console.log(`(a) fs.existsSync(${path.relative(REPO_ROOT, AGENT_DIR)}) = ${exists}`);
  assert.equal(exists, false, 'server/modules/agent must not exist after AC-226');
});

test('(b) the entrypoint imports no agent module and mounts no /api/agent route', () => {
  const scan = scanSource(ENTRYPOINT, fs.readFileSync(ENTRYPOINT, 'utf8'));
  const agentImports = scan.importSpecifiers.filter((specifier) => specifier.includes('modules/agent'));
  const agentMounts = scan.appUsePaths.filter((target) => target === '/api/agent');

  console.log(`(b) import specifiers (${scan.importSpecifiers.length}): ${JSON.stringify(scan.importSpecifiers)}`);
  console.log(`(b) app.use paths (${scan.appUsePaths.length}): ${JSON.stringify(scan.appUsePaths)}`);
  console.log(`(b) agent import specifiers: ${JSON.stringify(agentImports)}; /api/agent mounts: ${JSON.stringify(agentMounts)}`);

  assert.deepEqual(agentImports, [], 'server/index.ts must not import any modules/agent specifier');
  assert.deepEqual(agentMounts, [], "server/index.ts must not mount '/api/agent'");
});

test('(c) the three retired identifiers have zero non-test hits across server/ and src/', () => {
  const files = [...collectSourceFiles(SERVER_DIR), ...collectSourceFiles(SRC_DIR)];
  const totals: Record<string, number> = {};
  for (const name of RETIRED_IDENTIFIERS) totals[name] = 0;

  for (const file of files) {
    const scan = scanSource(file, fs.readFileSync(file, 'utf8'));
    for (const name of RETIRED_IDENTIFIERS) {
      totals[name] += countIdentifier(scan, name);
    }
  }

  console.log(`(c) scanned files: ${files.length}`);
  for (const name of RETIRED_IDENTIFIERS) {
    console.log(`(c) ${name}: ${totals[name]}`);
  }

  for (const name of RETIRED_IDENTIFIERS) {
    assert.equal(totals[name], 0, `${name} must have zero identifier hits in non-test server/ and src/ sources`);
  }
});

test('(d1) positive control: code-position identifiers are counted, comments and strings are not', () => {
  const scan = scanSource('synthetic.ts', D1_SOURCE);
  console.log(
    `(d1) synthetic identifier counts: ${JSON.stringify(
      RETIRED_IDENTIFIERS.map((name) => [name, countIdentifier(scan, name)]),
    )}`,
  );
  for (const name of RETIRED_IDENTIFIERS) {
    assert.equal(
      countIdentifier(scan, name),
      1,
      `${name} must be counted exactly once from its code position, never from the comment or the string`,
    );
  }
});

test('(d2) positive control: userDb is found in the database barrel', () => {
  const scan = scanSource(DATABASE_BARREL, fs.readFileSync(DATABASE_BARREL, 'utf8'));
  const count = countIdentifier(scan, 'userDb');
  console.log(`(d2) userDb in server/modules/database/index.ts: ${count}`);
  assert.ok(count >= 1, 'the zero reading must not come from a dead scanner: a known-present identifier must be found');
});

test('(d3) positive control: the import and app.use detectors fire once each and are not fooled; the string-literal detector finds the docs path', () => {
  const entrypointScan = scanSource('synthetic-index.ts', D3_ENTRYPOINT_SOURCE);
  const agentImports = entrypointScan.importSpecifiers.filter((specifier) => specifier.includes('modules/agent'));
  console.log(`(d3) synthetic import specifiers: ${JSON.stringify(entrypointScan.importSpecifiers)}`);
  console.log(`(d3) synthetic app.use paths: ${JSON.stringify(entrypointScan.appUsePaths)}`);
  assert.equal(agentImports.length, 1, 'the import detector must find the import and not the plain string');
  assert.equal(entrypointScan.appUsePaths.length, 1, 'the app.use detector must find the call and not the comment');

  const stringScan = scanSource('synthetic-docs.ts', D3_STRING_SOURCE);
  const docsHits = stringScan.stringLiterals.filter((literal) => literal === '/api-docs.html');
  console.log(`(d3) synthetic string literals: ${JSON.stringify(stringScan.stringLiterals)}`);
  assert.equal(docsHits.length, 1, 'the string-literal detector must find a bare "/api-docs.html"');
});

test('(e) api-docs.html no longer advertises the retired surface (or the docs string is absent from src/)', () => {
  if (fs.existsSync(API_DOCS)) {
    const text = fs.readFileSync(API_DOCS, 'utf8');
    const agentHits = text.split('/api/agent').length - 1;
    const keyPrefixHits = text.split('ck_').length - 1;
    console.log(
      `(e) ${path.relative(REPO_ROOT, API_DOCS)} exists; '/api/agent' occurrences: ${agentHits}; 'ck_' occurrences: ${keyPrefixHits}`,
    );
    assert.ok(!text.includes('/api/agent'), 'api-docs.html must not describe the retired /api/agent endpoint');
    assert.ok(!text.includes('ck_'), 'api-docs.html must not describe the retired plaintext ck_ key prefix');
  } else {
    const hits: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const scan = scanSource(file, fs.readFileSync(file, 'utf8'));
      if (scan.stringLiterals.includes('/api-docs.html')) hits.push(path.relative(REPO_ROOT, file));
    }
    console.log(
      `(e) ${path.relative(REPO_ROOT, API_DOCS)} absent; src/ files naming it as a string literal: ${JSON.stringify(hits)}`,
    );
    assert.deepEqual(hits, [], 'with the docs page deleted no src/ source may still link to it as a string literal');
  }
});
