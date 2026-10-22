/**
 * The MCP gateway's `session_search` handler (gap-mcp-session-search).
 *
 * The tool answers "which sessions mention this, and where" across EVERY
 * project, so a caller can find a past conversation by a phrase it remembers
 * without knowing which project or session it lived in. A hit carries the ids a
 * follow-up read needs — `sessionId` for `session_read` / `session_get`, and a
 * per-message `messageId` for `session_read({ mode: 'around' })` — so search and
 * read compose into one workflow instead of two disconnected listings.
 *
 * ## Full text, not meaning
 *
 * The scan behind this tool is the providers module's conversation search: a
 * fixed-string, case-insensitive, literal scan of the stored provider
 * transcripts (and of session titles). It is NOT semantic: a query is matched
 * against the text a session actually contains, so a synonym the transcript
 * never used does not match, and a phrase split across two messages does not
 * match either. The tool's description says so in the words a caller reads, and
 * tells them that several keyword sets are usually better than one — that is the
 * honest way to widen a literal search.
 *
 * ## What the reading is made of
 *
 * The engine streams its answer in two channels and this module merges them by
 * `sessionId`:
 *
 *  - `onTitleResults` carries the title search — the session's own title, its
 *    project and when it was last active. This is where `sessionTitle` and
 *    `lastActivity` come from, and it is the ONLY source of a title: the match
 *    channel never carries one.
 *  - `onProgress` carries one project bucket at a time with the sessions whose
 *    transcripts matched. This is where `matches[]` comes from.
 *
 * The engine returns `void`, so both channels are collected as they arrive
 * rather than read off a return value.
 *
 * ## Pagination, declared honestly
 *
 * `limit` bounds how many SESSIONS one page returns (not how many matches), and
 * `cursor` is the base64 of "how many sessions to skip". The cursor is therefore
 * SERVER-SIDE-LESS and NOT stable: a re-call re-runs the scan and slices the
 * fresh ordering, so a session that gains or loses a match between two calls can
 * shift the window. The tool's description says this in words; it is a
 * deliberate trade — a stable cursor would need a snapshot the search does not
 * keep — and `moreAvailable` is present so a caller can page without reading the
 * cursor's absence as "the end".
 *
 * ## What `score` is (and is not)
 *
 * `score` is a DETERMINISTIC sort key, not a relevance probability: the number
 * of matches in the session, plus a bonus for hits that contain the whole query
 * as one phrase, plus a small recency tier. It exists to put the session a
 * caller probably means first; nothing about it is learned, calibrated or
 * comparable across queries. The module documents it here so the output docs can
 * say the same thing.
 *
 * Everything the tool reads is injected ({@link McpSessionSearchDeps}), so the
 * gateway owns no database handle and the criterion drives the real engine over
 * its own fixture. The deps are OPTIONAL on {@link McpReadToolDeps}: a mount that
 * predates this task keeps the named `MCP_TOOL_NOT_IMPLEMENTED` refusal, exactly
 * like the overview / run_get placeholders before their tasks landed.
 */

import { z } from 'zod';

import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import {
  MCP_SESSION_SEARCH_DEFAULT_LIMIT,
  readTimeField,
} from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam, McpTime } from './mcp-gateway.read-tools.js';

// --------------------------- engine-facing vocabulary ---------------------------

/**
 * The slice of one title-search row this tool reads (structurally satisfied by
 * the engine's `SessionTitleSearchResult`). Only the fields the reading carries
 * are named, so the engine can grow without this module restating it.
 */
type McpSessionSearchTitleRow = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

/** The slice of one engine match this tool reads (structurally satisfied by `SessionConversationMatch`). */
type McpSessionSearchEngineMatch = {
  role: string;
  snippet: string;
  highlights: ReadonlyArray<{ start: number; end: number }>;
  timestamp: string | null;
  /** The provider's own per-row id; the engine sets it for Claude rows and leaves it absent otherwise. */
  messageUuid?: string | null;
};

/** The slice of one matched session this tool reads (structurally satisfied by `SessionConversationResult`). */
type McpSessionSearchEngineSession = {
  sessionId: string;
  provider: string;
  matches: ReadonlyArray<McpSessionSearchEngineMatch>;
};

