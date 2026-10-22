#!/usr/bin/env node
// Probe: does the quay plugin's suite-failure attribution regex cover this repo's log format?
// Compares files named by `not ok -` lines with what the plugin's own regex extracts from `passed=false` lines.
// Exit 1 when named failing files exceed extracted ones (unattributed failures). Deliberately NOT part of scripts/test.sh.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATH_RE = /((?:[\w@.-]+\/)+[\w@.-]+\.[cm]?[jt]sx?)(?=[:\s]|$)/;

/**
 * Files named by `not ok - <path>: …` lines. The `lint`/`typecheck` pseudo-files (`not ok - lint: …`)
 * carry no path and are deliberately not counted as test files.
 * @param {unknown} logText
 * @returns {string[]}
 */
export function namedFailingFiles(logText) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const raw of String(logText ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('not ok -')) continue;
    const m = PATH_RE.exec(line.slice('not ok -'.length));
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * Files a candidate regex extracts from `… passed=false` lines.
 * @param {unknown} logText
 * @param {RegExp} regex
 * @returns {string[]}
 */
export function extractedFailingFiles(logText, regex) {
  /** @type {string[]} */
  const out = [];
  for (const raw of String(logText ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.includes('passed=false')) continue;
    const m = regex.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The regex `failingTestFilesFromSuiteLog` actually uses, read out of the plugin's dist.
 * @param {string} providerPath
 * @returns {RegExp}
 */
export function pluginRegex(providerPath) {
  const pluginRoot = path.resolve(providerPath, '..', '..');
  const dist = path.join(pluginRoot, 'scripts', 'dist', 'worker-driver.js');
  const src = fs.readFileSync(dist, 'utf8');
  const fn = src.indexOf('function failingTestFilesFromSuiteLog');
  if (fn < 0) throw new Error(`failingTestFilesFromSuiteLog not found in ${dist}`);
  const lit = /(\/(?:\\.|[^/\n])+\/[a-z]*)\.exec\(line\)/.exec(src.slice(fn, fn + 1200));
  if (!lit) throw new Error(`regex literal not found in ${dist}`);
  const body = lit[1];
  const end = body.lastIndexOf('/');
  return new RegExp(body.slice(1, end), body.slice(end + 1));
}

function providerPathFromConfig() {
  const cfg = fs.readFileSync(path.join(ROOT, '.quay', 'config.yml'), 'utf8');
  const m = /^\s*path:\s*"?([^"\n]+?)"?\s*$/m.exec(cfg);
  if (!m) throw new Error('provider path not found in .quay/config.yml');
  return m[1];
}

function mainCheckoutRoot() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return path.dirname(common);
  } catch {
    return ROOT;
  }
}

function latestLog() {
  const files = [...new Set([ROOT, mainCheckoutRoot()])].flatMap((root) => {
    const dir = path.join(root, '.quay');
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^fan-in-suite-.*\.log$/.test(f)).map((f) => path.join(dir, f))
      : [];
  }).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  if (!files.length) throw new Error('no .quay/fan-in-suite-*.log found');
  return files[files.length - 1];
}

function main() {
  const i = process.argv.indexOf('--log');
  const log = i >= 0 ? path.resolve(process.argv[i + 1]) : latestLog();
  const text = fs.readFileSync(log, 'utf8');
  const named = namedFailingFiles(text);
  const extracted = extractedFailingFiles(text, pluginRegex(providerPathFromConfig()));
  console.log(`log: ${log}`);
  console.log(`named failing files (not ok -): ${named.length}${named.length ? ` [${named.join(', ')}]` : ''}`);
  console.log(`parser-extracted files (passed=false): ${extracted.length}`);
  console.log(`unattributed: ${Math.max(0, named.length - extracted.length)}`);
  if (named.length > extracted.length) {
    console.error('FAIL: suite log names failing files the plugin regex cannot attribute');
    process.exit(1);
  }
  console.log('OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
