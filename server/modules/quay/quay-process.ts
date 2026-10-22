import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type {
  QuayCommandFailureKind,
  QuayCommandResult,
  QuayCommandRunner,
} from './quay.service.js';

/**
 * Per-command subprocess bound. quay's read commands are JSON printers, but
 * `quay task list --json` is linear in the store size (it prints every task's
 * whole body): ~3 s against this bound on this workspace's own store.
 */
export const QUAY_COMMAND_TIMEOUT_MS = 8_000;

/**
 * Cap on captured CLI stdout, so one runaway command cannot exhaust the server's
 * memory.
 *
 * It has to sit well above the largest *real* payload rather than at it.
 * `quay task list --json` carries every task's full body (~10 KB per task), so
 * this workspace's own quay store (2,531 tasks) prints ~26 MB. Under the previous
 * 8 MiB cap `execFile` killed the child mid-string, `JSON.parse` failed on the
 * torn tail, and the service degraded the Task ledger to `null` — which the panel
 * then rendered as "0 tasks". The cap is therefore sized for a store an order of
 * magnitude larger than the one that broke it, not for the one that fits today.
 */
export const QUAY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Path, relative to a target project's root, of the stable project-scoped quay
 * entrypoint that `/quay:init` installs. The adapter resolves this under the
 * `projectRoot` it is handed, so a project pinned to a particular quay version
 * is always driven by that project's own CLI — never by whichever `quay` happens
 * to be first on the CloudCLI server process's `PATH`, which is a property of how
 * the server was launched rather than of the project it is inspecting.
 */
const QUAY_ENTRYPOINT_RELATIVE_PATH = path.join('.quay', 'plugin', 'bin', 'quay');

/** The bare command the migration-period fallback falls back to when a project has no entrypoint. */
const QUAY_BARE_COMMAND = 'quay';

/** Minimal shape of the `execFile` error fields the failure classifier reads. */
type QuayExecFileError = Error & {
  /** Numeric exit code for a non-zero exit, an errno string (`ENOENT`, `EACCES`) for a spawn failure, or `null` on a signal kill. */
  code?: number | string | null;
  /** `true` when Node terminated the child because it exceeded `options.timeout`. */
  killed?: boolean;
  /** Signal that terminated the child (`SIGTERM` on a timeout). */
  signal?: string | null;
};

/** Options the adapter hands `execFile`: a subset of Node's `ExecFileOptions`, with a fixed encoding. */
type QuayExecFileOptions = {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
  windowsHide: boolean;
};

type QuayExecFileCallback = (
  error: QuayExecFileError | null,
  stdout: string,
  stderr: string,
) => void;

/**
 * The child-process spawn boundary. It is injected so `server/modules/quay/tests/quay-process.test.ts`
 * can record the exact command path the adapter resolved (and simulate errnos and
 * timeouts) without spawning a real process; production binds Node's `execFile`
 * through {@link defaultExecFile}.
 */
export type QuayExecFile = (
  file: string,
  args: readonly string[],
  options: QuayExecFileOptions,
  callback: QuayExecFileCallback,
) => void;

const defaultExecFile: QuayExecFile = (file, args, options, callback) => {
  execFile(file, [...args], options, callback);
};

/** Regular-file existence probe for the project entrypoint; `false` on any stat error (ENOENT, ENOTDIR, …). */
function entrypointIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Execute-permission probe (`X_OK`). A file with no execute bit set fails this
 * even when the server runs as root, which is exactly the "entrypoint exists but
 * cannot be spawned" case reported as `entrypoint-not-executable`.
 */
function entrypointIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injectable boundaries of the quay process adapter. Every field is optional and
 * defaults to the production implementation, so the composition root
 * (`quay.module.ts`) calls `createQuayProcessRunner()` while tests bind fakes to
 * drive the resolution and failure branches deterministically.
 */
export type QuayProcessDependencies = {
  /** Spawns the resolved binary. Inject to record the command path or simulate errnos/timeouts. */
  execFile?: QuayExecFile;
  /** Entrypoint existence probe. Inject to drive the resolution branches without touching disk. */
  fileExists?: (filePath: string) => boolean;
  /** Entrypoint execute-permission probe. Inject alongside `fileExists` in resolution tests. */
  isExecutable?: (filePath: string) => boolean;
  /** Sink for the migration-period warning raised when a project has no entrypoint. Defaults to `console.warn`. */
  warn?: (message: string) => void;
};

/** A failure raised before any child was spawned; `code` is `null` because no exit status exists. */
function localFailure(kind: QuayCommandFailureKind, error: string): QuayCommandResult {
  return { ok: false, code: null, stdout: '', stderr: '', error, failureKind: kind };
}

