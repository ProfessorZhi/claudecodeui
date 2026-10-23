import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The output port the attempt line already goes through. The capture row is written with the same
// one, so a deployment that pipes the process's structured lines somewhere sees both kinds without a
// second seam, and a test that counts them counts what the shipping process writes.
import type { VoiceLogPort } from '@/shared/types.js';

/**
 * The three modes `VOICE_CAPTURE` resolves to.
 *
 * `off` is not "no value": it is the mode an unset variable, an explicit `off`, and every value the
 * resolver does not recognise all read as. That is deliberate — an unrecognised value must fail
 * CLOSED, because a deployment that misspells a recording mode must end up recording nothing rather
 * than recording the thing it meant to keep out of the log.
 *
 * The two recording modes differ in where an attempt goes: `text` writes the attempt as a row on the
 * process's own output, `audio` additionally writes the uploaded bytes into a directory. Which of the
 * two a deployment wants is a privacy decision, not a debugging detail, which is why it is read once
 * at start-up and never per request.
 */
export type VoiceCaptureMode = 'off' | 'text' | 'audio';

/**
 * What one raw `VOICE_CAPTURE` value resolves to.
 *
 * `warning` is the TEXT of the one warning line an unrecognised value earns — non-null exactly when
 * `mode` was not recognised, and carrying the offending value verbatim. Carrying the text rather than
 * a boolean is what lets the composition root write the line without deciding anything: the decision
 * about what an unrecognised value means is the resolver's, and the root only prints what it is
 * handed.
 */
export type VoiceCaptureResolution = {
  mode: VoiceCaptureMode;
  warning: string | null;
};

/**
 * The audio one attempt sent, exactly as it was uploaded.
 *
 * The bytes are the uploaded buffer itself, never a copy, an encoding, or a re-serialisation: a
 * recording that is written to disk has to be the recording that was transcribed, or the file cannot
 * be replayed and the sha256 beside it is a hash of something else.
 */
export type VoiceCaptureAudio = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
};

/**
 * What the transport answered an attempt, exactly as it was read.
 *
 * THE BODY IS A STRING THIS MODULE DID NOT WRITE. It is the upstream's own answer, byte for byte, and
 * it is here rather than in the service because a row that recorded the text the caller finally got
 * would answer a different question — "what did we send back" instead of "what did they say" — and
 * the two differ exactly when the answer was a failure, which is when a reader needs the second one.
 *
 * IT CARRIES NOTHING OF THE REQUEST. The transport hands this module an answer; the request's body
 * and headers are not part of it and are not fields here, so "no credential, no prompt and no header
 * is in the row" stays a property of the shape rather than a filter to remember — see
 * `buildVoiceCapturePayload`, the one place a row is built.
 */
export type VoiceCaptureRawReturn = {
  status: number;
  body: string;
};

/**
 * The raw answer as it goes into a row: verbatim while it fits, a flagged prefix when it does not.
 *
 * `truncated` is ABSENT rather than `false` when nothing was cut. The two are not the same reading to
 * a consumer: an absent key says "this is all of it", while `truncated: false` says "this is a field
 * that could have been true". Only one of those is a promise the row can keep — a body that fits is
 * the answer itself, and marking it would put a field on every row that means nothing on any of them.
 */
export type VoiceCaptureUpstream = {
  status: number;
  body: string;
  truncated?: true;
};

/**
 * The most of an upstream answer one row ever carries, in UTF-8 bytes.
 *
 * A CONSTANT, and exported, because the criterion that reads both sides of the cut has to name the
 * same number the implementation uses: a threshold spelled twice is a threshold that can drift, and
 * the drift would be invisible — a row cut at 65536 and a criterion checking 65537 disagree only
 * about the byte after the last one. 64 KiB is the size a row stays readable at: past it a log line
 * stops being something an operator can look at and becomes a file transfer.
 */
export const RAW_RETURN_LIMIT_BYTES = 65536;

/**
 * The six answers one attempt's outcome falls into, as a CLOSED set.
 *
 * The first two are the two ways a written recogniser succeeds — it produced the instruction it was
 * asked for, or it degraded to the transcription and said so through `meta.writtenFallback`. The next
 * two are the two ways a 2xx answer fails to be usable — the service heard nothing (an envelope that
 * parsed with neither field in it) or the answer was not this service's envelope at all. The last two
 * are the two ways an attempt ends without a usable answer: the transport answered and the answer was
 * a refusal, or no transport was reached at all.
 *
 * A closed set rather than a free string because a reader selects on it: "how often does this
 * deployment degrade to a transcription" and "how often is the upstream refusing us" are two
 * different questions, and they are answerable from a row only if both answers have a name.
 */
export type VoiceCaptureBranch =
  | 'written'
  | 'verbatim-fallback'
  | 'no-speech'
  | 'envelope-error'
  | 'upstream-failure'
  | 'preflight-refused';

/**
 * What one attempt READ: the adapter's answer, narrowed to the scalars a branch is decided from.
 *
 * `code` is the adapter's own vocabulary for a failure and `writtenFallback` its own for a degraded
 * success, so the branch below is derived from what the adapter said rather than from a second parse
 * of the response. `text` is what the attempt returned to its caller — the instruction on the written
 * branch, the transcription on the degraded one, and the empty string on every failure, because a
 * failure returned no text and inventing one would make the row read as a success.
 */
export type VoiceCaptureAttemptReading = {
  ok: boolean;
  code?: string;
  writtenFallback?: number;
  text: string;
};

/**
 * The NARROWED input the row is built from.
 *
 * THIS IS THE INTERFACE THE ROW'S CONTENTS ARE DECIDED AT, and it is narrow on purpose: a field that
 * is not here cannot reach a row no matter what the caller has in hand. The service holds a request
 * (a URL, an init, a credential); what crosses this boundary is the address the attempt used, the
 * upload, the answer the transport gave back, and the four scalars above. Nothing of the request's
 * headers or body has a name here, which is what makes "the row does not carry them" structural.
 */
