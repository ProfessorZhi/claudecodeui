/**
 * Claude's per-run host driver: the process-lifetime half of the Claude runtime,
 * behind `IProvider.hostDriver`, so the session-host layer decides when a per-run
 * process starts and when it ends.
 *
 * ## What this driver owns
 *
 * One `per-run` host is one SDK query. `submit` builds the turn's prompt messages
 * through the runtime's own builder, wraps them in the runtime's held prompt
 * stream, calls the injected query factory and consumes the resulting stream.
 * Holding that stream open is what keeps the CLI alive after a turn's `result`
 * (the CLI reads stdin EOF as print wind-down), and ending it is what lets the
 * process go.
 *
 * ## What it reports, and what it never decides
 *
 * The driver does not decide when a host closes. It reports *reasons to hold* —
 * leases — through the sink `startHost` handed it, and the manager recomputes
 * state from those leases:
 *
 *  - `submit` reports the `turn` lease; the turn's own `result` drops it.
 *  - A message that the runtime's exported `startsBackgroundWork` scores as
 *    starting work outliving the turn reports `background-task` — or `monitor`,
 *    the kind named after the watching tool. A later `result` while that lease is
 *    held is that work reporting back: the lease is dropped, which is what lets
 *    the manager close the host under `released`, and the completion is notified
 *    once per hold.
 *  - Every close arrives as `closeHost(host, reason)`, the manager relaying a
 *    decision it has already made; the driver ends the held input in response.
 *    There is deliberately no supersede logic in here: a new turn on a bound
 *    session reaches the manager as a bind request, and the manager's
 *    `supersedeOnNewTurn` policy closes the old host under `superseded` before
 *    the replacement starts. See `run` for the entry that makes that order the
 *    only one reachable.
 *
 * ## What it does not own
 *
 * Frames. `HostTurnInput` carries the command and its options and no writer, so
 * the client-visible frames of a run are still produced by the runtime's own
 * `run`, which is what the application dispatch calls today; wiring this driver
 * into that dispatch path (and with it frame emission) is the mode/turn
 * integration's job, not this facet's.
 *
 * Consumed by `ClaudeProvider`, which mounts it as `IProvider.hostDriver`, and by
 * the criterion in `tests/claude-host-per-run.test.ts`, which drives it with a
 * scripted query stream, an injected clock and an injected query factory.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  buildPromptMessages,
  createHeldPromptStream,
  resolveClaudeSessionTitle,
  startsBackgroundWork,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  HostBindResult,
  HostCloseReason,
  HostLease,
  HostTurnInput,
  LLMProvider,
  ProcessHost,
  SessionBinding,
} from '@/shared/types.js';

/**
 * The slice of the SDK's `Query` this driver consumes: the message stream plus
 * the interrupt verb.
 *
 * Narrower than the SDK's own `Query`, which also carries `setModel`,
 * `setPermissionMode` and the rest of the live-reconfigure surface a resident
 * process needs. Nothing in per-run mode reconfigures a process mid-turn, so the
 * narrower type is the honest one — and it is what lets a criterion hand in a
 * scripted stream without standing up the whole SDK surface.
 */
export type ClaudeHostQueryStream = AsyncIterable<AnyRecord> & {
  /** Stops the turn in flight; a per-run process has nothing to keep after it. */
  interrupt(): Promise<void>;
};

/**
 * Builds one turn's query.
 *
 * Injected because the SDK's `query` is a module-level function: the runtime
 * imports it directly, so there is no seam to stub and no precedent for module
 * mocking in this repository. A caller that wants to script a stream hands in its
 * own factory; the default is the real SDK.
 */
export type ClaudeHostQueryFactory = (input: {
  prompt: AsyncIterable<AnyRecord>;
  options: AnyRecord;
}) => ClaudeHostQueryStream;

/** The real SDK, at the one boundary where its wide type meets this module's narrow one. */
const sdkQuery: ClaudeHostQueryFactory = (input) =>
  query(input as unknown as Parameters<typeof query>[0]) as unknown as ClaudeHostQueryStream;

