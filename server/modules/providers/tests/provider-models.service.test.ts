import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({ model });

/** In-memory stand-in for the `sessions` table rows the service reads and writes. */
const createSessionStore = (
  rows: Record<string, string | null> = {},
  efforts: Record<string, string | null> = {},
  permissionModes: Record<string, string | null> = {},
) => {
  const sessions = new Map(Object.entries(rows).map(([sessionId, model]) => [
    sessionId,
    {
      model,
      effort: efforts[sessionId] ?? null,
      permission_mode: permissionModes[sessionId] ?? null,
    },
  ]));
  return {
    sessions,
    getSessionById: (sessionId: string) =>
      sessions.get(sessionId) ?? null,
    setSessionModel: (sessionId: string, model: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.model = model;
      }
    },
    setSessionEffort: (sessionId: string, effort: string) => {
      const session = sessions.get(sessionId);
      if (session) {
        session.effort = effort;
      }
    },
    setSessionPermissionMode: (sessionId: string, permissionMode: string) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return false;
      }
      session.permission_mode = permissionMode;
      return true;
    },
  };
};

const createCatalogStore = () => {
  const rows = new Map<LLMProvider, CustomProviderModelRecord[]>();
  let nextRecordId = 1;
  const readRows = (provider: LLMProvider) => rows.get(provider) ?? [];

  return {
    rows,
    listCustomProviderModels(provider: LLMProvider) {
      return [...readRows(provider)];
    },
    getCustomProviderModel(provider: LLMProvider, recordId: number) {
      return readRows(provider).find((record) => record.recordId === recordId) ?? null;
    },
    findCustomProviderModelByModelId(provider: LLMProvider, modelId: string) {
      return readRows(provider).find((record) => record.modelId === modelId) ?? null;
    },
    createCustomProviderModel(provider: LLMProvider, input: CustomProviderModelInput) {
      const record: CustomProviderModelRecord = {
        recordId: nextRecordId++,
        provider,
        modelId: input.id,
        model: input.model,
        config: input.config ?? null,
        sortOrder: readRows(provider).length,
      };
      rows.set(provider, [...readRows(provider), record]);
      return record;
    },
    updateCustomProviderModel(
      provider: LLMProvider,
      recordId: number,
      input: CustomProviderModelInput,
    ) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, modelId: input.id, model: input.model };
      rows.set(provider, readRows(provider).map((record) => (
        record.recordId === recordId ? updated : record
      )));
      return updated;
    },
    deleteCustomProviderModel(provider: LLMProvider, recordId: number, _fallbackModelId: string) {
      const existing = readRows(provider).find((record) => record.recordId === recordId);
      if (!existing) {
        return null;
      }
      rows.set(provider, readRows(provider).filter((record) => record.recordId !== recordId));
      return existing;
    },
  };
};

const createTestService = (options: {
  catalog?: ReturnType<typeof createCatalogStore>;
  sessions?: ReturnType<typeof createSessionStore>;
  activeModel?: (provider: LLMProvider, sessionId?: string) => string;
  onCatalogRead?: (provider: LLMProvider) => void;
} = {}) => {
  const catalog = options.catalog ?? createCatalogStore();
  const sessions = options.sessions ?? createSessionStore();
  const service = createProviderModelsService({
    catalog,
    sessions,
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => {
          options.onCatalogRead?.(provider);
          return createModels(`${provider}-default`);
        },
        getCurrentActiveModel: async (sessionId) => createCurrentActiveModel(
          options.activeModel?.(provider, sessionId) ?? `${provider}-default`,
        ),
      },
    }),
  });

  return { service, catalog, sessions };
};

test('provider catalogs merge source-controlled defaults with custom persistence rows', async () => {
  const calls: LLMProvider[] = [];
  const { service, catalog } = createTestService({ onCatalogRead: (provider) => calls.push(provider) });

  const models = await service.getProviderModels('codex');

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.DEFAULT, 'codex-default');
  assert.deepEqual(models.OPTIONS[0], {
    value: 'codex-default',
    label: 'codex-default',
    isCustom: false,
  });
  assert.deepEqual(catalog.rows.get('codex'), undefined);
});