export type VoiceCapturePayloadInput = {
  model: string;
  /** The address the attempt used. Only its host is ever written; see `voiceCaptureHost`. */
  baseUrl: string;
  audio: VoiceCaptureAudio;
  /** The raw answer this attempt read, or `null` when it read none. */
  upstream: VoiceCaptureRawReturn | null;
  /**
   * Whether this attempt reached the transport at all.
   *
   * THIS IS NOT `upstream !== null`, and the difference is the reason it is a field. An attempt whose
   * request went out and whose answer could not be read has no `upstream` and is still not a preflight
   * refusal; an attempt refused before the transport has no `upstream` because nothing was sent. Only
   * the service can tell those two apart — it is the side the request leaves from — so it says which
   * one happened rather than leaving the builder to infer it from a consequence that both produce.
   */
  requestSent: boolean;
  /**
   * The request headers this attempt's request carried, WHETHER OR NOT THE ROW WRITES THEM.
   *
   * WHY THIS FIELD EXISTS AT ALL, AND WHY NOTHING READS IT. The row is built by enumerating the
   * fields of this input — the projection is the builder's return literal, not a spread — so a
   * header the service holds in `init.headers` is unreachable from any row unless a name for it
   * crosses the seam. That makes "the credential is not in the row" a property of a shape the
   * service cannot widen by accident, which is the property the deployment recording headers would
   * break, and it is also why the property cannot be FALSIFIED from the service side: a mutation
   * that adds `requestHeaders` to the builder's return would find the field already there and drop
   * nothing. This field is the receiving end of that wire, and it is on the input rather than the
   * payload because the INPUT is what the service fills in — a name that existed only on
   * `VoiceCapturePayload` would be a field the builder had to produce out of nothing.
   *
   * THE SHIPPING BUILDER DOES NOT WRITE IT. `buildVoiceCapturePayload` enumerates the fields it
   * copies and this is not one of them, so a row produced by the shipping path is byte-identical to
   * the row produced before this field existed. The two falsifying forms in
   * `voice-capture-secrets.false-forms.test.ts` are the two one-anchor mutations of that return
   * literal, and this field is what makes them mutations of a reachable surface rather than of a
   * dead one.
   */
  requestHeaders?: Record<string, string>;
  reading: VoiceCaptureAttemptReading;
};

/**
 * The payload half of a row: what the attempt actually used, actually sent, and actually got back.
 *
 * Every field is either computed here (`host`, `bytes`, `sha256`, `branch`) or a copy of something
 * read (`model`, `mime`, `upstream`, `text`) — and the two of those that could carry a secret are the
 * two that cannot: `sha256` is a digest of the upload rather than the upload, and `upstream` is an
 * ANSWER, so a credential that went out in a request header is not in it. The upload's bytes are the
 * one thing that would be a recording in the log, and they are represented by a hash and a length.
 */
export type VoiceCapturePayload = {
  model: string;
  host: string;
  mime: string;
  bytes: number;
  sha256: string;
  upstream: VoiceCaptureUpstream | null;
  branch: VoiceCaptureBranch;
  text: string;
};

/**
 * One attempt, as the record construction point sees it.
 *
 * Every field here is one this module or the service COMPUTED — a provider id, an outcome, a status,
 * a duration — plus the upload and, on a recording deployment, the narrowed payload input. No
 * message, no credential, no header and no prompt can reach it, because none of them is a field:
 * "the row has no secret in it" is a property of the row's shape rather than of a filter someone has
 * to remember to keep in step.
 *
 * The audio travels with the attempt rather than through a second seam because the row and the file
 * must describe the same bytes: a writer handed a different copy than the one the row hashes would
 * make the two halves of a recording disagree with nothing on screen to say so. The payload travels
 * the same way — see `buildVoiceCapturePayload`.
 */
export type VoiceCaptureAttempt = {
  providerId: string;
  outcome: 'ok' | 'fail';
  status: number;
  audio: VoiceCaptureAudio;
  /**
   * The pairing id this attempt's request carried, when it carried one.
   *
   * ABSENT MEANS THE REQUEST NAMED NONE, and the row then has no `listenId` key at all — this
   * module's "absence rather than a placeholder" convention. It is present only when `/transcribe`
   * was handed the text field, which is only when a recording client paired this upload with its raw
   * corpus row for the same listen.
   */
  listenId?: string;
  /**
   * The payload refinement, when this deployment records one.
   *
   * ABSENT MEANS THE ATTEMPT IS RECORDED WITHOUT IT — the row this module has always written. The
   * field exists so the refinement is an ARGUMENT rather than a property of the mode: a criterion
   * that builds a port and hands it an attempt decides what that attempt recorded, and a mode that
   * records nothing still constructs no attempt at all (see the gate in `createVoiceService`).
   */
  payload?: VoiceCapturePayloadInput;
};

/**
 * The audio half of the seam: where a recording goes, and the write itself.
 *
 * IT IS A DEPENDENCY OF THE PORT RATHER THAN OF THE SERVICE, because the service must not know that
 * `audio` mode exists beyond the fact that it records. A deployment supplies the sink — and the
 * directory resolution happens on the first write rather than at start-up, which is what makes "a
 * mode that writes nothing creates no directory anywhere, not even a configured one" a structural
 * property instead of a promise.
 *
 * The shipping implementation is `createVoiceCaptureAudioSink` below: the file write, the directory's
 * creation and the 0700/0600 they are held at. A deployment that supplies no sink still records its
 * attempt rows and puts nothing on disk — which is what a copy of this module under a mutation, or a
 * criterion driving `audio` mode without one, is measuring.
 */
export type VoiceCaptureAudioSink = {
  /** Resolves the directory a recording goes into, at the moment one is actually written. */
  resolveDirectory(): string;
  /**
   * Writes one attempt's uploaded bytes into `directory` and says WHERE they landed.
   *
   * THE RETURN IS THE POINT. A row that named a path it did not get from the writer would be a guess
   * about a naming scheme this side of the seam is not supposed to know, and the two would disagree
   * the first time the sink changed how it names a file. The path is an ABSOLUTE one, because that is
   * the only form a reader holding nothing but a log line can open.
   *
   * The `captureId` is the attempt's own id and not the shape of a file name: a sink that took the
   * name from the upload instead would join a caller-chosen string into a path, which is how a
   * recording ends up outside the directory it was meant to be kept in. `audio` carries the uploaded
   * bytes THEMSELVES — the same `Uint8Array` the row's `sha256` is taken over — so a sink that
   * re-encodes, truncates or wraps them writes a file the row does not describe.
   */
  writeAudio(directory: string, captureId: string, audio: VoiceCaptureAudio): string;
  /**
   * Writes one listen's RAW upload into `directory` and says WHERE it landed.
   *
   * OPTIONAL, and its absence is a deployment shape rather than a fault: the raw half is a SECOND
   * delivery of this sink and a sink that supplies only `writeAudio` (a criterion's counter, a
   * deployment assembled before raw capture existed) still records attempt rows — a port handed such a
   * sink writes the raw ROW without a file rather than failing. THE SHIPPING SINK DOES SUPPLY IT.
   *
   * The `listenId` is the pairing key, not a file name: the sink builds the name from it (see
   * `writeRaw` on the shipping sink), so a caller-chosen string is never joined into a path directly.
   * `bytes` are the raw upload's bytes THEMSELVES — the same buffer the row's `sha256` is taken over.
   */
  writeRaw?(directory: string, listenId: string, bytes: Uint8Array): string;
};

