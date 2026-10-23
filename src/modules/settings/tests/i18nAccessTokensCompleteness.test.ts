import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Settings → API tab renders personal access tokens through `AccessTokensSection.tsx`
 * and `NewAccessTokenAlert.tsx` (both `useTranslation('settings')`), plus the revoke-confirm
 * label read by `CredentialsSettingsTab.tsx`. Every one of the locale `settings.json` bundles
 * therefore has to carry the whole `accessTokens` namespace: react-i18next renders a missing
 * key verbatim, which is how a half-translated bundle ships the literal text
 * `accessTokens.list.revokeButton` to the user — the failure this test exists to prevent.
 *
 * The required-key list below is the *live* contract: exactly the `accessTokens.*` keys those
 * three components read (grep for `accessTokens.` under `src/modules/settings/`). It is kept
 * as an independent literal rather than derived from `en`, so a locale that quietly drops one
 * keys reds even when `en` agrees with it.
 *
 * It walks the whole `locales/*\/settings.json` glob rather than a hardcoded language list, so
 * a locale added (or dropped) without a matching key cannot pass by silently going stale, and
 * it does not settle for checking `en` alone. Resolved from the vitest process cwd (the repo
 * root), the way the other filesystem-reading tests in this repo do it: under vitest's jsdom
 * environment `import.meta.url` is not a file: URL, so `fileURLToPath` rejects it.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The bundle every other locale's `accessTokens` key set is compared against. */
const REFERENCE_LOCALE = 'en';

/**
 * Every `accessTokens` key the settings UI actually renders. Fixed independently of the locale
 * files so that dropping one from all twelve still reds the checker below.
 */
const REQUIRED_ACCESS_TOKEN_KEYS = [
  // AccessTokensSection — section header.
  'title',
  'description',
  'newButton',
  // AccessTokensSection — create-token form.
  'form.namePlaceholder',
  'form.expiryLabel',
  'form.expiryOption',
  'form.createButton',
  'form.cancelButton',
  // AccessTokensSection — the create form's dated default name.
  'form.defaultName',
  // AccessTokensSection — token list, plus CredentialsSettingsTab's revoke confirmation.
  'list.empty',
  'list.unnamed',
  'list.expires',
  'list.lastUsed',
  'list.never',
  'list.active',
  'list.revoked',
  'list.revokeButton',
  'list.revokeConfirm',
  // AccessTokensSection — the advanced read-only OAuth-token list.
  'list.created',
  'list.expired',
  'oauthTokens.title',
  'oauthTokens.description',
  'oauthTokens.empty',
  'oauthTokens.showInactive',
  'oauthTokens.unknownClient',
  'oauthTokens.kind',
  'oauthTokens.kindAccess',
  'oauthTokens.kindRefresh',
  'oauthTokens.scopes',
  // NewAccessTokenAlert — the one-time plaintext card.
  'newToken.alertTitle',
  'newToken.alertMessage',
  'newToken.copy',
  'newToken.iveSavedIt',
] as const;

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type AccessTokensNamespace = Record<string, unknown>;
type SettingsBundle = { accessTokens?: AccessTokensNamespace };

/** Reads a dotted path out of a nested namespace, returning undefined on any missing hop. */
function readPath(namespace: AccessTokensNamespace, dottedPath: string): unknown {
  let node: unknown = namespace;
  for (const part of dottedPath.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every leaf key of a namespace, dotted. A non-object (string, number, ...) is a leaf. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return prefix.length > 0 ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix.length > 0 ? `${prefix}.${key}` : key),
  );
}

/**
 * The reasons a locale's `accessTokens` namespace fails the contract; an empty array means it
 * passes. Returning the reasons (rather than a boolean) is what lets the positive controls
 * below prove the checker can actually go red, instead of the suite merely asserting a
 * constant green.
 */