/**
 * The manager surface this driver needs, as a port rather than the singleton.
 *
 * `bindSession` is how a turn asks for a process (the manager applies the mode's
 * supersede rule and answers with a host id or a refusal); `snapshot` is how the
 * driver then reads the host record it was given, since the answer carries the id
 * and not the record. Taking it as a constructor option rather than importing
 * `sessionHostManager` is what lets a criterion inject a manager with its own
 * clock — the quiet ceiling this driver's hold is bounded by is that manager's
 * policy, not a number this file knows.
 */
export type ClaudeHostPort = Pick<SessionHostManager, 'bindSession' | 'snapshot'>;

/**
 * The completion a held host reports when the work it was held for comes back.
 *
 * Named fields rather than a free-form record because the notification layer
 * (the default consumer in `ClaudeProvider`) reads exactly these. `sessionId` is
 * the *application* session id — the driver has no provider-native id, and the
 * binding's provider id is recorded by the manager, not here. `sessionName` is
 * null for the same reason: the title lives with the dispatch layer's request
 * context.
 *
 * `userId` is null in this driver's own reports: the runtime's notification calls
 * read it off the connection (`ws?.userId`), and a host bind carries no
 * connection — `HostTurnInput` is the command and its options. The field is here
 * rather than filled in later so the notification layer is handed the shape it
 * reads, and so the day `bindSession` carries a request context the driver has a
 * place to put it.
 */
export type ClaudeBackgroundWorkEvent = {
  appSessionId: string;
  provider: LLMProvider;
  userId: string | null;
  sessionId: string | null;
  sessionName: string | null;
};

export type ClaudePerRunHostDriverOptions = {
  host: ClaudeHostPort;
  /** Called once per hold when the work it was held for reports back. */
  notify: (event: ClaudeBackgroundWorkEvent) => void;
  /** Query factory seam; defaults to the SDK's own `query`. */
  createQuery?: ClaudeHostQueryFactory;
};

/**
 * One host's live run: the held input, the stream, and what has been reported.
 *
 * Per host rather than per driver because both halves are per-process: the input
 * stream is what the CLI's stdin is attached to, and the leases are reported
 * against the host the manager opened for this run.
 */
type HostRun = {
  hostId: string;
  appSessionId: string;
  sink: IProviderHostDriverSink;
  query: ClaudeHostQueryStream;
  /** Ends the held prompt stream, so the CLI sees EOF and winds down. */
  release: () => void;
  /** True while this run holds the manager's `turn` lease. */
  turnOpen: boolean;
  /** The lease held for work outliving the turn, or null when nothing is outstanding. */
  background: Extract<HostLease, { kind: 'background-task' | 'monitor' }> | null;
  /** Set once the held work's report has been notified: at most one notification per hold. */
  notified: boolean;
  /** Set when the manager closed this host, or when the stream ended on its own. */
  closed: boolean;
};

/**
 * The lease a message asks the host to be kept for, or null when it asks nothing.
 *
 * Whether a message starts work that outlives the turn is *not* decided here: the
 * decision is asked of the runtime's exported `startsBackgroundWork`, so this
 * driver cannot drift from the runtime's own tool knowledge (which tools
 * background by default, which defer by nature, which explicit argument opts a
 * foreground call out). What this adds is the two things the lease record needs
 * and the boolean cannot carry — which of the manager's two reasons names it
 * (`monitor` for the watching tool that reason is named after, `background-task`
 * for everything else that defers) and the id of the call that asked.
 */
function backgroundWorkLease(message: AnyRecord): HostRun['background'] {
  if (!startsBackgroundWork(message)) {
    return null;
  }

  const content = message?.message?.content;
  const triggering = Array.isArray(content)
    ? content.find(
        (block) =>
          typeof block?.name === 'string' &&
          // The same classifier, asked about one call at a time, is what locates
          // the call that holds the process — so "which tool defers" is still
          // answered in exactly one place.
          startsBackgroundWork({ message: { content: [block] } }),
      )
    : undefined;
  if (!triggering) {
    return null;
  }

  const kind = triggering.name === 'Monitor' ? 'monitor' : 'background-task';
  return { kind, id: typeof triggering.id === 'string' && triggering.id ? triggering.id : triggering.name };
}