/**
 * The recording seam the service writes attempts through.
 *
 * TWO CALLS PER ATTEMPT, AND THE ORDER IS THE REASON. `newAttemptId` names the attempt before its
 * `voice.transcribe` line is written, so that line can carry the id; `recordAttempt` writes the
 * capture row immediately AFTER it. One call could not do both: the attempt line has to be the first
 * of the two (a reader following the process's output sees the attempt, then what was recorded about
 * it), and an implementation that minted the id inside the row call would have no id to put on the
 * line that comes first.
 *
 * `mode` is on the port rather than on the service's dependencies so that the one gate lives in one
 * place in the service — see the `recording` binding in `createVoiceService` — and so that a port
 * built for `off` is a port the service can be handed and still record nothing with.
 */
export type VoiceCapturePort = {
  mode: VoiceCaptureMode;
  /** Names one attempt, before its attempt line is written. */
  newAttemptId(): string;
  /** Writes one attempt's row. THE single record construction point. */
  recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void;
  /**
   * Whether this port collects raw (pre-VAD) audio at all. Absent reads as off.
   *
   * THE SWITCH LIVES ON THE PORT RATHER THAN ON THE SERVICE for the reason `mode` does: it is a
   * property of the DEPLOYMENT's configuration, decided once at the composition root, and a port
   * built for a deployment that did not ask for raw capture is a port that writes raw rows nowhere.
   */
  raw?: boolean;
  /**
   * Writes one listen's raw-audio row, and its file when this deployment has a sink and the switch is
   * on. THE single place a raw row is ever built.
   *
   * OPTIONAL, and its absence is a port shape rather than a fault — a port a criterion wraps to count
   * calls, or one a deployment assembled without the raw half, has no raw write and the service reads
   * that as "raw capture is not available here". THE SHIPPING PORT DOES SUPPLY IT.
   *
   * Off is a NO-OP that resolves no directory and touches no file: the switch is read INSIDE this
   * method as well as by the service, so a caller that reached it past the service's own gate still
   * writes nothing.
   */
  recordRaw?(input: VoiceCaptureRawInput): void;
};

/** The marker every capture row carries as its `event`. */
export const VOICE_CAPTURE_EVENT = 'voice.capture';

/**
 * The marker every RAW-capture row carries as its `event`.
 *
 * A SECOND EVENT NAME rather than the same one with a flag, because the two rows answer different
 * questions and a reader selects on which: `voice.capture` describes one transcription attempt (its
 * model, host, answer, branch, trimmed bytes), while `voice.capture.raw` describes one listen's
 * pre-VAD audio, which no attempt consumed. A reader counting attempts and a reader counting
 * recorded listens are two readers, so the two lines have two names.
 */
export const VOICE_CAPTURE_RAW_EVENT = 'voice.capture.raw';

/**
 * One listen's RAW upload: the pairing id and the pre-VAD bytes themselves.
 *
 * `listenId` IS THE PAIRING KEY and is required — the raw row exists to be joined with the trimmed
 * rows and the transcribed text of the SAME listen, so a row without one would be a file nothing
 * could be matched to. `bytes` are the upload's bytes THEMSELVES, for the reason `VoiceCaptureAudio`'s
 * are: a recording written to disk has to be the recording that was uploaded, or a digest beside it
 * is a digest of something else.
 */
export type VoiceCaptureRawInput = {
  listenId: string;
  bytes: Uint8Array;
};

/** The directory name a recording goes into when `VOICE_CAPTURE_DIR` names none. */
const CAPTURE_DIRECTORY_NAME = 'voice-capture';

/** Where the database lives when `DATABASE_PATH` names none — `server/load-env.ts`'s own default. */
const DEFAULT_DATABASE_FILE = '.cloudcli/auth.db';

/** The mode a recording directory is held at: owner-only, on the filesystem and not just on paper. */
const CAPTURE_DIR_MODE = 0o700;

/** The mode a recording file is held at: owner-only, for the same reason and by the same means. */
const CAPTURE_FILE_MODE = 0o600;

/**
 * The mode a raw `VOICE_CAPTURE` value names, and the warning it earns if it names none.
 *
 * THE ARGUMENT IS THE RAW VALUE, NOT `process.env`. Reading the variable here would put a second
 * reader of it somewhere other than the composition root, and "the environment is read exactly once
 * at start-up" is precisely the property this function exists to make checkable: the root reads it,
 * hands the text over, and everything downstream sees only the mode.
 *
 * Blank is the same reading as absent, which is the convention every other value this module's
 * deployment reads uses. A value that is neither blank, `off`, `text` nor `audio` is not a mode: it
 * reads as `off` AND earns a warning naming it, because a deployment whose variable is misspelled
 * would otherwise be silently off with nobody able to tell the two reasons apart.
 */
export function resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution {
  const value = raw === undefined ? '' : raw.trim();

  if (value === '' || value === 'off') {
    return { mode: 'off', warning: null };
  }
  if (value === 'text' || value === 'audio') {
    return { mode: value, warning: null };
  }

  return { mode: 'off', warning: voiceCaptureWarningLine(value) };
}

/**
 * The start-up line: the one line that says which mode the process actually came up in.
 *
 * It is a function of the mode rather than of the variable, so the line reports what the deployment
 * IS rather than what it was configured with — the two differ exactly when the value was
 * unrecognised, and there the warning line beside it says so.
 *
 * Consumed by `announceVoiceCapture` below, which is what the composition root calls, and by
 * `tests/voice-capture-off.test.ts`, which reads the line off THIS function rather than repeating
 * the text: a criterion that spelled the line itself would pass against a module whose producer had
 * stopped producing it.
 */
