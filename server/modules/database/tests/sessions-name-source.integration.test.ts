import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';

const PROJECT_PATH = '/workspace/name-source';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-name-source-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** One row's stored name and its provenance, read straight from the table. */
const storedName = (sessionId: string): { name: string | null; source: string | null } => {
  const row = getConnection()
    .prepare('SELECT custom_name AS name, name_source AS source FROM sessions WHERE session_id = ?')
    .get(sessionId) as { name: string | null; source: string | null } | undefined;
  assert.ok(row, `session ${sessionId} must exist`);
  return row;
};

/**
 * Every name column of one row, unprojected.
 *
 * The two halves of the split have to be told apart — which name landed in the
 * override and which in the reading — and the projection a reader sees
 * (`custom_name ?? transcript_name`) deliberately hides exactly that.
 */
const nameColumns = (sessionId: string): {
  custom_name: string | null;
  name_source: string | null;
  transcript_name: string | null;
  transcript_name_source: string | null;
} => {
  const row = getConnection()
    .prepare(
      `SELECT custom_name, name_source, transcript_name, transcript_name_source
         FROM sessions WHERE session_id = ?`
    )
    .get(sessionId) as ReturnType<typeof nameColumns> | undefined;
  assert.ok(row, `session ${sessionId} must exist`);
  return row;
};

/** The name a reader shows for a session: the override if there is one. */
const displayName = (sessionId: string): string | null | undefined =>
  sessionsDb.getSessionById(sessionId)?.custom_name;

/** A session discovered on disk: its provider id is its own id. */
const cliSession = (id: string, name: string | undefined, source?: 'derived' | 'ai' | 'manual' | 'agent') =>
  sessionsDb.createSession(id, 'claude', PROJECT_PATH, name, undefined, undefined, null, source);

/**
 * An app-allocated session that the provider has since claimed, which is the
 * shape `createSession` reads as app-owned (`session_id <> provider_session_id`).
 */
const appSession = (appId: string, nativeId: string, name: string): void => {
  sessionsDb.createAppSession(appId, 'claude', PROJECT_PATH, name);
  sessionsDb.assignProviderSessionId(appId, nativeId);
};

// ---------------------------------------------------------------------------
// Precedence: agent > manual > ai > derived, on both session shapes
// ---------------------------------------------------------------------------

test('a disk-discovered session takes an ai-title over its inferred name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt', 'derived');

    cliSession('cli-1', 'The Generated Title', 'ai');

    assert.deepEqual(storedName('cli-1'), { name: 'The Generated Title', source: 'ai' });
  });
});

test('an app session takes an ai-title over the name derived from its first message', async () => {
  await withIsolatedDatabase(() => {
    appSession('app-1', 'native-1', 'first message');

    // The watcher finds the app session's transcript and re-upserts it under
    // the provider id it now carries.
    sessionsDb.createSession('native-1', 'claude', PROJECT_PATH, 'The Generated Title', undefined, undefined, null, 'ai');

    assert.deepEqual(storedName('app-1'), { name: 'The Generated Title', source: 'ai' });
  });
});

test('an inferred name never replaces an ai or a manual one', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-ai', 'The Generated Title', 'ai');
    cliSession('cli-manual', 'Chosen By Hand', 'manual');

    // A later scan that only knows the first message must not undo either.
    cliSession('cli-ai', 'first prompt', 'derived');
    cliSession('cli-manual', 'first prompt', 'derived');

    assert.deepEqual(storedName('cli-ai'), { name: 'The Generated Title', source: 'ai' });
    assert.deepEqual(storedName('cli-manual'), { name: 'Chosen By Hand', source: 'manual' });
  });
});

test('an ai-title never replaces a manual name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'Chosen By Hand', 'manual');

    cliSession('cli-1', 'The Generated Title', 'ai');

    assert.deepEqual(storedName('cli-1'), { name: 'Chosen By Hand', source: 'manual' });
  });
});

test('a later manual name replaces an earlier one', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'First Rename', 'manual');

    cliSession('cli-1', 'Second Rename', 'manual');

    assert.deepEqual(storedName('cli-1'), { name: 'Second Rename', source: 'manual' });
  });
});

test('createSession without a name source records the name as derived', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt');

    assert.deepEqual(storedName('cli-1'), { name: 'first prompt', source: 'derived' });
  });
});

