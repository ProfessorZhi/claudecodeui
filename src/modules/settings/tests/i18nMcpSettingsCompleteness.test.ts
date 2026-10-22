import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The Settings → API tab renders the CloudCLI MCP block through `McpGatewaySection.tsx`
 * (`useTranslation('settings')`) and the personal-access-token scope checkboxes through
 * `AccessTokensSection.tsx`. Every locale `settings.json` bundle therefore has to carry the
 * whole MCP block and the scope vocabulary: react-i18next renders a missing key verbatim,
 * which is how a half-translated bundle ships the literal text `mcpGateway.connectLabel` (or
 * `accessTokens.scopes.sessionControl`) to the user — the failure this test exists to prevent.
 *
 * AC-254 (the sibling that owns the UI) landed the MCP block in the `mcpGateway` namespace and
 * the five scope labels in `accessTokens.scopes.*` rather than merging them into the pre-existing
 * `mcp` namespace (which already carries the MCP *Servers* management UI, 13 keys). This test
 * therefore covers the landed locations — `mcpGateway` plus `accessTokens.scopes` — and does not
 * touch the unrelated `mcp` servers namespace. The AC text's "`mcp` namespace" refers to this
 * landed split; see the task's `## 完成记录` for the verbatim reconciliation.
 *
 * The required-key list below is the *live* contract: exactly the keys `McpGatewaySection.tsx`
 * and the scope checkboxes in `AccessTokensSection.tsx` read (grep for `mcpGateway.` and
 * `accessTokens.scopes.` under `src/modules/settings/tabs/api-settings/`). It is kept as an
 * independent literal rather than derived from `en`, so a locale that quietly drops one keys
 * reds even when `en` agrees with it. The scope descriptions live inside the scope labels
 * themselves (e.g. `Read (cloudcli:read)`), so "五个 scope 的名称与说明" maps to the five
 * `accessTokens.scopes.*` leaves — the landed contract, not a separate description key.
 *
 * It walks the whole `locales/*\/settings.json` glob rather than a hardcoded language list, so
 * a locale added (or dropped) without a matching key cannot pass by silently going stale, and
 * it does not settle for checking `en` alone. Resolved from the vitest process cwd (the repo
 * root), the way the other filesystem-reading tests in this repo do it: under vitest's jsdom
 * environment `import.meta.url` is not a file: URL, so `fileURLToPath` rejects it.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** The bundle every other locale's managed key set is compared against. */
const REFERENCE_LOCALE = 'en';

/**
 * The namespaces this criterion owns. `mcpGateway` is the CloudCLI MCP block; `accessTokens.scopes`
 * is the token-scope vocabulary the scope checkboxes render; `mcpNavigation` is the per-device
 * navigation-policy / device-name section added beside the gateway block. Read (b) compares each
 * locale's flattened key set across exactly these subtrees against `en`.
 */
const OWNED_NAMESPACES = ['mcpGateway', 'accessTokens.scopes', 'mcpNavigation'] as const;

/**
 * Every MCP-block / scope key the settings UI actually renders, dotted from the bundle root.
 * Fixed independently of the locale files so that dropping one from all twelve still reds the
 * checker below. Spans both landed namespaces, so (a) validates values that AC-229's older
 * `accessTokens` list predates (the scope leaves were added by AC-254).
 */
const REQUIRED_MCP_KEYS = [
  // McpGatewaySection — the CloudCLI MCP block (namespace `mcpGateway`).
  'mcpGateway.title', // 区块标题
  'mcpGateway.description', // 端点 / 区块说明
  'mcpGateway.status.enabled', // 已启用
  'mcpGateway.status.disabled', // 未启用
  'mcpGateway.connectLabel', // 接入命令说明
  'mcpGateway.enableHint', // 未启用时的提示
  'mcpGateway.copy', // 端点复制
  'mcpGateway.copied', // 复制成功
  // AccessTokensSection — the five scope checkboxes and the write-scope warning.
  'accessTokens.form.scopesLabel', // scope 勾选框组标题
  'accessTokens.scopes.read', // 五个 scope 的名称与说明
  'accessTokens.scopes.sessionSend',
  'accessTokens.scopes.sessionCreate',
  'accessTokens.scopes.sessionControl',
  'accessTokens.scopes.approve',
  'accessTokens.scopes.navigate', // gap-mcp-ui-open-session 新增的 navigate scope
  'accessTokens.form.writeScopeRisk', // 写权限风险提示
  // McpNavigationSection — the per-device navigation-policy / device-name block (namespace
  // `mcpNavigation`). Both strings the section renders in every state, the three policy labels
  // of its radio group, and the name field's label and help text.
  'mcpNavigation.title', // 区块标题
  'mcpNavigation.description', // 区块说明
  'mcpNavigation.deviceOnly', // 「仅对本设备生效」声明
  'mcpNavigation.policy.label', // 三态选择组标题
  'mcpNavigation.policy.accept', // 接受
  'mcpNavigation.policy.ask', // 询问（默认）
  'mcpNavigation.policy.reject', // 拒绝
  'mcpNavigation.deviceName.label', // 设备名标签
  'mcpNavigation.deviceName.description', // 设备名说明
] as const;

