// AC-028 criterion file — the goal record `goals/AC-028-model-env-row-is-the-single-source-of-the-context-window.md`
// runs exactly this path as its criterion command, so this file IS the acceptance surface of AC-028 and
// must stay reachable under the path the record names.
// Load-bearing subject: `resolveModelContextWindowRow` decides the context window for a model entry, and
// that one value feeds the spawn env (`mapCliOptionsToSDK(...).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`) and all
// three total paths (the SDK `extractTokenBudget` / `extractCumulativeTokenBudget` and the token-usage
// service summary) — the single-source-of-truth contract AC-028 asserts.
// Provenance: this file was relocated by 1d76cac6 (the commit that moved the shared launch-spec compile
// layer and its tests into server/modules/providers/); `git log --follow` recovers the earlier path.
// A future relocation that moves the subject again is allowed, but it must carry this header and re-point
// the AC-028 criterion; deleting this file, or dropping or loosening any assertion below, is not.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, providerModelsDb } from '@/modules/database/index.js';
import {
  createProviderTokenUsageService,
  extractCumulativeTokenBudget,
  extractTokenBudget,
  mapCliOptionsToSDK,
  resolveModelContextWindowRow,
} from '@/modules/providers/index.js';

const assistant = { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } };
const result = { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } };
const entryLine = JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } });

type Env = Record<string, string | undefined>;

// The three total paths as production wires them: the runtime hands the model row to the extractors and the
// token-usage service reads the row for the session's model through the same compile as the spawn env.
async function totalsFor(model: string, dir: string): Promise<{ spawn: string | undefined; totals: number[] }> {
  const row = resolveModelContextWindowRow('claude', model);
  const file = path.join(dir, `${model}.jsonl`);
  await writeFile(file, `${entryLine}\n`);
  const service = createProviderTokenUsageService({
    getSessionById: () => ({ session_id: 's', provider: 'claude', provider_session_id: 'p', jsonl_path: file, model }) as never,
  });
  return {
    spawn: (mapCliOptionsToSDK({ model }).env as Env).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    totals: [
      extractTokenBudget(assistant, row)?.total,
      extractCumulativeTokenBudget(result, row)?.total,
      (await service.getSessionTokenUsage('s')).total,
    ] as number[],
  };
}

async function withFixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-context-window-'));
  const previousDb = process.env.DATABASE_PATH;
  const previousWindow = process.env.CONTEXT_WINDOW;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    for (const [id, value] of [['big', '917000'], ['zero', '0'], ['neg', '-5'], ['abc', 'abc']]) {
      providerModelsDb.createCustomProviderModel('claude', {
        id, model: id, config: { env: [{ key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', kind: 'value', value }] },
      });
    }
    providerModelsDb.createCustomProviderModel('claude', {
      id: 'norow', model: 'norow', config: { env: [{ key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://x.example' }] },
    });
    await run(dir);
  } finally {
    if (previousWindow === undefined) delete process.env.CONTEXT_WINDOW; else process.env.CONTEXT_WINDOW = previousWindow;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    await rm(dir, { recursive: true, force: true });
  }
}

test('model row 917000 is the spawn value and every total path, despite a different host CONTEXT_WINDOW', async () => {
  await withFixture(async (dir) => {
    process.env.CONTEXT_WINDOW = '99999';
    const { spawn, totals } = await totalsFor('big', dir);
    assert.equal(spawn, '917000');
    assert.deepEqual(totals, [917000, 917000, 917000]);
  });
});

test('resolution order: row -> host CONTEXT_WINDOW -> 160000; invalid rows fall through', async () => {
  await withFixture(async (dir) => {
    process.env.CONTEXT_WINDOW = '54321';
    assert.deepEqual((await totalsFor('norow', dir)).totals, [54321, 54321, 54321]);
    for (const invalid of ['zero', 'neg', 'abc']) {
      assert.deepEqual((await totalsFor(invalid, dir)).totals, [54321, 54321, 54321], invalid);
    }
    delete process.env.CONTEXT_WINDOW;
    assert.deepEqual((await totalsFor('norow', dir)).totals, [160000, 160000, 160000]);
    assert.deepEqual((await totalsFor('zero', dir)).totals, [160000, 160000, 160000]);
    // Built-in (unknown to the library) behaves as before.
    assert.deepEqual((await totalsFor('opus', dir)).totals, [160000, 160000, 160000]);
    process.env.CONTEXT_WINDOW = '54321';
    assert.deepEqual((await totalsFor('opus', dir)).totals, [54321, 54321, 54321]);
  });
});

test('fake-detection: sources that ignore the model row (profile field / host env only) are red', async () => {
  await withFixture(async (dir) => {
    process.env.CONTEXT_WINDOW = '99999';
    const { totals } = await totalsFor('big', dir);
    const profileOnly = (profile?: { contextWindow?: number }) => profile?.contextWindow ?? 160000;
    const hostOnly = () => Number.parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
    assert.equal(totals[0], 917000);
    assert.notEqual(profileOnly(undefined), totals[0]);
    assert.notEqual(hostOnly(), totals[0]);
  });
});