test('updateSessionCustomName records a manual name', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt', 'derived');

    sessionsDb.updateSessionCustomName('cli-1', 'Renamed In The Sidebar');

    assert.deepEqual(storedName('cli-1'), { name: 'Renamed In The Sidebar', source: 'manual' });
  });
});

test('an agent name outranks the name the user chose', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'Chosen By Hand', 'manual');

    // The top rung of the CLI's ladder. A session the agent owns is named after
    // the agent however the row was named before, so the rank order has to read
    // `agent` above `manual` and not only above `ai`.
    cliSession('cli-1', 'The Agent That Owns This', 'agent');

    assert.deepEqual(storedName('cli-1'), { name: 'The Agent That Owns This', source: 'agent' });

    // And it holds in the other direction: a name that ranks below cannot take
    // the row back, or the rung would only be a tie-break.
    cliSession('cli-1', 'Renamed By Hand', 'manual');
    assert.deepEqual(storedName('cli-1'), { name: 'The Agent That Owns This', source: 'agent' });
  });
});

test('a manual name outranks an agent name on the row it is already on', async () => {
  await withIsolatedDatabase(() => {
    // The writer that records what the user typed in the App is not the upsert
    // above: it lands in the override column directly, which no rescan can
    // reach. The rank matrix governs competing claims, not the override.
    cliSession('cli-1', 'The Agent That Owns This', 'agent');

    sessionsDb.updateSessionCustomName('cli-1', 'Renamed In The Sidebar');

    assert.deepEqual(storedName('cli-1'), { name: 'Renamed In The Sidebar', source: 'manual' });
    assert.equal(nameColumns('cli-1').transcript_name, null);
  });
});

// ---------------------------------------------------------------------------
// Migration: a database from before `name_source` existed
// ---------------------------------------------------------------------------