/** The shape this test reads back out of a locale bundle — deliberately loose. */
type SettingsBundle = Record<string, unknown>;
type Namespace = Record<string, unknown>;

/** Reads a dotted path out of a nested bundle, returning undefined on any missing hop. */
function readPath(bundle: SettingsBundle, dottedPath: string): unknown {
  let node: unknown = bundle;
  for (const part of dottedPath.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every leaf key of a value, dotted and prefixed. A non-object (string, number, ...) is a leaf. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return prefix.length > 0 ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix.length > 0 ? `${prefix}.${key}` : key),
  );
}

/** The sorted, dotted key set of every namespace this criterion owns, read from one bundle. */
function ownedKeySet(bundle: SettingsBundle): string[] {
  const keys: string[] = [];
  for (const namespace of OWNED_NAMESPACES) {
    keys.push(...flattenKeys(readPath(bundle, namespace), namespace));
  }
  return keys.sort();
}

/**
 * The reasons a locale's MCP-block / scope keys fail the contract; an empty array means it
 * passes. Returning the reasons (rather than a boolean) is what lets the positive controls below
 * prove the checker can actually go red, instead of the suite merely asserting a constant green.
 */
function mcpProblems(bundle: SettingsBundle): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_MCP_KEYS) {
    const value = readPath(bundle, key);
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
    if (value === leafName || value === key) {
      problems.push(`${key} is the raw key name, not a label`);
    }
  }
  return problems;
}

/** Builds a synthetic bundle whose every required key carries a distinct, valid label. */
function completeBundle(keys: readonly string[] = REQUIRED_MCP_KEYS): SettingsBundle {
  const root: SettingsBundle = {};
  for (const key of keys) {
    const parts = key.split('.');
    const leaf = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      const existing = node[part];
      if (!existing || typeof existing !== 'object') node[part] = {};
      node = node[part] as Namespace;
    }
    node[leaf] = `translated text for ${key}`;
  }
  return root;
}

describe('every locale carries a complete CloudCLI MCP block and token-scope vocabulary', () => {
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

  it('gives every locale every required MCP / scope key, non-empty and not the key name', () => {
    const offenders: string[] = [];
    const flatKeyCounts: Record<string, number> = {};

    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      flatKeyCounts[file] = ownedKeySet(bundle).length;
      for (const problem of mcpProblems(bundle)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    console.log(`[AC2] per-locale MCP+scope flat key counts: ${JSON.stringify(flatKeyCounts)}`);
    console.log(`[AC2] offenders (${offenders.length}): ${JSON.stringify(offenders)}`);
    expect(offenders).toEqual([]);
  });

  it('gives every locale exactly the same MCP / scope key set as en', () => {
    const reference = JSON.parse(
      readFileSync(join(LOCALES_DIR, REFERENCE_LOCALE, 'settings.json'), 'utf8'),
    ) as SettingsBundle;
    const referenceKeys = new Set(ownedKeySet(reference));

    const diffs: Record<string, { missing: string[]; extra: string[] }> = {};
    for (const file of bundleFiles) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as SettingsBundle;
      const keys = new Set(ownedKeySet(bundle));
      diffs[file] = {
        missing: [...referenceKeys].filter((key) => !keys.has(key)).sort(),
        extra: [...keys].filter((key) => !referenceKeys.has(key)).sort(),
      };
    }

    console.log(
      `[AC3] ${REFERENCE_LOCALE} MCP+scope keys (${referenceKeys.size}): ${JSON.stringify([...referenceKeys].sort())}`,
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
    expect(mcpProblems({})).toEqual(REQUIRED_MCP_KEYS.map((key) => `${key} is missing`));

    // A complete bundle that lacks exactly one key -> only that one reason.
    const missingOne = REQUIRED_MCP_KEYS.filter((key) => key !== 'mcpGateway.connectLabel');
    expect(mcpProblems(completeBundle(missingOne))).toEqual(['mcpGateway.connectLabel is missing']);

    // A complete, valid bundle -> no reasons at all.
    expect(mcpProblems(completeBundle())).toEqual([]);

    // The blank and key-copied arms of the checker (leaf name and full dotted path).
    const blanked = completeBundle();
    ((blanked.accessTokens as Namespace).form as Namespace).scopesLabel = '   ';
    expect(mcpProblems(blanked)).toEqual(['accessTokens.form.scopesLabel is an empty string']);

    const copiedLeaf = completeBundle();
    ((copiedLeaf.mcpGateway as Namespace).status as Namespace).enabled = 'enabled';
    expect(mcpProblems(copiedLeaf)).toEqual([
      'mcpGateway.status.enabled is the raw key name, not a label',
    ]);

    const copiedFull = completeBundle();
    (copiedFull.accessTokens as Namespace).scopes = {
      ...((copiedFull.accessTokens as Namespace).scopes as Namespace),
      sessionControl: 'accessTokens.scopes.sessionControl',
    };
    expect(mcpProblems(copiedFull)).toEqual([
      'accessTokens.scopes.sessionControl is the raw key name, not a label',
    ]);
  });
});
