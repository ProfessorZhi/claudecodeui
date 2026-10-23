#!/usr/bin/env python3
"""The SenseVoice-Small recogniser, as a subprocess that speaks JSON lines.

WHY A SUBPROCESS AND NOT A NODE BINDING. The recogniser this task deploys is a *patched*
sherpa-onnx: the CTC posteriors and the frame log-probability matrix only exist in a build carrying
`sv-logprobs-v1.13.8.patch`, and no published Node binding is built against it. Python is where the
patched build is, so Python is where the recogniser runs; the Node side owns the process, not the
model.

THE PROTOCOL, in full, because it is the whole interface between the two languages:

  · On start-up the worker writes exactly one line:
        {"type":"ready","buildId":...,"engineVersion":...,"capabilityMarker":...,
         "modelSha256":...,"tokensSha256":...,"sampleRate":16000}
    Everything in it is a fact the manager re-checks against `manifest.json` before the engine is
    declared available, which is what makes "the deployment's build artifacts are the experiment's"
    a checked property rather than a hope. The digests are computed here, on the way past, because
    this process has to read both files in order to load them: reporting what it read costs nothing,
    while hashing them again on the Node side would cost a start-up read of the whole model.
  · Then, per line of stdin, one request and exactly one line of stdout:
        {"id":<any>,"audio":"<base64>","format":"wav"}
    answered by
        {"id":<any>,"ok":true,"text":...,"tokens":[{"text":..,"confidence":..,"startMs":..}],
         "buildId":...,"model":...,"latencyMs":...,"durationMs":...}
    or
        {"id":<any>,"ok":false,"code":"AUDIO_REJECTED"|"UPSTREAM_UNAVAILABLE","message":...}
  · A start-up failure writes `{"type":"fatal","code":...,"message":...}` and exits non-zero, so the
    manager reports a stable code instead of "the process died".

EVERY FIELD OF A TOKEN IS THE PATCHED RUNTIME'S OWN OUTPUT, and nothing here re-derives it from a
second front end. `confidence` is `exp(log_prob)` of the token the decoder emitted and `startMs` is
that token's timestamp, converted from the seconds sherpa reports to milliseconds; a token's text is
the recogniser's own string, `<|...|>` language/emotion/event markers dropped (they are prefix
metadata, not speech). `text` is `result.text` verbatim — the same string the offline corpus in
`tc-verify/corpus/voice-index-loop/sv2/sv.jsonl` recorded, which is what lets the adapter's answer be
compared to it character for character.

NOTHING HERE IS ASYNC AND NOTHING HERE IS CONCURRENT. The manager owns concurrency (it runs at most
`concurrency` requests at a time); one worker answers one request at a time, in the order it arrives.
That is deliberate: the session and the recognizer are not re-entrant, and moving either into a
thread pool would be this file inventing a concurrency guarantee the runtime does not make.
"""

import base64
import hashlib
import json
import math
import os
import sys
import tempfile
import time

# `SHERPA_ONNX_DUMP_LOG_PROBS` IS DELIBERATELY NOT SET, and this is a measurement rather than a
# preference. The patched runtime has two additions: `token_log_probs`, which the greedy decoder
# always fills (the Python binding surfaces it as `ys_log_probs`), and `frame_log_probs`, the whole
# `[frames, vocab]` matrix, which the runtime only materialises when that variable is set. This
# worker reads the first and never the second, and the two were measured to give the same text: the
# offline corpus was produced with the variable set, and the five-clip comparison in
# `voice-sensevoice-real.test.ts` reads the same strings with it unset. Leaving it unset is what
# keeps a decode from copying a matrix of tens of megabytes per request.

# The engine this worker requires. A different sherpa-onnx may load the same model and answer
# *slightly different* text and confidences — that is the whole reason the build is pinned.
PATCHED_ENGINE_VERSION = '1.13.8'
# The marker the manager checks against the manifest's `engine.capabilityMarker`. It names the
# capability, not the patch file: what matters at runtime is that `ys_log_probs` exists, and the
# probe below is the actual reading. The literal is what ties that reading to the pinned build.
CAPABILITY_MARKER = 'sv-logprobs-v1'

SAMPLE_RATE = 16000
# Seconds per output frame of the SenseVoice CTC head. Used only to derive the frame index for the
# log line; `startMs` is the timestamp converted directly.
FRAME_SECONDS = 0.06

MODEL_FILE = 'model.int8.onnx'
TOKENS_FILE = 'tokens.txt'

# What the recogniser is asked for, verbatim from the reference run that produced the corpus.
NUM_THREADS = 4
USE_ITN = True
LANGUAGE = 'auto'