/** Maps an `execFile` error to the panel's failure taxonomy. */
function classifySpawnError(error: QuayExecFileError): QuayCommandFailureKind {
  if (error.killed === true) {
    return 'timeout';
  }
  if (error.code === 'ENOENT') {
    return 'entrypoint-missing';
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return 'entrypoint-not-executable';
  }
  if (typeof error.code === 'number') {
    return 'nonzero-exit';
  }
  return 'spawn-error';
}

/**
 * Category-specific failure message. The `entrypoint-missing` text names the
 * remedy (`/quay:init`) so the panel's warning tells the user what to do rather
 * than restating that the command failed.
 */
function describeSpawnError(
  kind: QuayCommandFailureKind,
  error: QuayExecFileError,
  entrypoint: string,
  usedBareFallback: boolean,
): string {
  switch (kind) {
    case 'entrypoint-missing':
      return usedBareFallback
        ? `no quay CLI for this project: ${entrypoint} is missing and no "${QUAY_BARE_COMMAND}" is on PATH. Run /quay:init in this project to install a project-scoped CLI.`
        : `no quay CLI for this project: ${entrypoint} was not found when the command was spawned. Run /quay:init in this project to install a project-scoped CLI.`;
    case 'entrypoint-not-executable':
      return `quay entrypoint ${entrypoint} cannot be executed (missing execute permission).`;
    case 'timeout':
      return `quay command timed out: ${error.message}`;
    case 'nonzero-exit':
      return `quay exited with a non-zero status: ${error.message.trim()}`;
    default:
      return `failed to start the quay process: ${error.message}`;
  }
}

/**
 * Production subprocess adapter: runs one already-whitelisted quay argv and
 * captures its output. It uses `execFile` with an argument array and no shell, so
 * an argument can never be reinterpreted as shell syntax; the argv has been
 * matched against the service's read-only whitelist before it gets here.
 *
 * The binary is resolved per invocation from the target project's root rather
 * than from the server process's `PATH`: for `cwd` (which the service always
 * sets to the project's `projectPath`) the adapter prefers the project-scoped
 * entrypoint `<cwd>/.quay/plugin/bin/quay` and spawns that absolute path. Only
 * while a project has not yet run `/quay:init` does it fall back to a bare
 * `quay` on `PATH`, and that fallback emits an explicit warning.
 *
 * The injected `execFile` seam lets `server/modules/quay/tests/quay-process.test.ts`
 * assert the resolved command path and the buffer policy against a stub payload.
 */
export function createQuayProcessRunner(
  dependencies: QuayProcessDependencies = {},
): QuayCommandRunner {
  const spawn = dependencies.execFile ?? defaultExecFile;
  const fileExists = dependencies.fileExists ?? entrypointIsFile;
  const isExecutable = dependencies.isExecutable ?? entrypointIsExecutable;
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));

  return (cwd, args, { timeoutMs }) =>
    new Promise<QuayCommandResult>((resolve) => {
      // `cwd` is always the target project's root (the service passes the
      // project's `projectPath`): it is both the child's working directory and
      // the base the project-scoped entrypoint is resolved under.
      const entrypoint = path.join(cwd, QUAY_ENTRYPOINT_RELATIVE_PATH);

      let command: string;
      let usedBareFallback = false;

      if (fileExists(entrypoint)) {
        if (!isExecutable(entrypoint)) {
          resolve(localFailure(
            'entrypoint-not-executable',
            `quay entrypoint ${entrypoint} cannot be executed (missing execute permission).`,
          ));
          return;
        }
        command = entrypoint;
      } else {
        // TODO(migration): remove the bare-PATH fallback once every target project is
        // guaranteed to carry <projectRoot>/.quay/plugin/bin/quay (installed and refreshed by
        // `/quay:init`). It is a stop-gap so projects mid-migration keep working; it warns on
        // every use so a lingering fallback is observable rather than silent.
        usedBareFallback = true;
        command = QUAY_BARE_COMMAND;
        warn(
          `quay entrypoint ${entrypoint} not found for project ${cwd}; falling back to the bare `
          + `"${QUAY_BARE_COMMAND}" on PATH. Run /quay:init in this project to pin a project-scoped CLI.`,
        );
      }

      spawn(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: QUAY_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
            return;
          }

          const kind = classifySpawnError(error);
          resolve({
            ok: false,
            code: typeof error.code === 'number' ? error.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: describeSpawnError(kind, error, entrypoint, usedBareFallback),
            failureKind: kind,
          });
        },
      );
    });
}
