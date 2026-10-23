import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Settings → API tab renders the "Connected apps" block through `ConnectedAppsSection.tsx`
 * and the "OAuth clients (advanced)" block through `OAuthClientsSection.tsx` +
 * `NewOAuthClientAlert.tsx` (all `useTranslation('settings')`), plus the revoke/disable confirm
 * labels read by `CredentialsSettingsTab.tsx`. Every one of the locale `settings.json` bundles
 * therefore has to carry the whole `connectedApps` and `oauthClients` namespaces: react-i18next
 * renders a missing key verbatim, which is how a half-translated bundle ships the literal text
 * `connectedApps.list.revokeButton` to the user — the failure this test exists to prevent.
 *
 * The required-key lists below are the *live* contract: exactly the `connectedApps.*` and
 * `oauthClients.*` keys those components read (grep for `connectedApps.` / `oauthClients.` under
 * `src/modules/settings/`). They are kept as independent literals rather than derived from `en`,
 * so a locale that quietly drops one keys reds even when `en` agrees with it.
 *
 * It walks the whole `locales/*\/settings.json` glob rather than a hardcoded language list, so a
 * locale added (or dropped) without a matching key cannot pass by silently going stale, and it
 * does not settle for checking `en` alone. Resolved from the vitest process cwd (the repo root),
 * the way the other filesystem-reading tests in this repo do it: under vitest's jsdom
 * environment `import.meta.url` is not a file: URL, so `fileURLToPath` rejects it.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The bundle every other locale's key sets are compared against. */
const REFERENCE_LOCALE = 'en';

/**
 * Every `connectedApps` key the settings UI actually renders. Fixed independently of the locale
 * files so that dropping one from all twelve still reds the checker below.
 */
const REQUIRED_CONNECTED_APPS_KEYS = [
  // ConnectedAppsSection — section header and revoke confirmation.
  'title',
  'description',
  // ConnectedAppsSection — grant list.
  'list.empty',
  'list.redirectHost',
  'list.scopes',
  'list.createdAt',
  'list.lastUsed',
  'list.never',
  'list.revokeButton',
  'list.revokeConfirm',
] as const;

/**
 * Every `oauthClients` key the settings UI actually renders. Fixed independently of the locale
 * files so that dropping one from all twelve still reds the checker below.
 */
const REQUIRED_OAUTH_CLIENTS_KEYS = [
  // OAuthClientsSection — section header and create-form entry point.
  'title',
  'description',
  'newButton',
  // OAuthClientsSection — manual client form.
  'form.namePlaceholder',
  'form.redirectUrisPlaceholder',
  'form.createButton',
  'form.cancelButton',
  // NewOAuthClientAlert — the one-time plaintext card.
  'newClient.alertTitle',
  'newClient.alertMessage',
  'newClient.copy',
  'newClient.iveSavedIt',
  // OAuthClientsSection — client list, plus CredentialsSettingsTab's disable confirmation.
  'list.empty',
  'list.redirectHost',
  'list.createdVia',
  'list.dcr',
  'list.manual',
  'list.active',
  'list.disabled',
  'list.disableButton',
  'list.disableConfirm',
] as const;

/** The two locale namespaces this criterion guards, each with its own independent key contract. */
const NAMESPACES: readonly { name: 'connectedApps' | 'oauthClients'; requiredKeys: readonly string[] }[] = [
  { name: 'connectedApps', requiredKeys: REQUIRED_CONNECTED_APPS_KEYS },
  { name: 'oauthClients', requiredKeys: REQUIRED_OAUTH_CLIENTS_KEYS },
];

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type Namespace = Record<string, unknown>;
type SettingsBundle = { connectedApps?: Namespace; oauthClients?: Namespace };