def emit(payload):
    """One line of stdout, flushed. The manager reads this stream line by line, so a buffered
    write would look like a hang."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def fatal(message, code='UPSTREAM_UNAVAILABLE'):
    emit({'type': 'fatal', 'code': code, 'message': message})
    sys.exit(2)


def sha256_file(path):
    """The file's digest, read in chunks: the model is a quarter of a gigabyte and this must not
    be the moment the worker's resident set doubles."""
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_audio(payload, hint):
    """Decode the uploaded bytes to mono float32 at 16 kHz.

    TWO PATHS, and the second is not a fallback for convenience: the browser records `audio/webm`,
    a container libsndfile does not read, so a deployment whose only path were soundfile would
    refuse exactly the audio this feature exists to transcribe. ffmpeg is what the reference run
    used for the same reason; the temporary file is written and removed within the call.
    """
    import numpy as np
    import soundfile as sf

    raw = base64.b64decode(payload)
    suffix = '.' + (hint or 'wav').lstrip('.').lower()

    try:
        samples, rate = sf.read(io_bytes(raw), dtype='float32')
    except Exception:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as source:
            source.write(raw)
            source_path = source.name
        target_path = source_path + '.16k.wav'
        try:
            import subprocess
            subprocess.run(
                ['ffmpeg', '-y', '-loglevel', 'error', '-i', source_path,
                 '-ac', '1', '-ar', str(SAMPLE_RATE), target_path],
                check=True,
            )
            samples, rate = sf.read(target_path, dtype='float32')
        finally:
            for path in (source_path, target_path):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    samples = np.asarray(samples, dtype='float32')
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        import subprocess
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as source:
            sf.write(source.name, samples, rate)
            source_path = source.name
        target_path = source_path + '.16k.wav'
        try:
            subprocess.run(
                ['ffmpeg', '-y', '-loglevel', 'error', '-i', source_path,
                 '-ac', '1', '-ar', str(SAMPLE_RATE), target_path],
                check=True,
            )
            samples, _ = sf.read(target_path, dtype='float32')
        finally:
            for path in (source_path, target_path):
                try:
                    os.unlink(path)
                except OSError:
                    pass
    return np.ascontiguousarray(samples, dtype='float32')


def io_bytes(raw):
    import io
    return io.BytesIO(raw)


def tokens_of(result):
    """The recogniser's own token list, in the shape the wire carries.

    THE ZIP IS THE CONTRACT: `tokens`, `ys_log_probs` and `timestamps` are three parallel arrays
    from ONE decode, and pairing them by index is the only reading that keeps a token's confidence
    attached to that token. A `confidence` is `exp(log_prob)` because the patched build dumps
    log-probabilities (they are the numerically stable form the decoder works in); exponentiating
    here, once, is what puts the value in the `(0, 1]` interval the contract declares.
    """
    tokens = list(result.tokens)
    log_probs = list(result.ys_log_probs)
    timestamps = list(result.timestamps)
    out = []
    for text, log_prob, stamp in zip(tokens, log_probs, timestamps):
        if text.startswith('<|'):
            # The language / event / emotion / text-normalisation markers the SenseVoice head emits
            # as the first frames. They are metadata about the utterance, not words in it, and the
            # corpus this worker is verified against drops them at the same place.
            continue
        out.append({
            'text': text,
            'confidence': round(float(math.exp(float(log_prob))), 4),
            # `timestamps` are seconds; the contract's `startMs` is milliseconds.
            'startMs': int(round(float(stamp) * 1000.0)),
        })
    return out


def probe_capability(recognizer):
    """Decode half a second of silence and read the patched fields off the result.

    WHY A REAL DECODE AND NOT `hasattr(sherpa_onnx, ...)`: the patch adds fields to the *result
    object*, which only exists after a decode, so an attribute check on the module answers a
    different question about a different object.

    TWO READINGS, and the second is the one that does not depend on what the model happens to say.
    `frame_log_probs` is a field the patch added to the decoder result and the stock binding has no
    property for at all, so its presence is a structural fact about the build in use.
    `len(ys_log_probs) == len(tokens)` is the behavioural one: the stock binding declares
    `ys_log_probs` and leaves it empty (measured: two tokens, zero log-probs), so a build that
    merely *has* the field still fails this. Neither reading is about the token count — a build
    whose silence decodes to nothing must not be reported as an unpatched one — which is why the
    length test compares two arrays rather than asserting either is non-empty.

    A build failing either reading raises, and the caller turns that into a start-up failure: the
    engine is unavailable at boot rather than half-working on a user's upload.
    """
    import numpy as np
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    recognizer.decode_stream(stream)
    result = stream.result
    if not hasattr(result, 'frame_log_probs'):
        raise RuntimeError('result carries no frame_log_probs: this is the unpatched binding')
    log_probs = list(result.ys_log_probs)
    tokens = list(result.tokens)
    if len(log_probs) != len(tokens):
        raise RuntimeError(
            'ys_log_probs has %d entries for %d tokens: the decoder is not filling them'
            % (len(log_probs), len(tokens))
        )
    return True


