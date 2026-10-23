import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    accessTokens: {
      list: () => [],
      findById: () => undefined,
      issue: () => ({ ok: false, reason: 'invalid_expiry' }),
      revoke: () => false,
    },
    ...overrides,
  };
}

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('createAccessToken rejects a lifetime outside 7/30/90 without issuing', () => {
  let issued = 0;
  const service = createSettingsService(dependencies({
    accessTokens: {
      list: () => [],
      findById: () => undefined,
      issue: () => { issued += 1; return { ok: false, reason: 'invalid_expiry' }; },
      revoke: () => false,
    },
  }));

  for (const expiresInDays of [0, 1, 6, 10, 365, -1, '30', null]) {
    assert.throws(
      () => service.createAccessToken(1, { name: 'laptop', expiresInDays }),
      (error: { code?: string; statusCode?: number }) =>
        error.code === 'INVALID_EXPIRES_IN' && error.statusCode === 400,
    );
  }
  // A missing lifetime defaults to 30 rather than being rejected.
  assert.throws(
    () => service.createAccessToken(1, { name: 'laptop' }),
    (error: { code?: string }) => error.code === 'ACCESS_TOKEN_ISSUE_FAILED',
  );
  assert.equal(issued, 1);
});

/** A stored personal-access-token row: `kind` 'pat' and a real `name`. */
const PAT_ROW = {
  id: 9,
  user_id: 1,
  kind: 'pat',
  token_hash: 'deadbeef'.repeat(8),
  token_prefix: 'ccp_abc1',
  name: 'laptop',
  scopes: JSON.stringify(['cloudcli:read']),
  expires_at: '2026-02-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used: null,
  revoked_at: null,
};

/** A stored OAuth row exactly as the OAuth store writes it: `name` NULL, kind `oauth_access`. */
const OAUTH_ROW = {
  id: 42,
  user_id: 1,
  kind: 'oauth_access',
  token_hash: 'cafebabe'.repeat(8),
  token_prefix: 'cca_abc1',
  name: null,
  scopes: JSON.stringify(['cloudcli:read']),
  expires_at: '2026-02-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used: null,
  revoked_at: null,
};

test('listAccessTokens asks for PAT rows only and projects them without the token hash', () => {
  const kindsAsked: (string | undefined)[] = [];
  const service = createSettingsService(dependencies({
    accessTokens: {
      // Mirrors the repository's SQL filter: the store only returns rows whose
      // kind matches the argument, so dropping the argument lets the OAuth row
      // through and this test reds.
      list: (_userId, kind) => {
        kindsAsked.push(kind);
        return [PAT_ROW, OAUTH_ROW].filter((row) => kind === undefined || row.kind === kind);
      },
      findById: () => undefined,
      issue: () => ({ ok: false, reason: 'invalid_expiry' }),
      revoke: () => false,
    },
  }));

  const listed = service.listAccessTokens(1);
  assert.deepEqual(kindsAsked, ['pat']);
  assert.equal(listed.tokens.length, 1);
  assert.deepEqual(listed.tokens[0], {
    id: 9,
    tokenPrefix: 'ccp_abc1',
    name: 'laptop',
    scopes: ['cloudcli:read'],
    expiresAt: '2026-02-01T00:00:00.000Z',
    lastUsed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  });
  // The nameless OAuth row is not in this list, so no entry renders as "Unnamed token".
  assert.equal(listed.tokens.some((token) => token.id === OAUTH_ROW.id), false);
  assert.equal(Object.keys(listed.tokens[0]).includes('token_hash'), false);
  assert.equal(JSON.stringify(listed).includes('deadbeef'), false);
});

test('listOAuthTokens projects the non-PAT rows (client name, no token hash)', () => {
  const service = createSettingsService(dependencies({
    oauthTokens: {
      list: () => [{ ...OAUTH_ROW, client_name: 'Preset App' }],
    },
  }));

  const listed = service.listOAuthTokens(1);
  assert.equal(listed.tokens.length, 1);
  assert.deepEqual(listed.tokens[0], {
    id: 42,
    kind: 'oauth_access',
    tokenPrefix: 'cca_abc1',
    clientName: 'Preset App',
    scopes: ['cloudcli:read'],
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    lastUsed: null,
    revokedAt: null,
  });
  assert.equal(Object.keys(listed.tokens[0]).includes('token_hash'), false);
  assert.equal(JSON.stringify(listed).includes('cafebabe'), false);
});
