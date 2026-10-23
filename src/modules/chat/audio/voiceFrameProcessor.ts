/**
 * The audio-thread half of streaming VAD: an `AudioWorkletProcessor` that frames the live
 * microphone stream into 20 ms windows and drives the shared streaming detector frame by frame,
 * one frame behind the audio rather than after the recording has ended.
 *
 * The decision itself is not here. This file owns only what has to run on the audio thread —
 * the frame accumulator and the port out — and calls `StreamingVad` from
 * `@/shared/voiceEndpoint`, which is the same object the batch trim path's thresholds come from.
 * A second copy of the state machine living in a worklet is exactly the drift the shared module
 * exists to prevent, so the worklet imports it.
 *
 * Used by `src/modules/chat/hooks/useVoiceInput.ts` to run the detector beside a recording; the
 * recording's upload path is unchanged, and a browser without `AudioWorklet` simply skips it.
 *
 * That hook loads THIS file through `voiceFrameProcessorUrl` in the sibling
 * `voiceFrameProcessorUrl.ts` — the URL has to come from the bundler's own build of this entry, not
 * from `import.meta.url` over the source path, and the import that asks for it cannot sit here
 * without this file's own build containing its trigger.
 */

import { StreamingVad, type StreamingVadOptions, type VadEvent, type VoiceSegment } from '@/shared/voiceEndpoint';

/**
 * The AudioWorkletGlobalScope's base class, resolved at *runtime* rather than named at module
 * scope.
 *
 * Naming `AudioWorkletProcessor` in an `extends` clause would evaluate it the moment this module
 * is imported — and this module is imported by `useVoiceInput` on the main thread and by the
 * jsdom unit tests, where the global does not exist, so the import itself would throw. The
 * lookup below falls back to an inert base for those environments; in the worklet the real class
 * is present and the fallback is never used.
 */
type ProcessorBase = new () => { port: MessagePort };
const ProcessorBase: ProcessorBase =
  (globalThis as unknown as { AudioWorkletProcessor?: ProcessorBase }).AudioWorkletProcessor ??
  (class {
    port = { onmessage: null, postMessage() {} } as unknown as MessagePort;
  } as unknown as ProcessorBase);

/** The name the processor registers under; the main thread addresses the node by it. */
export const VOICE_FRAME_PROCESSOR_NAME = 'voice-frame-processor';

/** Messages the processor posts to the main thread. */
export type VoiceFrameMessage =
  | { type: 'frame'; rms: number; atSample: number }
  | { type: 'pcm'; samples: Float32Array; atSample: number }
  | { type: 'event'; event: VadEvent }
  | { type: 'segments'; segments: VoiceSegment[] };

/** Options the main thread hands the processor through `AudioWorkletNode`. */
export type VoiceFrameProcessorOptions = {
  /** The context's sample rate, passed explicitly because the worklet global is untyped here. */
  sampleRate: number;
  vad?: Omit<StreamingVadOptions, 'sampleRate'>;
};

/** The 20 ms frame the detector works in, in seconds. */
const FRAME_SEC = 0.02;

class VoiceFrameProcessor extends ProcessorBase {
  private readonly vad: StreamingVad;
  private readonly frameSize: number;
  private pending: Float32Array;
  private pendingCount = 0;
  private framesAt = 0;

  constructor(options: { processorOptions?: VoiceFrameProcessorOptions }) {
    super();
    const sampleRate = options?.processorOptions?.sampleRate ?? 48_000;
    this.frameSize = Math.max(1, Math.round(FRAME_SEC * sampleRate));
    this.pending = new Float32Array(this.frameSize);
    this.vad = new StreamingVad({ sampleRate, ...options?.processorOptions?.vad });
    // The main thread asks for the segments when the stream ends; the detector's own `flush`
    // is what turns the frame decisions into upload-sized boundaries.
    this.port.onmessage = (message: MessageEvent) => {
      if ((message.data as { type?: string } | null)?.type !== 'flush') return;
      this.port.postMessage({ type: 'segments', segments: this.vad.flush() } satisfies VoiceFrameMessage);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    // Keep the graph alive even while the input is momentarily absent.
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.pending[this.pendingCount++] = input[i];
      if (this.pendingCount < this.frameSize) continue;
      this.pendingCount = 0;
      // A copy, because `pending` is reused for the next frame and `push` keeps nothing.
      const frame = this.pending.slice();
      const energy = rms(frame);
      // The detector reads the frame BEFORE it is transferred away below: `vad.push` copies what
      // it needs into its own pending buffer, so handing the main thread `frame.buffer` afterwards
      // detaches nothing the detector still holds.
      const events = this.vad.push(frame);
      this.port.postMessage({ type: 'frame', rms: energy, atSample: this.framesAt } satisfies VoiceFrameMessage);
      // The frame's own samples, forwarded so the segmenter can buffer and upload real audio
      // rather than only its energy. TRANSFERRED, not copied: this is the processor's own copy
      // and nothing here reads it again, so the main thread takes the buffer with no further
      // allocation on the audio thread. Posted before the events, so a consumer that buffers the
      // PCM has the samples in hand when the boundary events arrive.
      this.port.postMessage({ type: 'pcm', samples: frame, atSample: this.framesAt }, [frame.buffer]);
      this.framesAt += this.frameSize;
      for (const event of events) {
        this.port.postMessage({ type: 'event', event } satisfies VoiceFrameMessage);
      }
    }

    // Pass the input through untouched: the node sits beside the recorder, not in its path, and
    // a worklet that returned silence would be a change to the audio if it were ever connected.
    const output = outputs[0]?.[0];
    if (output) output.set(input.subarray(0, output.length));
    return true;
  }
}

/** Frame RMS, matching `frameRms` in the shared module so the two cannot disagree on a frame. */
function rms(frame: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < frame.length; i++) acc += frame[i] * frame[i];
  return Math.sqrt(acc / frame.length);
}

const registerProcessorFn = (globalThis as { registerProcessor?: (name: string, ctor: unknown) => void })
  .registerProcessor;
if (typeof registerProcessorFn === 'function') {
  registerProcessorFn(VOICE_FRAME_PROCESSOR_NAME, VoiceFrameProcessor);
}