test('opening a database without the name_source column adds it and classifies the names it finds', async () => {
  await withIsolatedDatabase(async () => {
    cliSession('named-by-user', 'A Name On An Old Row');
    cliSession('named-derived', 'Another Old Name');
    cliSession('never-named', undefined);
    sessionsDb.updateSessionCustomName('named-by-user', 'A Name On An Old Row');

    // The shape the previous release left behind: the same table, that column
    // absent, and therefore no record of where any name came from.
    closeConnection();
    await initializeDatabase();
    getConnection().exec('ALTER TABLE sessions DROP COLUMN name_source');
    assert.ok(
      !(getConnection().prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
        .map((column) => column.name)
        .includes('name_source'),
      'the fixture must really be missing the column'
    );

    // The app starts again against that file; migrations run on open.
    closeConnection();
    await initializeDatabase();

    // A name that was already on the row can only have come from the user —
    // an inferred one would have been recomputed by the scan that follows.
    assert.deepEqual(storedName('named-by-user'), {
      name: 'A Name On An Old Row',
      source: 'manual',
    });
    assert.deepEqual(storedName('named-derived'), {
      name: 'Another Old Name',
      source: 'manual',
    });
    assert.deepEqual(storedName('never-named'), { name: null, source: 'derived' });

    // Reopening is a no-op, not a second backfill: a row that has since been
    // upgraded to an ai-title keeps it.
    getConnection()
      .prepare("UPDATE sessions SET name_source = 'ai' WHERE session_id = ?")
      .run('named-derived');

    closeConnection();
    await initializeDatabase();

    assert.deepEqual(storedName('named-derived'), {
      name: 'Another Old Name',
      source: 'ai',
    });
    assert.deepEqual(storedName('named-by-user'), {
      name: 'A Name On An Old Row',
      source: 'manual',
    });
    assert.deepEqual(storedName('never-named'), { name: null, source: 'derived' });
  });
});

// ---------------------------------------------------------------------------
// Migration: a database from before the name was split in two
// ---------------------------------------------------------------------------

/**
 * Drops the two columns this task added, leaving a table in the shape the
 * previous release wrote: one name column holding whichever name won, and
 * `name_source` recording where it came from.
 */
const revertToSingleNameColumn = (): void => {
  const connection = getConnection();
  connection.exec('ALTER TABLE sessions DROP COLUMN transcript_name');
  connection.exec('ALTER TABLE sessions DROP COLUMN transcript_name_source');
  assert.ok(
    !(connection.prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
      .map((column) => column.name)
      .includes('transcript_name'),
    'the fixture must really be missing the column'
  );
};

test('splitting the name columns moves every reading and leaves a manual override where it is', async () => {
  await withIsolatedDatabase(async () => {
    // Four rows of the old shape, one per provenance the old column could hold.
    cliSession('named-by-user', 'A Name The User Chose', 'manual');
    cliSession('named-by-ai', 'The Generated Title', 'ai');
    cliSession('named-derived', 'first prompt', 'derived');
    cliSession('never-named', undefined);
    assert.equal(nameColumns('named-by-ai').transcript_name, null, 'the fixture must start unsplit');

    closeConnection();
    await initializeDatabase();
    revertToSingleNameColumn();

    // The app starts against that file, so the split runs on open.
    closeConnection();
    await initializeDatabase();

    // The user's own name is an override and stays an override — not copied
    // into the reading, where the next sync would be free to overwrite it.
    assert.deepEqual(nameColumns('named-by-user'), {
      custom_name: 'A Name The User Chose',
      name_source: 'manual',
      transcript_name: null,
      transcript_name_source: null,
    });

    // Every other name was the app's reading of a transcript, so it moves to
    // the read column with its provenance, and the override column is emptied.
    assert.deepEqual(nameColumns('named-by-ai'), {
      custom_name: null,
      name_source: null,
      transcript_name: 'The Generated Title',
      transcript_name_source: 'ai',
    });
    assert.deepEqual(nameColumns('named-derived'), {
      custom_name: null,
      name_source: null,
      transcript_name: 'first prompt',
      transcript_name_source: 'derived',
    });
    // A row that never had a name of its own is left exactly as it was, down to
    // the default provenance its creator wrote: the split has nothing to move,
    // and it must not invent a name or a source for it.
    assert.deepEqual(nameColumns('never-named'), {
      custom_name: null,
      name_source: 'derived',
      transcript_name: null,
      transcript_name_source: null,
    });

    // What a reader shows is unchanged by the move: the name that was on the
    // row is still the name, and a row with no name still has none.
    assert.equal(displayName('named-by-ai'), 'The Generated Title');
    assert.equal(displayName('never-named'), null);

    // Between the two runs the synchronizer re-reads a transcript and upgrades
    // the row's reading to the agent that owns it. The second startup must
    // leave that alone: the split is tied to the missing column, so a database
    // that already has it is not a database to split again.
    getConnection()
      .prepare(
        `UPDATE sessions SET transcript_name = 'The Agent That Owns This',
                             transcript_name_source = 'agent'
           WHERE session_id = ?`
      )
      .run('named-by-ai');

    closeConnection();
    await initializeDatabase();

    assert.deepEqual(nameColumns('named-by-ai'), {
      custom_name: null,
      name_source: null,
      transcript_name: 'The Agent That Owns This',
      transcript_name_source: 'agent',
    });
    // And nothing else moved either: the override is still in place, and the
    // rows the first run emptied are not re-emptied or re-filled.
    assert.deepEqual(nameColumns('named-by-user'), {
      custom_name: 'A Name The User Chose',
      name_source: 'manual',
      transcript_name: null,
      transcript_name_source: null,
    });
    assert.deepEqual(nameColumns('named-derived'), {
      custom_name: null,
      name_source: null,
      transcript_name: 'first prompt',
      transcript_name_source: 'derived',
    });
  });
});

test('a reading written after the split is not treated as a user override', async () => {
  await withIsolatedDatabase(() => {
    cliSession('cli-1', 'first prompt', 'derived');

    // What every sync does: a name the transcript gives the session goes to the
    // read column, unconditionally — it is a reading, not a claim to be ranked
    // against whatever is already there.
    sessionsDb.writeTranscriptName('cli-1', 'The Generated Title', 'ai');

    assert.deepEqual(nameColumns('cli-1'), {
      custom_name: null,
      name_source: null,
      transcript_name: 'The Generated Title',
      transcript_name_source: 'ai',
    });

    // A name the user then chooses lands in the override and wins the display,
    // and a later reading of the same transcript cannot take it back.
    sessionsDb.updateSessionCustomName('cli-1', 'Chosen By Hand');
    sessionsDb.writeTranscriptName('cli-1', 'A Revised Title', 'ai');

    assert.equal(displayName('cli-1'), 'Chosen By Hand');
    assert.deepEqual(nameColumns('cli-1'), {
      custom_name: 'Chosen By Hand',
      name_source: 'manual',
      transcript_name: 'A Revised Title',
      transcript_name_source: 'ai',
    });
  });
});