/** The slice of one project bucket this tool reads (structurally satisfied by `ProjectConversationResult`). */
type McpSessionSearchEngineProject = {
  projectId: string | null;
  projectDisplayName: string;
  sessions: ReadonlyArray<McpSessionSearchEngineSession>;
};

/** The slice of one progress update this tool reads (structurally satisfied by `SessionConversationSearchProgressUpdate`). */
type McpSessionSearchProgressUpdate = {
  projectResult: McpSessionSearchEngineProject | null;
};

/** The engine call this tool makes (structurally satisfied by `SearchSessionConversationsInput`). */
type McpSessionSearchEngineInput = {
  query: string;
  limit: number;
  onProgress?: (update: McpSessionSearchProgressUpdate) => void;
  onTitleResults?: (results: ReadonlyArray<McpSessionSearchTitleRow>) => void;
  signal?: AbortSignal;
};

/**
 * The services `session_search` answers from, all injected.
 *
 * `search` is the providers module's conversation-search engine — the SAME
 * function the session-search route calls, so an MCP caller and the browser read
 * one scanner over one transcript store. In production `server/index.ts` binds
 * it to `sessionConversationsSearchService.search`, imported through the
 * providers barrel; this module never reaches that service by path, so the
 * gateway's dependency stays an injected verb. `now` is the clock the recency
 * half of {@link sessionMatchScore} is computed against, injected so a criterion
 * can pin an ordering instead of inferring one.
 */
export type McpSessionSearchDeps = {
  /** Runs one conversation search, streaming its two channels to the callbacks the caller supplies. */
  search(input: McpSessionSearchEngineInput): Promise<void>;
  /** Clock seam, so the recency tier of the sort key is reproducible. */
  now: () => number;
};

/** Whether the injected deps carry the search engine, i.e. this tool is wired. */
export function isSessionSearchWired(
  deps: McpReadToolDeps,
): deps is McpReadToolDeps & { sessionSearch: McpSessionSearchDeps } {
  return deps.sessionSearch !== undefined;
}

// --------------------------- weights ---------------------------

/**
 * The ceiling handed to the ENGINE, which caps its own scan at 200 matches.
 * Asking for the cap means the page this tool slices is drawn from everything
 * the engine can find in one pass, so `moreAvailable` reflects the engine's
 * ceiling only — and that limit is stated in the tool's description.
 */
const ENGINE_MATCH_LIMIT = 200;

/** Sort-key weight of one match in a session. */
const SCORE_PER_MATCH = 1;
/** Sort-key bonus added once when a match snippet contains the whole query verbatim (case-insensitive). */
const SCORE_EXACT_PHRASE = 2;
/** Recency tiers: a session active within this window scores highest, then the next, then the last. */
const RECENCY_DAY_MS = 24 * 60 * 60 * 1000;

// --------------------------- input ---------------------------

/** The `session_search` tool's typed input. */
export type McpSessionSearchInput = {
  query: string;
  /** A project ID today; a name fragment is auto-upgradeable here without a schema change. */
  project?: string;
  provider?: 'claude' | 'codex';
  speaker?: 'user' | 'assistant' | 'any';
  /** How many SESSIONS to return, 1..{@link MCP_SESSION_SEARCH_MAX_LIMIT}. */
  limit?: number;
  /** Opaque continuation token from a previous call (see the module doc: not stable). */
  cursor?: string;
  /** Reserved. The only accepted value today is `'fulltext'`. */
  mode?: 'fulltext';
};

/**
 * Reads and validates `session_search`'s arguments.
 *
 * The transport has already validated the declared shape, so this reads the
 * typed values off it; the `query` check is repeated because {@link
 * buildSessionSearch} is also reachable directly from a criterion, and a blank
 * query is a caller mistake rather than an empty result.
 */
function readSessionSearchInput(args: Record<string, unknown>): McpSessionSearchInput {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, '"query" is required and must be a non-empty string.');
  }
  return {
    query,
    project: typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined,
    provider: args.provider === 'claude' || args.provider === 'codex' ? args.provider : undefined,
    speaker:
      args.speaker === 'user' || args.speaker === 'assistant' || args.speaker === 'any' ? args.speaker : undefined,
    limit: typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined,
    cursor: typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined,
    mode: args.mode === 'fulltext' ? 'fulltext' : undefined,
  };
}