/** Reads a dotted path out of a nested namespace, returning undefined on any missing hop. */
function readPath(namespace: Namespace, dottedPath: string): unknown {
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

/** Writes `value` at a dotted path, creating intermediate objects as needed. */
function setPath(root: Namespace, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split('.');
  const leaf = parts.pop() as string;
  let node = root;
  for (const part of parts) {
    const existing = node[part];
    if (!existing || typeof existing !== 'object') node[part] = {};
    node = node[part] as Namespace;
  }
  node[leaf] = value;
}

/**
 * The reasons a locale's namespace fails the contract; an empty array means it passes. Returning
 * the reasons (rather than a boolean) is what lets the positive controls below prove the checker
 * can actually go red, instead of the suite merely asserting a constant green.
 *
 * `namespaceName` is the literal top-level key (`connectedApps` / `oauthClients`) so the checker
 * can reject a value that is the *full* dotted key path, not just the leaf name.
 */
function namespaceProblems(
  namespace: Namespace | undefined,
  requiredKeys: readonly string[],
  namespaceName: string,
): string[] {
  const problems: string[] = [];
  const source = namespace ?? {};
  for (const key of requiredKeys) {
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
    if (value === leafName || value === key || value === `${namespaceName}.${key}`) {
      problems.push(`${key} is the raw key name, not a label`);
    }
  }
  return problems;
}

/** Builds a synthetic namespace whose every key carries a distinct, valid label. */
function completeNamespace(keys: readonly string[]): Namespace {
  const root: Namespace = {};
  for (const key of keys) {
    setPath(root, key, `translated text for ${key}`);
  }
  return root;
}

describe('every locale carries complete connectedApps and oauthClients namespaces', () => {
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

  it('gives every locale every required key in both namespaces, non-empty and not the key name', () => {
    const offenders: string[] = [];
    // Per-locale, per-namespace flat key counts — the reading that proves the namespaces exist.
    const flatKeyCounts: Record<string, Record<string, number>> = {};

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      flatKeyCounts[file] = {};
      for (const { name, requiredKeys } of NAMESPACES) {
        const namespace = bundle[name];
        flatKeyCounts[file][name] = flattenKeys(namespace).length;
        for (const problem of namespaceProblems(namespace, requiredKeys, name)) {
          offenders.push(`${file}: ${name}: ${problem}`);
        }
      }
    }

    console.log(`[AC2] per-locale per-namespace flat key counts: ${JSON.stringify(flatKeyCounts)}`);
    console.log(`[AC2] offenders (${offenders.length}): ${JSON.stringify(offenders)}`);
    expect(offenders).toEqual([]);
  });

  it('gives every locale exactly the same key set as en in each namespace', () => {
    const reference = JSON.parse(
      readFileSync(join(LOCALES_DIR, REFERENCE_LOCALE, 'settings.json'), 'utf8'),
    ) as SettingsBundle;
    const referenceKeys: Record<string, Set<string>> = {};
    for (const { name } of NAMESPACES) {
      referenceKeys[name] = new Set(flattenKeys(reference[name]));
    }

    const diffs: Record<string, Record<string, { missing: string[]; extra: string[] }>> = {};
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      diffs[file] = {};
      for (const { name } of NAMESPACES) {
        const keys = new Set(flattenKeys(bundle[name]));
        diffs[file][name] = {
          missing: [...referenceKeys[name]].filter((key) => !keys.has(key)).sort(),
          extra: [...keys].filter((key) => !referenceKeys[name].has(key)).sort(),
        };
      }
    }

    for (const { name } of NAMESPACES) {
      console.log(
        `[AC3] ${REFERENCE_LOCALE} ${name} keys (${referenceKeys[name].size}): ${JSON.stringify([...referenceKeys[name]].sort())}`,
      );
    }
    console.log(`[AC3] per-locale key-set diffs vs ${REFERENCE_LOCALE}: ${JSON.stringify(diffs)}`);

    for (const file of bundleFiles) {
      for (const { name } of NAMESPACES) {
        expect(diffs[file][name], `${file} ${name} key set vs ${REFERENCE_LOCALE}`).toEqual({
          missing: [],
          extra: [],
        });
      }
    }
  });

  // Positive control: the same checker must reject a bundle that lacks a key (or carries a
  // blank / key-copied value) in either namespace. If it could not, the cases above would be a
  // green that cannot go red — exactly the failure they exist to catch.
  it('rejects a bundle with a missing, blank or key-copied label in either namespace (positive control)', () => {
    // The single key each namespace's one-key-missing and mutation arms act on.
    const spotKeys: Record<string, string> = {
      connectedApps: 'list.revokeButton',
      oauthClients: 'list.disableConfirm',
    };

    for (const { name, requiredKeys } of NAMESPACES) {
      const spot = spotKeys[name];
      const spotLeaf = spot.slice(spot.lastIndexOf('.') + 1);

      // Every required key missing -> one reason per key, in declaration order.
      expect(namespaceProblems({}, requiredKeys, name), `${name}: empty bundle`).toEqual(
        requiredKeys.map((key) => `${key} is missing`),
      );

      // A complete bundle that lacks exactly one key -> only that one reason.
      const missingOne = completeNamespace(requiredKeys.filter((key) => key !== spot));
      expect(namespaceProblems(missingOne, requiredKeys, name), `${name}: single key missing`).toEqual([
        `${spot} is missing`,
      ]);

      // A complete, valid bundle -> no reasons at all.
      expect(namespaceProblems(completeNamespace(requiredKeys), requiredKeys, name), `${name}: complete bundle`).toEqual([]);

      // The blank and key-copied arms of the checker (leaf name and full `<namespace>.` path).
      const blanked = completeNamespace(requiredKeys);
      setPath(blanked, spot, '   ');
      expect(namespaceProblems(blanked, requiredKeys, name), `${name}: blank value`).toEqual([
        `${spot} is an empty string`,
      ]);

      const copiedLeaf = completeNamespace(requiredKeys);
      setPath(copiedLeaf, spot, spotLeaf);
      expect(namespaceProblems(copiedLeaf, requiredKeys, name), `${name}: leaf-name copy`).toEqual([
        `${spot} is the raw key name, not a label`,
      ]);

      const copiedFull = completeNamespace(requiredKeys);
      setPath(copiedFull, spot, `${name}.${spot}`);
      expect(namespaceProblems(copiedFull, requiredKeys, name), `${name}: full-path copy`).toEqual([
        `${spot} is the raw key name, not a label`,
      ]);
    }
  });
});