/** Interrupts a query, treating a refused interrupt as the process having moved on. */
async function stopQuery(queryStream: ClaudeHostQueryStream): Promise<void> {
  try {
    await queryStream.interrupt();
  } catch {
    // The stream is going away either way; a refused interrupt is not a failure
    // to close, so there is nothing left for the caller to branch on.
  }
}

/**
 * Owns the process lifetime of Claude's `per-run` hosts.
 *
 * Constructed per provider (one instance serves every session, because a driver
 * holds no per-session state outside `runs`). See the file header for what it
 * reports, what it never decides, and what it deliberately does not own.
 */
export class ClaudePerRunHostDriver implements IProviderHostDriver {
  private readonly provider: LLMProvider = 'claude';
  private readonly host: ClaudeHostPort;
  private readonly notify: (event: ClaudeBackgroundWorkEvent) => void;
  private readonly createQuery: ClaudeHostQueryFactory;
  /** The sink the manager handed each host in `startHost`, held for the host's life. */
  private readonly sinks = new Map<string, IProviderHostDriverSink>();
  /** The live run per host. */
  private readonly runs = new Map<string, HostRun>();
  /** Which session each host serves, so `unbind` can reach the run it must release. */
  private readonly sessionByHost = new Map<string, string>();
  /** Counted turn ids: one per `submit`, so a reading of the lease is repeatable. */
  private serial = 0;

  constructor(options: ClaudePerRunHostDriverOptions) {
    this.host = options.host;
    this.notify = options.notify;
    this.createQuery = options.createQuery ?? sdkQuery;
  }

  /**
   * Dispatches one turn for one session — this driver's counterpart to
   * `IProviderRuntime.run`.
   *
   * The order is the whole point: the manager is asked for a process *first*, and
   * only then is the turn delivered to the host it answered with. A driver that
   * instead superseded an earlier hold itself would make the old host's close
   * reason invisible — the manager would see a binding whose leases emptied and
   * record `released` where the truth is `superseded`. So the supersede is left
   * to the policy, and this entry is only the ask.
   *
   * Returns the manager's own bind answer, refusals included: `session-already-bound`
   * and `host-not-multiplexed` are answers a caller branches on, not faults.
   */
  async run(appSessionId: string, turn: HostTurnInput): Promise<HostBindResult> {
    const bound = await this.host.bindSession({
      provider: this.provider,
      appSessionId,
      driver: this,
      mode: 'per-run',
    });
    if (!bound.ok) {
      return bound;
    }

    const host = this.host.snapshot().find((candidate) => candidate.hostId === bound.hostId);
    if (!host) {
      throw new Error(`session host ${bound.hostId} vanished between the bind and the submit`);
    }

    await this.submit(host, appSessionId, turn);
    return bound;
  }

  /** Remembers the sink this host reports through. No process is started here. */
  async startHost(host: ProcessHost, sink: IProviderHostDriverSink): Promise<ProcessHost> {
    this.sinks.set(host.hostId, sink);
    return host;
  }

  /**
   * Records which session this host serves.
   *
   * A per-run process is opened by its first turn: `submit` builds the query and
   * reports the turn lease, so there is no process work to do on a bind. What the
   * bind does carry is the session, and that is what `unbind` needs — it is given
   * the host, and the run it has to release is keyed by the host.
   */
  async bind(host: ProcessHost, binding: SessionBinding): Promise<void> {
    this.sessionByHost.set(host.hostId, binding.appSessionId);
  }