// --------------------------- payload ---------------------------

/** One matching message inside a matched session. */
export type McpSessionSearchMatchReading = {
  /**
   * The provider's own per-row id for this message, or `null` when the provider
   * does not hand one out (Codex rows). A non-null value is exactly what
   * `session_read({ mode: 'around', aroundId })` accepts, so a caller can expand
   * the hit into its surrounding window.
   */
  messageId: string | null;
  role: string;
  timestamp: McpTime | null;
  /** The matched text, with the provider's own ANSI/control sequences stripped. */
  snippet: string;
  /** Where the query's words sit inside the snippet, as `[start, end)` character offsets. */
  highlights: Array<{ start: number; end: number }>;
};

/** One matched session, with the matches found inside it. */
export type McpSessionSearchHit = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: McpTime | null;
  /** The deterministic sort key (see the module doc); higher sorts first. */
  score: number;
  matches: McpSessionSearchMatchReading[];
};

/** The `session_search` tool's success result. */
export type McpSessionSearchPayload = {
  query: string;
  /** Total matches across every session the FILTERS kept, before the page was cut. */
  totalMatches: number;
  /** Whether sessions remain past this page; the presence of `cursor` says the same thing. */
  moreAvailable: boolean;
  results: McpSessionSearchHit[];
  /** Present only when more sessions remain (see the module doc: not stable). */
  cursor?: string;
};

// --------------------------- scoring ---------------------------

/**
 * The deterministic sort key for one matched session.
 *
 * Three readable ingredients, no learned model: one point per match, a bonus of
 * {@link SCORE_EXACT_PHRASE} when a snippet contains the whole query as one
 * phrase (the strongest evidence a caller meant THIS session), and a recency
 * tier from the session's last activity — 3 within a day, 2 within a week, 1
 * within a month, 0 otherwise or when the session carries no activity stamp.
 *
 * Consumers: {@link buildSessionSearch}, which sorts by it, and the criterion,
 * which pins an expected ordering over a fixture rather than accepting whatever
 * order the engine happened to produce.
 */
export function sessionMatchScore(
  matchCount: number,
  exactPhraseHits: number,
  lastActivityMs: number | null,
  now: number,
): number {
  let score = matchCount * SCORE_PER_MATCH + exactPhraseHits * SCORE_EXACT_PHRASE;
  if (lastActivityMs !== null) {
    const age = Math.max(0, now - lastActivityMs);
    if (age < RECENCY_DAY_MS) score += 3;
    else if (age < 7 * RECENCY_DAY_MS) score += 2;
    else if (age < 30 * RECENCY_DAY_MS) score += 1;
  }
  return score;
}

// --------------------------- cursor ---------------------------

/**
 * The opaque continuation token: base64 of how many sessions to skip.
 *
 * Its own pair rather than the transcript reader's character-offset cursor: that
 * one counts characters inside one text, this one counts SESSIONS across a
 * re-scanned ordering. Both are opaque strings to a caller; neither encoding is
 * a promise.
 */
function encodeSessionCursor(skipped: number): string {
  return Buffer.from(String(skipped), 'utf8').toString('base64');
}

/** Decodes a cursor; anything unreadable restarts at the beginning. */
function decodeSessionCursor(cursor: string | undefined): number {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return 0;
  }
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded > 0 ? decoded : 0;
}

// --------------------------- the search ---------------------------

/** One session as the two engine channels together describe it. */
type CollectedSession = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  matches: McpSessionSearchEngineMatch[];
};

/** The parsed activity stamp behind a sort key, or `null` when there is none to read. */
function readActivityMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The `session_search` reading.
 *
 * Runs one engine search, merges the two channels by `sessionId`, applies the
 * caller's `project` / `provider` / `speaker` filters, sorts by {@link
 * sessionMatchScore}, then cuts the requested page.
 *
 * An empty result is a legitimate reading, not a failure: "nothing mentions this
 * phrase" is exactly what the caller asked, so `results: []` with
 * `totalMatches: 0` is a success. The engine is called with
 * {@link ENGINE_MATCH_LIMIT} so the page is drawn from everything its single
 * scan can find.
 *
 * Consumers: {@link registerMcpSessionSearchTool}, and the criterion, which
 * drives it over a real transcript fixture.
 */