def main():
    model_dir = os.environ.get('SENSEVOICE_MODEL_DIR', '').strip()
    if not model_dir:
        fatal('SENSEVOICE_MODEL_DIR is not set.', 'ENGINE_UNAVAILABLE')
    if not os.path.isdir(model_dir):
        fatal('SENSEVOICE_MODEL_DIR is not a directory: %s' % model_dir, 'ENGINE_UNAVAILABLE')

    model_path = os.path.join(model_dir, MODEL_FILE)
    tokens_path = os.path.join(model_dir, TOKENS_FILE)
    for path in (model_path, tokens_path):
        if not os.path.isfile(path):
            fatal('model file missing: %s' % path, 'ENGINE_UNAVAILABLE')

    try:
        import sherpa_onnx
    except Exception as error:  # pragma: no cover - environment failure, reported not raised
        fatal('cannot import sherpa_onnx: %s' % error, 'ENGINE_UNAVAILABLE')

    version = getattr(sherpa_onnx, '__version__', '')
    if version != PATCHED_ENGINE_VERSION:
        fatal(
            'sherpa-onnx %s is installed but this engine is pinned to the patched %s build.'
            % (version or '(unknown)', PATCHED_ENGINE_VERSION),
            'ENGINE_UNAVAILABLE',
        )

    try:
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=model_path,
            tokens=tokens_path,
            num_threads=NUM_THREADS,
            use_itn=USE_ITN,
            language=LANGUAGE,
        )
        probe_capability(recognizer)
    except Exception as error:
        fatal(
            'this sherpa-onnx build does not expose CTC log-probabilities (%s); '
            'install the build produced by scripts/sensevoice/README.md.' % error,
            'ENGINE_UNAVAILABLE',
        )

    model_sha256 = sha256_file(model_path)
    # BOTH PINNED FILES ARE DIGESTED AND REPORTED, not just the weights. The manager holds each
    # digest against `manifest.json`, and the token table is as much a part of "which recogniser
    # produced this text" as the weights are: a different `tokens.txt` spells the same acoustic
    # output differently. Reporting it here costs a 315 KB read and removes the need for the Node
    # side to hash a quarter of a gigabyte at start-up.
    tokens_sha256 = sha256_file(tokens_path)

    # The build id is DERIVED, never configured: it names the engine version, the exact model
    # weights and the capability, so two hosts that report the same id are running the same
    # recogniser. The manager compares it to the manifest's literal, and a mismatch is what turns
    # "a slightly different build" from a silent change in the text into an unavailable engine.
    build_id = 'sensevoice-%s-%s-%s' % (
        PATCHED_ENGINE_VERSION,
        model_sha256[:12],
        CAPABILITY_MARKER,
    )

    emit({
        'type': 'ready',
        'buildId': build_id,
        'engineVersion': version,
        'capabilityMarker': CAPABILITY_MARKER,
        'modelSha256': model_sha256,
        'tokensSha256': tokens_sha256,
        'model': MODEL_FILE,
        'sampleRate': SAMPLE_RATE,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
        except Exception as error:
            emit({'id': None, 'ok': False, 'code': 'AUDIO_REJECTED',
                  'message': 'malformed request line: %s' % error})
            continue

        if request.get('op') == 'shutdown':
            return 0

        started = time.time()
        try:
            samples = load_audio(request.get('audio', ''), request.get('format'))
        except Exception as error:
            emit({'id': request_id, 'ok': False, 'code': 'AUDIO_REJECTED',
                  'message': 'cannot decode audio: %s' % error})
            continue

        try:
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            recognizer.decode_stream(stream)
            result = stream.result
            text = result.text
            tokens = tokens_of(result)
        except Exception as error:
            emit({'id': request_id, 'ok': False, 'code': 'UPSTREAM_UNAVAILABLE',
                  'message': 'decode failed: %s' % error})
            continue

        emit({
            'id': request_id,
            'ok': True,
            'text': text,
            'tokens': tokens,
            'buildId': build_id,
            'model': MODEL_FILE,
            'durationMs': int(round(len(samples) / SAMPLE_RATE * 1000.0)),
            'latencyMs': int(round((time.time() - started) * 1000.0)),
        })

    return 0


if __name__ == '__main__':
    sys.exit(main())