export function voiceCaptureStartupLine(mode: VoiceCaptureMode): string {
  return `voice.capture mode=${mode}`;
}

/**
 * The warning line an unrecognised value earns, naming the value.
 *
 * The value is quoted through `JSON.stringify`, which is what keeps the line exactly ONE line: a
 * variable pasted with a trailing newline, or with a stray quote, would otherwise either split the
 * reading in two or make the line unparseable — and a warning a reader cannot read in one line is
 * not a warning.
 *
 * Consumed by `announceVoiceCapture` below and by `tests/voice-capture-off.test.ts`, which compares
 * the announced warning against this function's own output for the same offending value.
 */
export function voiceCaptureWarningLine(value: string): string {
  return `voice.capture invalid value ${JSON.stringify(value)}; recording is off`;
}

/**
 * THE function the composition root calls: resolve the mode, say it, and hand it back.
 *
 * Reading the variable, deciding the mode, and writing the start-up line are one call on purpose.
 * Split across a root that reads and a root that decides, "the mode the process announced" and "the
 * mode the service records in" could drift apart, and the announcement would then be a description
 * of a configuration nothing used. Here the resolution the root announces IS the resolution it
 * injects.
 *
 * The warning goes through the same port as the start-up line and the attempt lines, so a deployment
 * that collects this process's structured output has one stream to read rather than two.
 */
export function announceVoiceCapture(raw: string | undefined, log: VoiceLogPort): VoiceCaptureResolution {
  const resolution = resolveVoiceCaptureMode(raw);

  log.info(voiceCaptureStartupLine(resolution.mode));
  if (resolution.warning !== null) {
    log.info(resolution.warning);
  }

  return resolution;
}

/**
 * What one raw `VOICE_CAPTURE_RAW` value resolves to.
 *
 * THE SHAPE MATCHES `VoiceCaptureResolution`'s on purpose and not by accident: raw capture is a
 * SECOND, INDEPENDENT switch whose value a deployment reads once at start-up, and a reader comparing
 * the two resolution functions should find the same three readings in both — off, on, and
 * not-recognised-earns-a-warning.
 */
export type VoiceCaptureRawResolution = {
  enabled: boolean;
  warning: string | null;
};

/**
 * The raw capture switch, resolved from its own variable with the mode resolver's fail-closed rule.
 *
 * WHY THIS IS A SECOND FUNCTION RATHER THAN `resolveVoiceCaptureMode`. The two switches answer
 * different questions — the mode picks WHERE an attempt goes (`off`/`text`/`audio`), and this one
 * says WHETHER the pre-VAD bytes the recogniser never saw are collected at all — so they have
 * different value sets and one is a boolean. What they SHARE is the discipline, and it is copied
 * deliberately: blank and `off` mean off, an unrecognised value means off AND earns a warning naming
 * it, and `THE ARGUMENT IS THE RAW VALUE, NOT process.env` so the composition root stays the one
 * reader of the environment. `1` is the one value that turns raw capture on.
 */
export function resolveVoiceCaptureRaw(raw: string | undefined): VoiceCaptureRawResolution {
  const value = raw === undefined ? '' : raw.trim();

  if (value === '' || value === 'off') {
    return { enabled: false, warning: null };
  }
  if (value === '1') {
    return { enabled: true, warning: null };
  }

  return { enabled: false, warning: voiceCaptureRawWarningLine(value) };
}

/**
 * The start-up line that says whether this process collects raw audio, and nothing else.
 *
 * A LINE OF ITS OWN rather than a clause on the mode line: the two switches are independent, and a
 * reader asking "did this deployment keep the pre-VAD audio" would otherwise have to parse a second
 * field out of a line whose subject is a different variable.
 */
export function voiceCaptureRawStartupLine(enabled: boolean): string {
  return `voice.capture.raw enabled=${enabled ? '1' : '0'}`;
}

/**
 * The warning an unrecognised `VOICE_CAPTURE_RAW` value earns, naming the value.
 *
 * The value is quoted through `JSON.stringify` for the same reason `voiceCaptureWarningLine`'s is: it
 * is what keeps the line exactly one line, so a variable pasted with a trailing newline cannot split
 * the reading in two.
 */
export function voiceCaptureRawWarningLine(value: string): string {
  return `voice.capture.raw invalid value ${JSON.stringify(value)}; raw capture is off`;
}

/**
 * The start-up line that names the directory recordings go into.
 *
 * WHY THE DIRECTORY IS ANNOUNCED AT ALL. Nothing deletes or rotates these files by design, so the
 * only thing that makes the growth VISIBLE is the line that says where it accumulates — without it
 * an operator wanting to know where the disk went would have to read this module's source to find
 * the default. The mode and the raw switch say WHAT is recorded; this says WHERE.
 */
export function voiceCaptureDirStartupLine(directory: string): string {
  return `voice.capture dir=${directory}`;
}

/**
 * Announces the raw switch: resolve it, say it (and warn), hand it back — `announceVoiceCapture`'s
 * exact shape for the second variable.
 *
 * Called from the composition root BESIDE `announceVoiceCapture` rather than folded into it, so the
 * mode announcement's output is unchanged byte for byte and a deployment that never sets
 * `VOICE_CAPTURE_RAW` gains exactly one line that reads `enabled=0`.
 */
export function announceVoiceCaptureRaw(
  raw: string | undefined,
  log: VoiceLogPort,
): VoiceCaptureRawResolution {
  const resolution = resolveVoiceCaptureRaw(raw);

  log.info(voiceCaptureRawStartupLine(resolution.enabled));
  if (resolution.warning !== null) {
    log.info(resolution.warning);
  }

  return resolution;
}

/**
 * The directory a recording goes into: the explicit setting when there is one, otherwise a directory
 * beside the database.
 *
 * THE INPUTS ARE ARGUMENTS, NOT `process.env`, for the same reason the mode's are: the composition
 * root is the one reader of the environment, and a resolver that read it itself could not be asked
 * what a given pair of values means without mutating the process first.
 *
 * "Beside the database" rather than "in the home directory" is what makes the default follow a
 * deployment that moved its data: a directory resolved from a literal home path would put recordings
 * somewhere other than the state they belong to, and would do it the moment `DATABASE_PATH` was set.
 * The fallback when `databasePath` names nothing is `server/load-env.ts`'s own default, so a
 * deployment that never set it gets the same answer here as there.
 *
 * This function only COMPUTES the path. Nothing creates the directory — the writer does, on the
 * first recording it actually writes — which is why a mode that writes no audio leaves no directory
 * behind even when one is configured.
 */
