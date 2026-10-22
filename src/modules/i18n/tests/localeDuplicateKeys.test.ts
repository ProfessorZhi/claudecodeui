import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * AC-171. `src/modules/i18n/locales/en/chat.json` and `zh-CN/chat.json` each carried
 * two top-level `"resident"` blocks. `JSON.parse` silently keeps the last one, so the
 * first block's `toggle` and `notice.*` were unreachable at runtime: the UI rendered the
 * literal key names, and the resident-consent spec's `{ name: undefined }` locator
 * stopped filtering by name. Nothing in the repo caught it because every existing consumer
 * parses the file first — and a parsed object cannot show you the key it dropped.
 *
 * So this scans the RAW file text, before any parser has a chance to collapse the
 * duplicates, and it is the raw scan that is the load-bearing assertion here.
 */

// Resolved from the vitest process cwd (the repo root), the way the other
// filesystem-reading tests in this repo do it: under vitest's jsdom environment
// `import.meta.url` is not a file: URL, so `fileURLToPath` rejects it.
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

export type DuplicateKey = {
  /** Dotted path of the object the duplicate lives in ('' at the file root). */
  objectPath: string;
  /** The repeated key name. */
  key: string;
  /** The reported key:value path, e.g. "resident.notice". */
  fullPath: string;
};

export type LocaleScanResult = {
  /** Path relative to the locales directory, e.g. "en/chat.json". */
  file: string;
  duplicateKeys: DuplicateKey[];
};

type Frame =
  | { kind: 'object'; path: string; keys: Set<string>; pendingKey: string | null; expectKey: boolean }
  | { kind: 'array'; path: string };

/** The shape this test reads back out of a locale file — deliberately loose. */
type LocaleTree = {
  resident?: { toggle?: unknown; notice?: Record<string, unknown> };
};

/**
 * Every JSON file directly under a language directory: the `locales/* / * .json` shape.
 * Enumerated with readdir rather than a hardcoded list, so a language added (or a file
 * deleted) without this suite noticing cannot pass by silently going stale.
 */
export function listLocaleJsonFiles(dir: string = LOCALES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const langDir = join(dir, entry.name);
    for (const file of readdirSync(langDir)) {
      if (file.endsWith('.json')) out.push(join(langDir, file));
    }
  }
  return out.sort();
}

/**
 * Find keys that appear more than once inside the same object, reading `raw` as text.
 * A JSON parser is deliberately not used: it discards the earlier occurrence, which is
 * exactly the defect being hunted. The scanner walks the characters itself, so a string
 * body that happens to contain `{` or `"resident"` is not mistaken for structure.
 */
export function findDuplicateKeys(raw: string): DuplicateKey[] {
  const duplicates: DuplicateKey[] = [];
  const stack: Frame[] = [];
  let i = 0;

  const childPath = (parent: Frame | undefined, key: string | null): string => {
    const base = parent?.path ?? '';
    if (key === null) return base;
    return base === '' ? key : `${base}.${key}`;
  };

  const takeKey = (parent: Frame | undefined): string | null => {
    if (parent?.kind !== 'object') return null;
    const key = parent.pendingKey;
    parent.pendingKey = null;
    return key;
  };

  while (i < raw.length) {
    const char = raw[i];

    if (char === '"') {
      // Consume a string literal, honouring backslash escapes so `\"` does not end it.
      let j = i + 1;
      let value = '';
      while (j < raw.length) {
        const c = raw[j];
        if (c === '\\') {
          value += raw[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '"') break;
        value += c;
        j += 1;
      }
      i = j + 1;

      const top = stack[stack.length - 1];
      if (top?.kind === 'object' && top.expectKey) {
        if (top.keys.has(value)) {
          duplicates.push({
            objectPath: top.path,
            key: value,
            fullPath: top.path === '' ? value : `${top.path}.${value}`,
          });
        } else {
          top.keys.add(value);
        }
        top.pendingKey = value;
        top.expectKey = false;
      }
      continue;
    }

    if (char === '{') {
      const parent = stack[stack.length - 1];
      stack.push({
        kind: 'object',
        path: childPath(parent, takeKey(parent)),
        keys: new Set(),
        pendingKey: null,
        expectKey: true,
      });
      i += 1;
      continue;
    }

    if (char === '[') {
      const parent = stack[stack.length - 1];
      stack.push({ kind: 'array', path: childPath(parent, takeKey(parent)) });
      i += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      stack.pop();
      i += 1;
      continue;
    }

    if (char === ',') {
      const top = stack[stack.length - 1];
      if (top?.kind === 'object') top.expectKey = true;
      i += 1;
      continue;
    }

    if (char === ':') {
      i += 1;
      continue;
    }

    i += 1; // whitespace, numbers, true/false/null — none of them can be a key.
  }

  return duplicates;
}

export function scanLocaleFile(absPath: string, localesDir: string = LOCALES_DIR): LocaleScanResult {
  const raw = readFileSync(absPath, 'utf8');
  const file = absPath.startsWith(localesDir)
    ? relative(localesDir, absPath)
    : absPath;
  return { file, duplicateKeys: findDuplicateKeys(raw) };
}

function parsed(locale: string, file: string): LocaleTree {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, file), 'utf8')) as LocaleTree;
}

describe('locale files have no duplicate keys', () => {
  it('scans every locales/*/*.json file and finds no duplicate key in any of them', () => {
    const files = listLocaleJsonFiles();
    const scanned = files.map((f) => relative(LOCALES_DIR, f)).sort();

    // The covered file set is checked against the filesystem's own `*/*.json` glob, not a
    // fixed number: a hardcoded count would let a dropped directory or a truncated glob
    // pass unnoticed. Two independent enumerations agreeing is the assertion.
    const onDisk = globSync('*/*.json', { cwd: LOCALES_DIR }).sort();
    expect(scanned).toEqual(onDisk);
    expect(scanned.length).toBeGreaterThan(0);

    const offenders = files
      .map((f) => scanLocaleFile(f))
      .filter((r) => r.duplicateKeys.length > 0);
    expect(offenders.map((r) => `${r.file}: ${r.duplicateKeys.map((d) => d.fullPath).join(', ')}`)).toEqual([]);
  });

  // The keys the duplicate shadowed, read back through a parser the way the app reads
  // them. Without the merge these are `undefined` and the UI shows the raw key names.
  //
  // The notice's acknowledge key used to be asserted here and is deliberately absent: it was
  // the checkbox label of the consent gate that the resident-toggle relocation retired, and a
  // test that kept requiring a key nothing renders would be asserting a screen that no longer
  // exists. The four below are still what the switch and its hint read.
  it('exposes resident.toggle and resident.notice in en and zh-CN', () => {
    for (const locale of ['en', 'zh-CN']) {
      const chat = parsed(locale, 'chat.json');
      expect(typeof chat.resident?.toggle, `${locale} resident.toggle`).toBe('string');
      expect(typeof chat.resident?.notice?.title, `${locale} resident.notice.title`).toBe('string');
      expect(typeof chat.resident?.notice?.bypass, `${locale} resident.notice.bypass`).toBe('string');
      expect(typeof chat.resident?.notice?.trustBoundary, `${locale} resident.notice.trustBoundary`).toBe('string');
    }
  });

  // Positive control: a locale that only ever had one `resident` block must read GREEN
  // through the same scanner. If the scanner were stuck red this case would red too, and
  // a scanner that simply passed everything already reds the suite-level case above.
  it('reads a single-block locale as clean (positive control)', () => {
    expect(scanLocaleFile(join(LOCALES_DIR, 'de', 'chat.json')).duplicateKeys).toEqual([]);
  });
});