test('custom models can be created, edited, and deleted', async () => {
  const { service } = createTestService();
  const created = await service.createCustomModel('claude', {
    model: 'My Claude',
    id: 'claude-my-model',
  });
  const recordId = created.model.recordId as number;

  assert.equal(created.model.isCustom, true);
  assert.equal(created.models.OPTIONS.at(-1)?.value, 'claude-my-model');

  const updated = await service.updateCustomModel('claude', recordId, {
    model: 'My Better Claude',
    id: 'claude-my-model-v2',
  });
  assert.equal(updated.model.label, 'My Better Claude');
  assert.equal(updated.model.value, 'claude-my-model-v2');

  const removed = await service.deleteCustomModel('claude', recordId);
  assert.equal(removed.model.value, 'claude-my-model-v2');
  assert.equal(removed.models.OPTIONS.some((option) => option.recordId === recordId), false);
});

test('duplicate model ids are rejected within one provider', async () => {
  const { service } = createTestService();
  await service.createCustomModel('cursor', { model: 'First', id: 'custom-id' });

  await assert.rejects(
    () => service.createCustomModel('cursor', { model: 'Second', id: 'custom-id' }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );

  await assert.rejects(
    () => service.createCustomModel('cursor', {
      model: 'Duplicate built-in',
      id: 'cursor-default',
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
});

test('a duplicate keeps the SOURCE secret, even with a sibling holding the same key', async () => {
  const { service } = createTestService();
  const source = await service.createCustomModel('claude', {
    model: 'Source',
    id: 'source-1',
    config: {
      env: [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://source.example' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-source-secret' },
      ],
    },
  });
  // Same secret key, different value: an implementation that resolved the blank
  // row against anything but this source (a lookup by key, a sibling row, the
  // target's own — nonexistent — config) would answer with this one, or 400.
  await service.createCustomModel('claude', {
    model: 'Sibling',
    id: 'sibling-1',
    config: { env: [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-sibling-secret' }] },
  });

  await service.duplicateCustomModel('claude', source.model.recordId as number, {
    model: 'Source copy',
    id: 'source-1-copy',
    // A blank secret row means "keep the stored one" — and the only row that can
    // supply it is the one being copied.
    config: { env: [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret' }] },
  });

  assert.deepEqual(service.getCustomModelConfigForRuntime('claude', 'source-1-copy')?.env, [
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-source-secret' },
  ]);
});

test('a duplicate copies the whole config when the request sends none', async () => {
  const { service } = createTestService();
  const source = await service.createCustomModel('claude', {
    model: 'Source',
    id: 'source-2',
    config: {
      env: [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://source.example' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-source-two' },
        { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
      ],
    },
  });

  const duplicated = await service.duplicateCustomModel('claude', source.model.recordId as number, {
    model: 'Source two',
    id: 'source-2-copy',
  });

  assert.equal(duplicated.model.isCustom, true);
  assert.equal(duplicated.model.value, 'source-2-copy');
  assert.deepEqual(service.getCustomModelConfigForRuntime('claude', 'source-2-copy')?.env, [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://source.example' },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-source-two' },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ]);
  // The new row owns its own values: rewriting the copy must not reach the source.
  const sourceRows = service.getCustomModelConfigForRuntime('claude', 'source-2');
  const copiedRows = service.getCustomModelConfigForRuntime('claude', 'source-2-copy')?.env;
  assert.notStrictEqual(copiedRows, sourceRows?.env);
  assert.notStrictEqual(copiedRows?.[0], sourceRows?.env[0]);
});

test('a duplicate copies only the rows the request sends', async () => {
  const { service } = createTestService();
  const source = await service.createCustomModel('claude', {
    model: 'Source',
    id: 'source-3',
    config: {
      env: [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://source.example' },
        { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'value', value: 'upstream-opus' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-source-three' },
      ],
    },
  });

  await service.duplicateCustomModel('claude', source.model.recordId as number, {
    model: 'Source three',
    id: 'source-3-copy',
    // Only the row the user kept, retargeted; the other two are absent, so they
    // are not copied at all — including the secret.
    config: { env: [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://other.example' }] },
  });

  assert.deepEqual(service.getCustomModelConfigForRuntime('claude', 'source-3-copy')?.env, [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://other.example' },
  ]);
});

test('duplicating an unknown or built-in record reports it as not found', async () => {
  const { service } = createTestService();
  const source = await service.createCustomModel('claude', { model: 'Source', id: 'source-4' });

  // Built-in models live in source control, not in `provider_models`, so they
  // have no row to read a config from and cannot be duplicated.
  const models = await service.getProviderModels('claude');
  const builtIn = models.OPTIONS.find((option) => !option.isCustom);
  assert.ok(builtIn);
  assert.equal(builtIn.recordId, undefined);

  for (const recordId of [9999, 0]) {
    await assert.rejects(
      () => service.duplicateCustomModel('claude', recordId, { model: 'Copy', id: 'copy-1' }),
      (error) => error instanceof AppError
        && error.code === 'MODEL_NOT_FOUND'
        && error.statusCode === 404,
    );
  }

  const catalog = await service.getProviderModels('claude');
  assert.equal(catalog.OPTIONS.some((option) => option.value === 'copy-1'), false);
  assert.equal(catalog.OPTIONS.some((option) => option.recordId === source.model.recordId), true);
});

test('a duplicate onto a taken id is rejected, built-in ids included', async () => {
  const { service } = createTestService();
  await service.createCustomModel('cursor', { model: 'First', id: 'taken-id' });
  const source = await service.createCustomModel('cursor', { model: 'Source', id: 'source-5' });
  const recordId = source.model.recordId as number;

  await assert.rejects(
    () => service.duplicateCustomModel('cursor', recordId, { model: 'Copy', id: 'taken-id' }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
  await assert.rejects(
    () => service.duplicateCustomModel('cursor', recordId, {
      model: 'Copy of a built-in',
      id: 'cursor-default',
    }),
    (error) => error instanceof AppError
      && error.code === 'MODEL_ID_ALREADY_EXISTS'
      && error.statusCode === 409,
  );
  // The source row is untouched by a rejected copy.
  assert.equal(service.getCustomModelConfigForRuntime('cursor', 'source-5'), null);
});

test('predefined models have no database record or mutation target', async () => {
  const { service, catalog } = createTestService();
  const models = await service.getProviderModels('opencode');
  assert.equal(models.OPTIONS[0]?.recordId, undefined);
  assert.equal(models.OPTIONS[0]?.isCustom, false);
  assert.deepEqual(catalog.rows.get('opencode'), undefined);

  await assert.rejects(
    () => service.updateCustomModel('opencode', 999, { model: 'Changed', id: 'changed' }),
    (error) => error instanceof AppError && error.code === 'MODEL_NOT_FOUND',
  );
});

test('resolveSessionModel asks the provider adapter for the requested session', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-123': null }),
    activeModel: (provider, sessionId) => {
      calls.push({ provider, sessionId });
      return `${provider}-${sessionId}`;
    },
  });

  const resolved = await service.resolveSessionModel('opencode', { sessionId: 'session-123' });

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(resolved.model, 'opencode-session-123');
});

test('setSessionModel records the model on the session row', () => {
  const sessions = createSessionStore({ 'session-1': null });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('claude', 'session-1', 'opus');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'session-1',
    model: 'opus',
    effort: null,
    permissionMode: null,
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.model, 'opus');
});

test('setSessionModel ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionModel('claude', 'missing-session', 'opus'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('setSessionEffort records an explicit effort on the session row', () => {
  const sessions = createSessionStore({ 'session-1': 'gpt-5.6-sol' });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionEffort('codex', 'session-1', 'ultra');

  assert.deepEqual(stored, {
    provider: 'codex',
    sessionId: 'session-1',
    effort: 'ultra',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('session-1')?.effort, 'ultra');
});

test('setSessionEffort ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  assert.equal(service.setSessionEffort('codex', 'missing-session', 'high'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('setSessionPermissionMode records a mode the provider supports', () => {
  const sessions = createSessionStore({ 'mode-session-1': null });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionPermissionMode('claude', 'mode-session-1', 'plan');

  assert.deepEqual(stored, {
    provider: 'claude',
    sessionId: 'mode-session-1',
    permissionMode: 'plan',
    source: 'session',
  });
  assert.equal(sessions.sessions.get('mode-session-1')?.permission_mode, 'plan');
});

test('setSessionPermissionMode ignores a mode outside the provider capability matrix', () => {
  const sessions = createSessionStore({ 'mode-session-2': null, 'mode-session-3': null });
  const { service } = createTestService({ sessions });

  // Unknown to every provider, and real but not offered by this one.
  assert.equal(service.setSessionPermissionMode('claude', 'mode-session-2', 'yolo'), null);
  assert.equal(service.setSessionPermissionMode('codex', 'mode-session-3', 'plan'), null);

  assert.equal(sessions.sessions.get('mode-session-2')?.permission_mode, null);
  assert.equal(sessions.sessions.get('mode-session-3')?.permission_mode, null);
});

test('setSessionPermissionMode ignores sessions that have no row yet', () => {
  const sessions = createSessionStore();
  const { service } = createTestService({ sessions });

  // Unreachable from a send: the gateway refuses a frame naming a session
  // whose row is missing, and the id it would name is minted by the call that
  // writes the row. Answered here so the writer has one rule, not two.
  assert.equal(service.setSessionPermissionMode('claude', 'mode-session-4', 'acceptEdits'), null);
  assert.equal(sessions.sessions.size, 0);
});

test('resolveSessionModel surfaces the recorded permission mode, null when unrecorded', async () => {
  const { service } = createTestService({
    sessions: createSessionStore(
      { 'mode-session-6': 'haiku', 'mode-session-7': 'haiku' },
      {},
      { 'mode-session-6': 'bypassPermissions' },
    ),
  });

  const recorded = await service.resolveSessionModel('claude', { sessionId: 'mode-session-6' });
  assert.equal(recorded.permissionMode, 'bypassPermissions');

  const unrecorded = await service.resolveSessionModel('claude', { sessionId: 'mode-session-7' });
  assert.equal(unrecorded.permissionMode, null);
});

test('setSessionModel leaves the recorded permission mode untouched', () => {
  const sessions = createSessionStore({ 'mode-session-8': 'haiku' }, {}, { 'mode-session-8': 'plan' });
  const { service } = createTestService({ sessions });

  const stored = service.setSessionModel('claude', 'mode-session-8', 'opus');

  assert.equal(stored?.permissionMode, 'plan');
  assert.equal(sessions.sessions.get('mode-session-8')?.permission_mode, 'plan');
});

test('resolveSessionModel prefers the recorded session model', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': 'haiku' }, { 'session-1': 'high' }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'sonnet',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.effort, 'high');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel uses provider session state for unrecorded external sessions', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
    activeModel: () => 'provider-reported',
  });

  const resolved = await service.resolveSessionModel('opencode', {
    sessionId: 'session-1',
    requestedModel: 'requested',
  });

  assert.equal(resolved.model, 'provider-reported');
  assert.equal(resolved.source, 'provider');
});

test('resolveSessionModel uses the requested model when provider reports the catalog default', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-1': null }),
  });

  const resolved = await service.resolveSessionModel('claude', {
    sessionId: 'session-1',
    requestedModel: 'haiku',
  });

  assert.equal(resolved.model, 'haiku');
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel returns a requested model before a session exists', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex', { requestedModel: 'gpt-5.5' });

  assert.equal(resolved.model, 'gpt-5.5');
  assert.equal(resolved.sessionId, null);
  assert.equal(resolved.source, 'session');
});

test('resolveSessionModel falls back to the provider adapter default', async () => {
  const { service } = createTestService();

  const resolved = await service.resolveSessionModel('codex');

  assert.equal(resolved.model, 'codex-default');
  assert.equal(resolved.source, 'default');
});

test('resolveResumeModel prefers the recorded session model over the requested one', async () => {
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': 'composer-2' }),
  });

  const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
  assert.equal(model, 'composer-2');
});

test('resolveResumeModel never consults provider-global state', async () => {
  let providerLookups = 0;
  const { service } = createTestService({
    sessions: createSessionStore({ 'session-456': null }),
    activeModel: () => {
      providerLookups += 1;
      return 'global-config-model';
    },
  });

  const model = await service.resolveResumeModel('codex', 'session-456', 'gpt-5.5');

  assert.equal(model, 'gpt-5.5');
  assert.equal(providerLookups, 0);
});
