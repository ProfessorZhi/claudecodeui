import type { VoiceCaptureEngine, VoiceCaptureSink } from '@/modules/chat/hooks/useVoiceInput';
import type { VadEvent } from '@/shared/voiceEndpoint';

/**
 * A capture engine a test drives by hand, standing in for the microphone and the `AudioWorklet`.
 *
 * jsdom has neither an audio thread nor a microphone, and the shipping engine's whole job is to turn
 * a real stream into 20 ms PCM frames plus VAD events. This hands those frames to the hook's sink
 * directly, so a test can speak an exact number of seconds, at an exact amplitude, with the VAD
 * transitions it wants — and, crucially, can do it without a browser.
 *
 * Used by the chat module's voice tests (`voiceTranscriptRepair`, `voiceClipPlayback`,
 * `voiceErrorMessages`, `voiceErrorNoticePersistence`).
 */
export type FakeVoiceCapture = {
  engine: VoiceCaptureEngine;
  /** Feeds `seconds` of constant-amplitude PCM with no VAD transition (silence, or speech already on). */
  push: (seconds: number, amplitude?: number) => void;
  /**
   * Feeds `seconds` of audio that starts a speech run: a `speechStart` event on the first frame and
   * speech-level amplitude throughout. This is what makes the segmenter emit a segment at all.
   */
  speak: (seconds: number, amplitude?: number) => void;
  /** Ends the current speech run with a `speechEnd` event. */
  endSpeech: () => void;
  /** Whether a capture has been started and not yet stopped. */
  active: () => boolean;
};

/** The default frame rate the fake produces its PCM at; the hook builds its segmenter against it. */
const SAMPLE_RATE = 16_000;

export function createFakeVoiceCapture(sampleRate = SAMPLE_RATE): FakeVoiceCapture {
  let sink: VoiceCaptureSink | null = null;
  let atSample = 0;

  const engine: VoiceCaptureEngine = {
    async start(_stream, nextSink) {
      sink = nextSink;
      atSample = 0;
      return sampleRate;
    },
    stop() {
      sink = null;
    },
  };

  const frame = (seconds: number, amplitude: number, events: readonly VadEvent[]): void => {
    if (!sink) throw new Error('the fake capture was handed a frame before it was started');
    const samples = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
    samples.fill(amplitude);
    sink.onFrame(samples, atSample, events);
    atSample += samples.length;
  };

  return {
    engine,
    push(seconds, amplitude = 0) {
      frame(seconds, amplitude, []);
    },
    speak(seconds, amplitude = 0.3) {
      if (!sink) throw new Error('the fake capture was asked to speak before it was started');
      sink.onActivity();
      frame(seconds, amplitude, [{ type: 'speechStart', atSample }]);
    },
    endSpeech() {
      if (!sink) return;
      sink.onActivity();
      frame(0.02, 0, [{ type: 'speechEnd', atSample }]);
    },
    active() {
      return sink !== null;
    },
  };
}