export async function buildSessionSearch(
  input: McpSessionSearchInput,
  deps: McpSessionSearchDeps,
): Promise<McpSessionSearchPayload> {
  const collected = new Map<string, CollectedSession>();
  const titles = new Map<string, McpSessionSearchTitleRow>();

  await deps.search({
    query: input.query,
    limit: ENGINE_MATCH_LIMIT,
    onTitleResults: (results) => {
      for (const row of results) {
        titles.set(row.sessionId, row);
      }
    },
    onProgress: (update) => {
      const project = update.projectResult;
      if (project === null) {
        return;
      }
      for (const session of project.sessions) {
        collected.set(session.sessionId, {
          sessionId: session.sessionId,
          provider: session.provider,
          projectId: project.projectId,
          projectDisplayName: project.projectDisplayName,
          matches: [...session.matches],
        });
      }
    },
  });

  const now = deps.now();
  const hits: McpSessionSearchHit[] = [];
  for (const session of collected.values()) {
    if (input.provider !== undefined && session.provider !== input.provider) {
      continue;
    }
    if (input.project !== undefined && session.projectId !== input.project) {
      continue;
    }
    // `speaker: 'any'` (and an omitted `speaker`) keeps every match; a named role
    // narrows the matches THEMSELVES, because a caller asking for what the user
    // said does not want the assistant's half of the same session.
    const matches = input.speaker === undefined || input.speaker === 'any'
      ? session.matches
      : session.matches.filter((match) => match.role === input.speaker);
    if (matches.length === 0) {
      continue;
    }

    const title = titles.get(session.sessionId);
    const lastActivityMs = readActivityMs(title?.lastActivity);
    const loweredQuery = input.query.toLowerCase();
    const exactPhraseHits = matches.filter((match) => match.snippet.toLowerCase().includes(loweredQuery)).length;

    hits.push({
      sessionId: session.sessionId,
      provider: session.provider,
      projectId: session.projectId,
      projectDisplayName: session.projectDisplayName,
      // A session whose title the title channel did not report still answers:
      // the reading keeps a row rather than dropping a session the transcript
      // scan proved exists.
      sessionTitle: title?.sessionTitle ?? '',
      lastActivity: readTimeField(title?.lastActivity, deps.now),
      score: sessionMatchScore(matches.length, exactPhraseHits, lastActivityMs, now),
      matches: matches.map((match) => ({
        messageId: typeof match.messageUuid === 'string' && match.messageUuid.length > 0 ? match.messageUuid : null,
        role: match.role,
        timestamp: readTimeField(match.timestamp, deps.now),
        snippet: match.snippet,
        highlights: match.highlights.map((highlight) => ({ start: highlight.start, end: highlight.end })),
      })),
    });
  }

  // Deterministic ordering: score first, then session id, so two sessions with
  // the same score always page in the same order across calls.
  hits.sort((left, right) => right.score - left.score || left.sessionId.localeCompare(right.sessionId));

  const totalMatches = hits.reduce((sum, hit) => sum + hit.matches.length, 0);
  const limit = input.limit ?? MCP_SESSION_SEARCH_DEFAULT_LIMIT;
  const skipped = decodeSessionCursor(input.cursor);
  const page = hits.slice(skipped, skipped + limit);
  const moreAvailable = hits.length > skipped + page.length;

  return {
    query: input.query,
    totalMatches,
    moreAvailable,
    results: page,
    ...(moreAvailable ? { cursor: encodeSessionCursor(skipped + page.length) } : {}),
  };
}

// --------------------------- registration ---------------------------

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas. No
 * handler — this module owns the behaviour.
 */
export type McpSessionSearchRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Registers `session_search` through the audited read seam.
 *
 * The name, description, scope and both schemas come from the caller (the
 * stage-3 table plus its body-table entry), so this module owns the BEHAVIOUR
 * and `mcp-gateway.read-tools.js` remains the one statement of the name set.
 * `registerMcpReadTools` calls this only when the deps carry the search engine;
 * an unwired mount keeps the body-table's named refusal instead.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site).
 */
export function registerMcpSessionSearchTool(
  seam: McpReadToolSeam,
  deps: McpSessionSearchDeps,
  registration: McpSessionSearchRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => buildSessionSearch(readSessionSearchInput(args), deps),
  });
}