function accessTokensProblems(namespace: AccessTokensNamespace | undefined): string[] {
  const problems: string[] = [];
  const source = namespace ?? {};
  for (const key of REQUIRED_ACCESS_TOKEN_KEYS) {
    const value = readPath(source, key);
    if (value === undefined) {
      problems.push(`${key} is missing`);
      continue;
    }
    if (typeof value !== 'string') {
      problems.push(`${key} is not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`${key} is an empty string`);
      continue;
    }
    const leafName = key.slice(key.lastIndexOf('.') + 1);
    if (value === leafName || value === key || value === `accessTokens.${key}`) {
      problems.push(`${key} is the raw key name, not a label`);
    }
  }
  return problems;
}

/** Builds a synthetic namespace whose every key carries a distinct, valid label. */
function completeNamespace(keys: readonly string[] = REQUIRED_ACCESS_TOKEN_KEYS): AccessTokensNamespace {
  const root: AccessTokensNamespace = {};
  for (const key of keys) {
    const parts = key.split('.');
    const leaf = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      const existing = node[part];
      if (!existing || typeof existing !== 'object') node[part] = {};
      node = node[part] as AccessTokensNamespace;
    }
    node[leaf] = `translated text for ${key}`;
  }
  return root;
}

describe('every locale carries a complete accessTokens namespace', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/settings.json', { cwd: LOCALES_DIR }).sort();

  it('covers every language directory on disk (the full-locale glob, not a sampled subset)', () => {
    // Two independent enumerations agreeing: readdir for the directories, glob for the
    // bundles. A dropped directory or a truncated glob breaks this equality.
    console.log(`[AC5] readdir directories (${localeDirs.length}): ${JSON.stringify(localeDirs)}`);
    console.log(`[AC5] glob settings.json files (${bundleFiles.length}): ${JSON.stringify(bundleFiles)}`);
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/settings.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale every required accessTokens key, non-empty and not the key name', () => {
    const offenders: string[] = [];
    const flatKeyCounts: Record<string, number> = {};

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      flatKeyCounts[file] = flattenKeys(bundle.accessTokens).length;
      for (const problem of accessTokensProblems(bundle.accessTokens)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    console.log(`[AC2] per-locale accessTokens flat key counts: ${JSON.stringify(flatKeyCounts)}`);
    console.log(`[AC2] offenders (${offenders.length}): ${JSON.stringify(offenders)}`);
    expect(offenders).toEqual([]);
  });

  it('gives every locale exactly the same accessTokens key set as en', () => {
    const reference = JSON.parse(
      readFileSync(join(LOCALES_DIR, REFERENCE_LOCALE, 'settings.json'), 'utf8'),
    ) as SettingsBundle;
    const referenceKeys = new Set(flattenKeys(reference.accessTokens));

    const diffs: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      const keys = new Set(flattenKeys(bundle.accessTokens));
      diffs[file] = {
        missing: [...referenceKeys].filter((key) => !keys.has(key)).sort(),
        extra: [...keys].filter((key) => !referenceKeys.has(key)).sort(),
      };
    }

    console.log(
      `[AC3] ${REFERENCE_LOCALE} accessTokens keys (${referenceKeys.size}): ${JSON.stringify([...referenceKeys].sort())}`,
    );
    console.log(`[AC3] per-locale key-set diffs vs ${REFERENCE_LOCALE}: ${JSON.stringify(diffs)}`);

    for (const file of bundleFiles) {
      expect(diffs[file], `${file} key set vs ${REFERENCE_LOCALE}`).toEqual({ missing: [], extra: [] });
    }
  });

  // Positive control: the same checker must reject a bundle that lacks a key (or carries a
  // blank / key-copied value). If it could not, the cases above would be a green that cannot
  // go red — exactly the failure they exist to catch.
  it('rejects a bundle with a missing, blank or key-copied label (positive control)', () => {
    // Every required key missing -> one reason per key, in declaration order.
    expect(accessTokensProblems({})).toEqual(REQUIRED_ACCESS_TOKEN_KEYS.map((key) => `${key} is missing`));

    // A complete bundle that lacks exactly one key -> only that one reason.
    const missingOne = REQUIRED_ACCESS_TOKEN_KEYS.filter((key) => key !== 'list.revokeButton');
    expect(accessTokensProblems(completeNamespace(missingOne))).toEqual(['list.revokeButton is missing']);

    // A complete, valid bundle -> no reasons at all.
    expect(accessTokensProblems(completeNamespace())).toEqual([]);

    // The blank and key-copied arms of the checker (leaf name and full `accessTokens.` path).
    const blanked = completeNamespace();
    (blanked.form as AccessTokensNamespace).namePlaceholder = '   ';
    expect(accessTokensProblems(blanked)).toEqual(['form.namePlaceholder is an empty string']);

    const copiedLeaf = completeNamespace();
    (copiedLeaf.list as AccessTokensNamespace).revokeButton = 'revokeButton';
    expect(accessTokensProblems(copiedLeaf)).toEqual(['list.revokeButton is the raw key name, not a label']);

    const copiedFull = completeNamespace();
    (copiedFull.newToken as AccessTokensNamespace).copy = 'accessTokens.newToken.copy';
    expect(accessTokensProblems(copiedFull)).toEqual(['newToken.copy is the raw key name, not a label']);
  });
});
