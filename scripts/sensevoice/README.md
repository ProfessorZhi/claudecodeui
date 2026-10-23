# `sensevoice-local` — the on-host recogniser

Three files live here and nothing else: the worker that runs the model, the manifest that pins which
build of it this repository's readings were taken on, and this note. **No model weights and no
compiled artifacts are in the repository**, on purpose — `model.int8.onnx` is 239 MB and a built
`sherpa_onnx` wheel is architecture-specific. What is in the repository is the patch that makes the
build capable, the hashes that identify the artifacts, and the code that runs them.

## What the patch adds, and why it is required

Stock `sherpa-onnx` gives a recogniser one transcript and no way to say how sure it was of any part
of it. `sv-logprobs-v1.13.8.patch` adds two fields to `OfflineCtcDecoderResult`:

| field | filled | surfaced to Python as |
| --- | --- | --- |
| `token_log_probs` | always, by the greedy decoder | `ys_log_probs` |
| `frame_log_probs`, `frame_log_probs_dim` | only when `SHERPA_ONNX_DUMP_LOG_PROBS=1` | `frame_log_probs` |

The **stock PyPI wheel is not a substitute and cannot be made into one at run time.** It declares a
`ys_log_probs` property and leaves it empty — a silence decode yields two tokens and zero log-probs —
and it has no `frame_log_probs` property at all. Those two asymmetries are exactly what
`worker.py`'s `probe_capability` reads: the missing property is the structural reading and the
length mismatch is the behavioural one, and neither depends on what the model happens to say. A
build failing either raises at start-up, so a mis-provisioned host reports `ENGINE_UNAVAILABLE` at
boot instead of returning a transcript with no confidences on a user's upload.

`SHERPA_ONNX_DUMP_LOG_PROBS` is deliberately **not** set by the worker: it controls only the
`[frames, vocab]` matrix, which this adapter never reads, and materialising it costs tens of
megabytes per request. The offline corpus was produced with the variable set and the deployment runs
without it; the five-clip comparison in `server/modules/voice/tests/voice-sensevoice-real.test.ts`
is the measurement that the two agree.

## Building the patched runtime

`experiments/voice-index-loop/sherpa-patch/build.sh` is the script. It applies
`sv-logprobs-v1.13.8.patch` to the sherpa-onnx 1.13.8 source and builds the Python package. The
build is architecture-specific and is **not** installed into the interpreter `python3` resolves to;
it is reached by putting its build directory on `PYTHONPATH`.

## Configuration

Read once, in `server/modules/voice/voice.module.ts` — the composition root, following the same rule
every other `VOICE_*` variable in that file follows.

| variable | meaning | absent |
| --- | --- | --- |
| `SENSEVOICE_MODEL_DIR` | directory holding `model.int8.onnx` and `tokens.txt` | engine unavailable |
| `SENSEVOICE_PYTHON` | interpreter the worker is spawned with | falls back to `python3` |
| `SENSEVOICE_PYTHONPATH` | prepended to the worker's `PYTHONPATH`, for a patched build outside site-packages | inherited `PYTHONPATH` only |
| `SENSEVOICE_CONCURRENCY` | how many requests one worker serves at once | 2 |

A host that wires nothing pays nothing: the engine is only spawned when a request selects
`sensevoice-local`, and `GET /api/voice/health` reports `ENGINE_UNAVAILABLE` with the reason rather
than starting anything.

## Layout on a provisioned host

```
$SENSEVOICE_MODEL_DIR/
  model.int8.onnx      sha256 c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
  tokens.txt           sha256 f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
```

Both hashes are in `manifest.json`, and the manager refuses to declare the engine available when
either disagrees — a different build of the same model answers *slightly* different text with
*slightly* different confidences, which is why the identity is checked rather than assumed.

## Checking it by hand

```
SENSEVOICE_MODEL_DIR=<dir> \
SENSEVOICE_PYTHONPATH=/path/to/patched/sherpa-onnx/build/lib.linux-x86_64-cpython-312 \
  python3 scripts/sensevoice/worker.py
```

It prints one `{"type":"ready",...}` line and then answers one JSON request per line of stdin, so it
can be driven by hand without the TypeScript side. The `buildId` in that line is what
`manifest.json`'s `buildId` must equal.