export function resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string {
  const explicit = raw === undefined ? '' : raw.trim();
  if (explicit !== '') {
    return explicit;
  }

  const database = databasePath === undefined || databasePath.trim() === ''
    ? path.join(os.homedir(), DEFAULT_DATABASE_FILE)
    : databasePath;
  return path.join(path.dirname(database), CAPTURE_DIRECTORY_NAME);
}

/**
 * The per-process-instance token an attempt id carries, derived from the process and NOT read here.
 *
 * THE INPUTS ARE ARGUMENTS, for the same reason `resolveVoiceCaptureDir`'s are: the composition root
 * is the one reader of the process's own identity, and a resolver that read `process.pid` itself could
 * not be asked what a given pair of values means without starting a process first. The root passes
 * `process.pid` and the instant the process came up, and this function only MIXES them.
 *
 * WHY BOTH INPUTS ARE NEEDED. A pid alone is not an instance: the kernel recycles pids, so two runs
 * minutes apart can carry the same one and would then mint the same id — the exact restart collision
 * this task removes. A start time alone is not either: two processes can start in the same millisecond.
 * Together they name an instance, and the pair is hashed rather than concatenated because a
 * concatenation is not injective (`pid=1,start=x2` and `pid=1x,start=2` would render alike) and the
 * output is a fixed-width token whose length does not grow with the clock.
 *
 * RENDERED BASE36, which is what makes the token usable inside a file name: the digits are
 * `[0-9a-z]`, all of which `captureFileName` leaves untouched, so the id survives the path-safe
 * substitution unchanged rather than being rewritten on its way to disk.
 *
 * SHIPPED BY THIS MODULE rather than by `server/shared/`, because it is the id scheme's own detail and
 * the id scheme lives here: a token defined in a shared module would be a name the composition root
 * and this factory both import from a third place, which is one more seam for the two to drift apart
 * across. The composition root and the criterion that measures the cross-process property both call
 * THIS function, so neither can spell the derivation themselves.
 */
export function resolveInstanceSalt(pid: number, startedAtMs: number): string {
  const digest = createHash('sha256').update(`${Math.trunc(pid)}:${Math.trunc(startedAtMs)}`).digest();
  return BigInt(`0x${digest.subarray(0, 6).toString('hex')}`).toString(36);
}

/**
 * The file name one attempt's recording goes into, built from the attempt's id and NOTHING ELSE.
 *
 * THE UPLOAD IS THE OBVIOUS SOURCE AND THE ONE THING THAT MUST NOT BE USED. A file name carried by a
 * request is a string the caller chose; joining it into a path is how a recording lands outside the
 * directory it was meant to be kept in, and "the path is inside the resolved directory" has to be a
 * property of how the name is built rather than a check someone remembers to run. `captureId` is
 * minted by this module (see `createVoiceCapture`), so a name built from it is already safe — and the
 * substitution below is the second lock on the same door, because `writeAudio` is a public seam whose
 * caller may hand it any string at all.
 *
 * THE SUFFIX IS FIXED. Deriving it from the upload's container would put a second, weaker copy of
 * `mime` next to the row's own field, and the two could then disagree — a file whose extension claims
 * a container the bytes are not in. The container is in the row, where a reader can see it.
 */
function captureFileName(captureId: string): string {
  return `${pathSafeStem(captureId)}.bin`;
}

/**
 * The characters a recording's file name may keep.
 *
 * THE ONE SUBSTITUTION both naming schemes share, extracted so the two cannot drift: the attempt
 * name and the raw name are held to the same path-safe alphabet, and a criterion reading one of them
 * reads the same rule the other is built with.
 */
function pathSafeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The stem (the name WITHOUT its `.bin` suffix) one listen's RAW upload goes into.
 *
 * `raw-` PREFIXES THE STEM so a raw file is distinguishable from a trimmed attempt file by name
 * alone, in the same directory and without opening either: an operator looking at the capture
 * directory can see the corpus footage and the recogniser's own input as two families. THE PREFIX
 * LIVES HERE AND NOWHERE ELSE — the sink's `writeRaw` builds its file name from this stem, and
 * `rawCaptureFileName` is this stem plus the fixed suffix — so a rename moves both at once and a
 * copy of the rule cannot drift from it.
 */
export function rawCaptureStem(listenId: string): string {
  return `raw-${pathSafeStem(listenId)}`;
}

/**
 * The file name one listen's RAW upload goes into, built from its `listenId` and NOTHING ELSE.
 *
 * The id is carried through the SAME path-safe substitution `captureFileName` uses — a second
 * alphabet here would be a second rule about what a file name may contain, and the two would drift
 * the first time one was tightened. The suffix is fixed for the reason `captureFileName`'s is: the
 * container is in the row, where a reader can see it, not in the name.
 *
 * Exported for the criteria that read a raw file back by the name the row carries.
 */
export function rawCaptureFileName(listenId: string): string {
  return `${rawCaptureStem(listenId)}.bin`;
}

/**
 * Writes one recording WITHOUT EVER DESTROYING A FILE THAT IS ALREADY THERE, and returns where it
 * actually landed.
 *
 * THE OPEN IS `wx`, and that is the whole mechanism: `O_EXCL` makes the create and the existence
 * check one indivisible step, so a file that exists at the moment of the open is refused rather than
 * truncated. A read-then-write ("does it exist? no → write") would have a window between the two in
 * which another process — the previous instance, a second one — creates the same path, and the write
 * would clobber it while believing the path was free. The kernel's own flag is the only form of this
 * that has no window.
 *
 * ON `EEXIST` THE WRITER GIVES WAY RATHER THAN THROWING. The id scheme (`resolveInstanceSalt`) makes
 * a collision across instances vanishingly unlikely, but "unlikely" is not "never" — a clock that
 * stepped backwards, a replayed id, a manually placed file — and the two available behaviours are not
 * symmetric. Throwing here would take the whole `recordAttempt` call down with it, so a recording
 * that could not find a free name would also destroy the ROW that names the attempt: the operator
 * would lose the index entry for a real transcription, which is worse than losing the bytes and is
 * exactly the failure `voice-capture-isolation` exists to forbid. So the writer walks `-2`, `-3`, …
 * until an open succeeds, and the caller — see `writeAudio` — returns THAT path, so the row names the
 * file that was actually written rather than the name that was refused. The sentinel that was already
 * there is left untouched, which is the property this function exists for.
 */