  /**
   * Delivers one turn: builds the query, reports the `turn` lease, starts reading.
   *
   * The read loop is deliberately not awaited. For a per-run host the turn's
   * lifetime is the process's lifetime, and the process outlives the `submit` that
   * started it — the manager closes it later, on a quiet ceiling, a supersede or a
   * report from the held work. A `submit` that awaited the loop would hold its own
   * caller open for the whole hold, which is exactly the gap this layer exists to
   * make visible rather than to hide.
   */
  async submit(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<void> {
    await this.openRun(host, appSessionId, turn);
  }

  /** Stops the turn in flight, reporting whether there was one. */
  async interrupt(host: ProcessHost, appSessionId: string): Promise<boolean> {
    const run = this.runs.get(host.hostId);
    if (!run || run.appSessionId !== appSessionId) {
      return false;
    }
    await stopQuery(run.query);
    return true;
  }

  /**
   * Reports that nothing can be changed under a running turn.
   *
   * A per-run process serves one turn and then ends, so there is no live process
   * to reconfigure: the change belongs to the next turn's own process. Declaring
   * `next-turn` rather than `live` is what keeps a caller from believing a model
   * switch landed on a process that is about to exit.
   */
  async reconfigure(): Promise<'live' | 'next-turn'> {
    return 'next-turn';
  }

  /**
   * Detaches one session, ending the hold it was keeping.
   *
   * One binding per host, so a detach leaves this process with nothing to serve:
   * the hold is ended here, and the close the manager decides next is then a
   * formality rather than a second release.
   */
  async unbind(host: ProcessHost, appSessionId: string): Promise<void> {
    this.sessionByHost.delete(host.hostId);
    const run = this.runs.get(host.hostId);
    if (!run || run.appSessionId !== appSessionId) {
      return;
    }
    this.endHold(run);
  }

  /**
   * Ends the host: stops a turn still in flight, then releases the held input.
   *
   * The reason decides whether there is a turn to stop. `turn-complete` and
   * `released` both mean the work was already over — the turn wrote its `result`,
   * or the held work reported back — so the input is simply released. Every other
   * reason is the process being taken away mid-work, and a turn in flight is
   * stopped before the CLI is told to wind down.
   */
  async closeHost(host: ProcessHost, reason: HostCloseReason): Promise<void> {
    this.sinks.delete(host.hostId);
    this.sessionByHost.delete(host.hostId);
    const run = this.runs.get(host.hostId);
    this.runs.delete(host.hostId);
    if (!run || run.closed) {
      return;
    }

    if (reason !== 'turn-complete' && reason !== 'released') {
      await stopQuery(run.query);
    }
    this.endHold(run);
  }

  /**
   * Starts one turn's query and reports the `turn` lease.
   *
   * The prompt is built by the runtime's own builder, so attachment expansion and
   * file tags behave exactly as they do on the runtime's own runs. Keeping the
   * query's input stream held open is what keeps the CLI alive past the turn's
   * `result`; this run's `release` — the handle the manager's close reaches
   * through — is the same held stream's closer.
   */
  private async openRun(host: ProcessHost, appSessionId: string, turn: HostTurnInput): Promise<HostRun> {
    const sink = this.sinks.get(host.hostId);
    if (!sink) {
      throw new Error(`host ${host.hostId} was submitted to before startHost gave it a sink`);
    }

    const options = turn.options;
    const promptMessages = await buildPromptMessages(
      turn.command,
      options.images,
      options.files,
      options.cwd,
    );
    const held = createHeldPromptStream(promptMessages);

    // The session's own title, when this bag names a provider session to read one
    // from — the same handover the runtime makes on the per-run dispatch path, so
    // the two launch sites cannot disagree about what a session answers to.
    //
    // The provider id is read off the option bag rather than resolved through a
    // provider-scoped context, because this driver is handed one and has none:
    // its options are the caller's own. A bag that names no provider session —
    // which is every bag that has not been through a resume, including the one
    // the criterion in `claude-host-per-run.test.ts` hands in — launches exactly
    // as it did before, with no title at all. That is also the behaviour a
    // session's *first* turn needs: a title handed over at creation suppresses
    // the CLI's own title generation, so there has to be one to hand over first.
    //
    // The key written is the SDK's own (`title`) and not the shared builder's
    // `sessionTitle`, because this driver hands its bag straight to `query`
    // instead of through `mapCliOptionsToSDK`.
    const sessionTitle = await resolveClaudeSessionTitle(
      typeof options?.providerSessionId === 'string' ? options.providerSessionId : null,
      typeof options?.cwd === 'string' ? options.cwd : null,
    );
    const queryOptions = sessionTitle ? { ...options, title: sessionTitle } : options;

    const queryStream = this.createQuery({ prompt: held.stream, options: queryOptions });

    const run: HostRun = {
      hostId: host.hostId,
      appSessionId,
      sink,
      query: queryStream,
      release: held.release,
      turnOpen: true,
      background: null,
      notified: false,
      closed: false,
    };

    this.runs.set(host.hostId, run);
    this.sessionByHost.set(host.hostId, appSessionId);
    sink.leaseAdded(appSessionId, { kind: 'turn', runId: `turn-${++this.serial}` });
    this.readStream(run);
    return run;
  }

  /** Runs the read loop detached, with a rejection sink so nothing floats unhandled. */
  private readStream(run: HostRun): void {
    this.consume(run).catch(() => undefined);
  }

  /**
   * Reads one host's query stream to its end.
   *
   * Deliberately not stopped when the manager closes the host: closing ends the
   * *input* (the manager's close reaches `release`, so the CLI sees EOF and winds
   * down), and the stream's own end is the fact being watched for. Breaking out on
   * `run.closed` would instead drop whatever the process says on its way out —
   * including, after a release, a report the manager should have seen and did not.
   * Continuing is safe: the sink verbs refuse on a closed host, so an observation
   * of one changes nothing.
   *
   * A stream that ends while the manager still has the host open is reported
   * through the sink's `exited`: the process went away rather than being closed,
   * which is the one fact about a stream's end the manager cannot see for itself.
   */
  private async consume(run: HostRun): Promise<void> {
    try {
      for await (const message of run.query) {
        this.observe(run, message);
      }
      this.reportExit(run);
    } catch {
      // A query that throws has ended the same way as one that stops yielding: the
      // process is gone, and the manager is told so once.
      this.reportExit(run);
    }
  }

  /** Reports a stream that ended on its own, unless the manager already closed the host. */
  private reportExit(run: HostRun): void {
    if (run.closed) {
      return;
    }
    run.closed = true;
    // `error` is the closest detail the close vocabulary carries for a query that
    // failed on its own; `oom`/`signal` are kernel facts this layer cannot see.
    run.sink.exited({ hostId: run.hostId, detail: 'error' });
  }

  /**
   * Folds one SDK message into the host's reported state.
   *
   * The three facts a message can carry, in the order they are read: work that
   * outlives the turn (a new hold), work still moving (the quiet window moves with
   * it), and the end of a turn or of the work it was held for.
   */
  private observe(run: HostRun, message: AnyRecord): void {
    const background = backgroundWorkLease(message);
    if (background) {
      run.background = background;
      run.notified = false;
      run.sink.leaseAdded(run.appSessionId, background);
    }

    // Every message is real work on the binding — a streamed frame, a tool call, a
    // turn boundary — which is what pushes the manager's quiet window out. The
    // held work reporting in repeatedly must not let the hold age out from under
    // itself, which is why this is not conditioned on the turn still being open.
    run.sink.activity(run.appSessionId);

    if (message?.type !== 'result') {
      return;
    }

    if (run.turnOpen) {
      // The turn's own result. The client is done with the turn even though the
      // process may still be held, so the turn's reason goes away here rather than
      // at the end of the stream — and whether the host closes on the spot or
      // lingers is the manager's reading of whatever reasons are left.
      run.turnOpen = false;
      run.sink.leaseRemoved(run.appSessionId, 'turn');
      return;
    }

    if (!run.background) {
      return;
    }

    // A result arriving after the turn's own is the work this host was held for
    // reporting back — the follow-up turn a background task or a watcher pushes.
    // The notification fires before the reason is dropped, so a listener sees the
    // host as it was, and at most once per hold: `notified` is cleared when a new
    // hold starts, which is what makes this "exactly once" rather than "at least
    // once".
    const held = run.background;
    run.background = null;
    if (!run.notified) {
      run.notified = true;
      this.notify({
        appSessionId: run.appSessionId,
        provider: this.provider,
        userId: null,
        sessionId: run.appSessionId,
        sessionName: null,
      });
    }
    run.sink.leaseRemoved(run.appSessionId, held.kind);
  }

  /**
   * Ends one run's hold: the input stream the CLI's stdin is attached to.
   *
   * Idempotent, because two paths can reach it — an `unbind` followed by the close
   * that always follows it for a single-binding host, or a close after the stream
   * already ended. `release` resolves a promise, so a second call is a no-op.
   */
  private endHold(run: HostRun): void {
    if (run.closed) {
      return;
    }
    run.closed = true;
    run.release();
  }
}
