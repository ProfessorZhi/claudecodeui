import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Quay workspace view is registered as `{ id: 'quay', labelKey: 'tabs.quay' }` in
 * WorkspaceTabs, so every language bundle has to carry that key. react-i18next renders a
 * missing key verbatim, which is how the tab shipped showing the literal text `tabs.quay`
 * instead of a label. This walks the whole `locales/&#42;/common.json` glob rather than a
 * hardcoded list, so a locale added (or dropped) without a matching key cannot pass by
 * silently going stale, and it does not settle for checking `en` alone.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other filesystem-reading
 * tests in this repo do it: under vitest's jsdom environment `import.meta.url` is not a
 * file: URL, so `fileURLToPath` rejects it.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type CommonBundle = { tabs?: Record<string, unknown> };

/**
 * The reasons a bundle fails the `tabs.quay` contract; an empty array means it passes.
 * Returning the reason rather than a boolean is what lets one positive control below prove
 * the checker can actually go red, instead of the suite merely asserting a constant green.
 */
function quayTabProblems(bundle: CommonBundle): string[] {
  const value = bundle.tabs?.quay;
  if (typeof value !== 'string') return ['tabs.quay is missing or not a string'];
  if (value.trim().length === 0) return ['tabs.quay is an empty string'];
  if (value === 'tabs.quay') return ['tabs.quay is the raw key name, not a label'];
  return [];
}

describe('every locale carries the tabs.quay label', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/common.json', { cwd: LOCALES_DIR }).sort();

  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    // Two independent enumerations agreeing: readdir for the directories, glob for the
    // bundles. A dropped directory or a truncated glob breaks this equality.
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale a non-empty tabs.quay that is not the key name itself', () => {
    const offenders: string[] = [];

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;
      for (const problem of quayTabProblems(bundle)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Positive control: the same checker must reject a bundle that lacks the key (or carries a
  // blank / copy-pasted value). If it could not, the case above would be a green that cannot
  // go red — exactly the failure it exists to catch.
  it('rejects a bundle with a missing, blank or key-copied tab label (positive control)', () => {
    expect(quayTabProblems({ tabs: {} })).toEqual(['tabs.quay is missing or not a string']);
    expect(quayTabProblems({ tabs: { quay: '' } })).toEqual(['tabs.quay is an empty string']);
    expect(quayTabProblems({ tabs: { quay: 'tabs.quay' } })).toEqual(['tabs.quay is the raw key name, not a label']);
    expect(quayTabProblems({ tabs: { quay: 'Quay' } })).toEqual([]);
  });
});