function writeExclusive(directory: string, fileName: string, bytes: Uint8Array): string {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);

  for (let ordinal = 1; ; ordinal += 1) {
    const target = path.join(
      directory,
      ordinal === 1 ? fileName : `${stem}-${ordinal}${extension}`,
    );
    try {
      // The bytes THEMSELVES, and exclusively. See this function's header for why the flag is here
      // rather than a prior existence check.
      writeFileSync(target, bytes, { flag: 'wx', mode: CAPTURE_FILE_MODE });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

/** What the shipping sink is built from: the directory its caller has already resolved. */
export type VoiceCaptureAudioSinkOptions = {
  /**
   * The directory recordings go into, RESOLVED BY THE CALLER — see `resolveVoiceCaptureDir`.
   *
   * A path handed in rather than read here, because the environment belongs to the composition root:
   * a sink that read `VOICE_CAPTURE_DIR` itself would be a second reader of a variable whose
   * "read exactly once" is the property that makes the mode and the directory checkable together.
   *
   * THIS IS NOT THE DIRECTORY, IT IS WHERE ONE WOULD GO. Nothing is created by building the sink —
   * see `writeAudio`, where the `mkdir` sits.
   */
  directory: string;
};

/**
 * The shipping audio sink: the write, the directory's creation, and the 0700/0600 that hold afterwards.
 *
 * THE PERMISSIONS ARE THE REASON THIS IS NOT THREE LINES OF OBVIOUS CODE. `mkdirSync`'s and
 * `writeFileSync`'s `mode:` is a REQUEST the kernel applies THROUGH the process's umask, so the
 * reading an operator gets depends on a process-wide setting that has nothing to do with recordings:
 * asked for 0600 under `umask 0o000` the file lands 0666. Each open is therefore followed by an
 * explicit `chmod` on the same path, which is what makes the file's mode a fact about the file rather
 * than about the shell that started the server. The `mode:` argument is kept as well, so the window
 * between open and chmod is not a window at all in the ordinary case.
 *
 * A file that is overwritten is re-chmod'ed, because `writeFileSync` on an EXISTING path keeps that
 * file's mode and would otherwise leave a file this sink did not create at whatever mode it had.
 */
export function createVoiceCaptureAudioSink(
  options: VoiceCaptureAudioSinkOptions,
): VoiceCaptureAudioSink {
  return {
    resolveDirectory(): string {
      return options.directory;
    },

    writeAudio(directory: string, captureId: string, audio: VoiceCaptureAudio): string {
      // THE DIRECTORY APPEARS HERE, on the first write that actually happens, and not when the sink
      // was built or when the mode was resolved: a deployment in a mode that writes nothing leaves no
      // directory behind even when one is configured, and that is a property of where this call sits.
      mkdirSync(directory, { recursive: true, mode: CAPTURE_DIR_MODE });
      chmodSync(directory, CAPTURE_DIR_MODE);

      // The exclusive create and the give-way naming are `writeExclusive`'s; what comes back is the
      // path the bytes actually landed at, so a collision reads as the `-2` suffix on the row rather
      // than as a file this write silently overwrote. See that function for why the guard is the
      // kernel's `O_EXCL` rather than a prior existence check.
      const target = writeExclusive(directory, captureFileName(captureId), audio.bytes);
      chmodSync(target, CAPTURE_FILE_MODE);

      return target;
    },

    // RAW RECORDINGS GO THROUGH THE SAME WRITE, which is why this is a delegation and not a second
    // copy of the block above. `writeAudio` names a file `<stem>.bin`, so a raw upload is that same
    // write with `rawCaptureStem(listenId)` carried as the stem: the directory's creation, the
    // exclusive create, the `-2/-3` give-way naming and the 0700/0600 are ONE implementation, and a
    // change to any of them lands on both kinds at once. The `mimeType`/`fileName` fields are unused
    // by the write — the row, not the file name, is where a container is recorded — so empty strings
    // say so.
    writeRaw(directory: string, listenId: string, bytes: Uint8Array): string {
      return this.writeAudio(directory, rawCaptureStem(listenId), {
        bytes,
        mimeType: '',
        fileName: '',
      });
    },
  };
}

/**
 * The host an address names, or the empty string when it names none.
 *
 * THE HOST, NOT THE ADDRESS. A `baseUrl` is a deployment's own setting and may carry a port, a path
 * or a query — none of which belongs in a row whose job is to say WHICH service answered. The
 * hostname is the part that names the service, and it is a reading rather than a redaction: nothing
 * is removed from it that a reader would want, and a credential has never been part of it.
 *
 * `''` rather than a throw for an unparseable address: the row is written on paths where the address
 * has already been refused (see the gates in `voice.service.ts`), and a recorder that threw there
 * would turn a refusal into a crash. The empty string is the honest answer to "which host" when the
 * configuration named no host at all.
 */
export function voiceCaptureHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * The digest a row carries in place of the upload: 64 lowercase hex characters of sha256.
 *
 * A DIGEST AND NOT THE BYTES, which is the whole reason it is here. A recording is the one thing on
 * this path that must never reach a log line, and a row that carried the upload — in any encoding —
 * would be a copy of a user's voice in the process's output. The hash answers the question a reader
 * actually asks of a row ("is the thing that was sent the thing I think it was") without being
 * replayable, and it is computed over the SAME buffer the adapter was handed rather than a
 * re-encoding of it, so the answer is about the bytes that were sent.
 */
export function voiceCaptureSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The longest prefix of `source` that is a whole number of UTF-8 characters and at most `limit` bytes.
 *
 * WHY NOT SIMPLY THE FIRST `limit` BYTES. Cutting a multi-byte character in half produces a string
 * that is not text, and re-encoding it does not give back the bytes it came from (the dangling lead
 * byte becomes U+FFFD, three bytes where there was one), so a row could end up carrying MORE than the
 * limit it was cut to. Backing off to the last character boundary keeps the two properties that
 * matter: the body is a prefix of the original — never a splicing of two parts of it — and its length
 * in bytes is never above the limit. For the ASCII-bodied JSON a chat service answers with, the
 * boundary is the limit itself.
 */
function utf8PrefixAtMost(source: Buffer, limit: number): string {
  for (let end = limit; end > 0; end -= 1) {
    const text = source.subarray(0, end).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') === end) {
      return text;
    }
  }
  return '';
}

/**
 * One raw answer as the row carries it: verbatim while it fits, a flagged prefix past the limit.
 *
 * THE TWO HALVES ARE ONE CALL because they are one decision. A caller that took the body and the
 * flag from two places would eventually write a body it had not cut beside a flag that said it had,
 * and the row would then be wrong about the only thing it is for. The limit is
 * `RAW_RETURN_LIMIT_BYTES`, and "fits" is measured in UTF-8 bytes rather than in characters, because
 * bytes are what a log line costs.
 */
export function truncateVoiceCaptureReturn(rawReturn: VoiceCaptureRawReturn): VoiceCaptureUpstream {
  const bytes = Buffer.from(rawReturn.body, 'utf8');
  if (bytes.length <= RAW_RETURN_LIMIT_BYTES) {
    return { status: rawReturn.status, body: rawReturn.body };
  }
  return {
    status: rawReturn.status,
    body: utf8PrefixAtMost(bytes, RAW_RETURN_LIMIT_BYTES),
    // `true` and never `false`: the key is present exactly when something was cut. See
    // `VoiceCaptureUpstream` for why the two are not interchangeable.
    truncated: true,
  };
}

/**
 * Which of the six branches one attempt's outcome is.
 *
 * TOTAL BY CONSTRUCTION: every combination of the four scalars reaches one of the six, and the order
 * below is the reason why. Success is decided first, and it is decided by `writtenFallback` alone —
 * the fact the adapter records precisely on the degraded path (`meta.writtenFallback: 1`), so the two
 * successful branches are told apart by the adapter's own reading rather than by re-parsing the
 * answer. Among failures, `NO_SPEECH_DETECTED` is asked first because it is the one failure that
 * arrives on a 2xx answer: asked later, it would be caught by the envelope test below and reported as
 * a malformed answer instead of as silence. The envelope test itself needs BOTH halves of its name —
 * `UPSTREAM_UNAVAILABLE` is the adapter's word for "I could not use what came back", and a 2xx
 * status is what makes that a malformed ANSWER rather than a refusal — so a 404 carrying the same
 * code falls through to the transport test below and is reported as what it is.
 *
 * The last two are decided by whether a request ever left the process, which is why `requestSent` is
 * an input rather than something the builder infers: an attempt refused before the transport never
 * sent anything, and an attempt whose request went out is an upstream failure whether or not an
 * answer came back readable. `upstream` is still an input, because the envelope test needs the status
 * the answer arrived with — a 2xx carrying the adapter's "I could not use this" is a malformed answer,
 * while the same code on a 4xx is the upstream refusing.
 */
export function voiceCaptureBranch(input: {
  ok: boolean;
  code?: string;
  writtenFallback?: number;
  upstream: VoiceCaptureRawReturn | null;
  requestSent: boolean;
}): VoiceCaptureBranch {
  if (input.ok) {
    return input.writtenFallback === undefined ? 'written' : 'verbatim-fallback';
  }
  if (input.code === 'NO_SPEECH_DETECTED') {
    return 'no-speech';
  }
  if (input.code === 'UPSTREAM_UNAVAILABLE' && input.upstream !== null && input.upstream.status < 400) {
    return 'envelope-error';
  }
  return input.requestSent ? 'upstream-failure' : 'preflight-refused';
}

/**
 * THE payload builder: the one place a row's payload is decided.
 *
 * Every field is computed here from the narrowed input and nowhere else, so a caller that wants
 * something in a row has to put it in the input — which is what makes an added field a change to this
 * function rather than an edit at a call site. The two fields that need care are the two that could
 * be a disclosure: `sha256` is a digest of the upload and never the upload, and `upstream` is the
 * answer that came back, which is on the receiving side of the request and therefore cannot contain
 * anything this process sent. The upload itself reaches a row only as `bytes` and `sha256`.
 */
export function buildVoiceCapturePayload(input: VoiceCapturePayloadInput): VoiceCapturePayload {
  return {
    model: input.model,
    host: voiceCaptureHost(input.baseUrl),
    mime: input.audio.mimeType,
    bytes: input.audio.bytes.length,
    sha256: voiceCaptureSha256(input.audio.bytes),
    upstream: input.upstream === null ? null : truncateVoiceCaptureReturn(input.upstream),
    branch: voiceCaptureBranch({
      ...input.reading,
      upstream: input.upstream,
      requestSent: input.requestSent,
    }),
    text: input.reading.text,
  };
}

/** What the port factory needs: the mode it was resolved to, where rows go, and the audio sink. */
export type VoiceCaptureDependencies = {
  mode: VoiceCaptureMode;
  log: VoiceLogPort;
  /**
   * The token that makes an attempt id unique ACROSS PROCESS INSTANCES, not merely within one.
   *
   * RESOLVED BY THE COMPOSITION ROOT AND HANDED IN, never read here — the module reads no `process`
   * for the same reason it reads no environment: the root is the one place that knows which process
   * instance it is, and a factory that reached for `process.pid` itself would be a second reader of a
   * fact whose "read once at start-up" is what makes the ids checkable. See `resolveInstanceSalt`,
   * which is the pure function the root calls and this criterion shares.
   *
   * WHY IT IS REQUIRED AND NOT DEFAULTED. The id this factory mints names a file that OUTLIVES the
   * process (see `resolveVoiceCaptureDir`), so an id that is unique only within one process is an id
   * that collides with a previous run's the moment the deployment restarts — and the collision
   * overwrites a recording. A default would let a caller omit the one field the whole seam rests on
   * and get the pre-fix behaviour silently, which is the defect rather than a fallback; the field is
   * therefore required, and the only shipping caller is the composition root.
   */
  instanceSalt: string;
  /**
   * The audio half of the seam, when this deployment has one.
   *
   * Absent means `audio` mode records its attempt rows and writes nothing to disk. That is this
   * module's shipping shape today: the file write, its permissions and the injected writer are the
   * audio half's own delivery, and a mode whose writer is absent writes nothing rather than writing
   * somewhere nobody chose.
   */
  audio?: VoiceCaptureAudioSink;
  /**
   * Whether this deployment collects raw (pre-VAD) audio, from `VOICE_CAPTURE_RAW`.
   *
   * ABSENT READS AS OFF, so every existing caller — the criteria that build a port to record attempt
   * rows, a deployment assembled before the raw switch existed — keeps writing no raw audio. The
   * composition root supplies it from `resolveVoiceCaptureRaw`'s own answer.
   */
  raw?: boolean;
};

/**
 * Builds the recording port for one resolved mode.
 *
 * THE ID IS TWO SCOPES STAPLED TOGETHER, and both are load-bearing. The `instanceSalt` names the
 * PROCESS INSTANCE, so two runs of the same deployment — a restart — mint different ids and therefore
 * different file names even if their in-process sequences agree; the sequence names the attempt WITHIN
 * that instance, so two attempts in one run never share one. A single scope would fail on the other's
 * side of a restart: a sequence alone collides the moment the process comes up again (the defect this
 * replaces), and a salt alone would collide between two attempts of one run. The composition root
 * supplies the salt (see the field on `VoiceCaptureDependencies`) and this factory mints the sequence,
 * so neither half is spelled twice.
 *
 * The three facts a recording rests on still hold without a clock, a random source or a hash of the
 * upload: two attempts never share an id, an id is stable once minted, and the SAME id appears on the
 * attempt line and in the row.
 *
 * `recordAttempt` is the single place a row is ever built. A second construction point — in the
 * service, in a route, in a test — would be a second answer to "what is in a capture row", and the
 * two would drift the first time a field was added.
 */
export function createVoiceCapture(dependencies: VoiceCaptureDependencies): VoiceCapturePort {
  let sequence = 0;
  // Read once, at construction: the switch is a property of the deployment, so a value re-read per
  // call could change what is recorded halfway through a listen. See `recordRaw`.
  const rawEnabled = dependencies.raw === true;

  return {
    mode: dependencies.mode,
    raw: rawEnabled,
    newAttemptId(): string {
      sequence += 1;
      return `${dependencies.mode}-${dependencies.instanceSalt}-${sequence.toString(36)}`;
    },
    recordAttempt(captureId: string, attempt: VoiceCaptureAttempt): void {
      // The row: the fields that name the attempt, and the payload when this attempt carries one. The
      // payload is BUILT here from the narrowed input rather than taken ready-made, so the set of
      // fields a row can have is decided by `buildVoiceCapturePayload` and nowhere else — a caller
      // cannot add one by putting it in the object it hands over, because what it hands over is the
      // INPUT and not the row. An attempt that carries no payload writes the row this port has always
      // written, byte for byte.
      const row: Record<string, unknown> = {
        event: VOICE_CAPTURE_EVENT,
        captureId,
        providerId: attempt.providerId,
        outcome: attempt.outcome,
        status: attempt.status,
      };
      if (attempt.payload !== undefined) {
        Object.assign(row, buildVoiceCapturePayload(attempt.payload));
      }
      // The pairing id, and ONLY when the request carried one: a row from a request that named none
      // has no `listenId` key at all rather than an empty one, so a reader can tell "not paired" from
      // "paired with an empty id" — which is the same absence-not-placeholder rule `truncated` and
      // `path` follow.
      if (attempt.listenId !== undefined) {
        row.listenId = attempt.listenId;
      }

      // The audio write, and only in the mode that asked for it. The directory is resolved HERE
      // rather than at construction, so no mode that writes nothing ever resolves one.
      //
      // THE WRITE COMES BEFORE THE ROW, and the order is the row's `path` field: the path a reader is
      // handed has to be one they could have opened at the moment they read it, and a row written
      // first would name a file that did not exist yet — or, on a write that failed, one that never
      // existed at all. What is deferred is the ROW, not the attempt line: that one went out above,
      // with this attempt's id, so the two things a reader sees about one attempt are still in the
      // order the seam promises.
      //
      // `path` is written HERE rather than by `buildVoiceCapturePayload` because it is the one field
      // the sink decides: the builder is a function of the narrowed input and the writer is not part
      // of that input, which is also why a `text` deployment's rows have no `path` key at all — not
      // an empty one, not a null one.
      if (dependencies.mode === 'audio' && dependencies.audio !== undefined) {
        row.path = dependencies.audio.writeAudio(
          dependencies.audio.resolveDirectory(),
          captureId,
          attempt.audio,
        );
      }

      // One line, serialised once. `JSON.stringify` at the construction point rather than at the log
      // port is what keeps the row single-line and parseable no matter which port a deployment wired.
      dependencies.log.info(JSON.stringify(row));
    },

    recordRaw(input: VoiceCaptureRawInput): void {
      // THE SWITCH IS READ HERE, not only by the service above: an off deployment resolves no
      // directory and touches no file even if a caller reached this method past the service's own
      // gate. This is the second lock on the same door and the one the "no directory is created"
      // promise actually rests on, because it is the side that would have to resolve the path.
      if (!rawEnabled) {
        return;
      }

      // The row: the pairing id, the upload's length, its digest, and — when a sink is wired — where
      // the bytes landed. `sha256` is a digest of the upload and never the upload, exactly as the
      // trimmed row's is: a raw recording is strictly MORE sensitive than a trimmed one (it is the
      // audio a VAD deliberately removed), so the same rule that keeps bytes out of the log applies
      // here without exception.
      const row: Record<string, unknown> = {
        event: VOICE_CAPTURE_RAW_EVENT,
        listenId: input.listenId,
        bytes: input.bytes.length,
        sha256: voiceCaptureSha256(input.bytes),
      };

      // The file, and only when this port has a sink that can write one. The directory is resolved
      // HERE rather than at construction, so a deployment that never records raw creates none — the
      // same structural property `recordAttempt` has for the trimmed write.
      if (dependencies.audio?.writeRaw !== undefined) {
        row.path = dependencies.audio.writeRaw(
          dependencies.audio.resolveDirectory(),
          input.listenId,
          input.bytes,
        );
      }

      dependencies.log.info(JSON.stringify(row));
    },
  };
}
