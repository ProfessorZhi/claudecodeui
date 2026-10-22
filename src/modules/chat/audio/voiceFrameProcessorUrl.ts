/**
 * The worklet module's URL, as the BUNDLER emitted it, for `AudioWorklet.addModule`.
 *
 * WHY THIS IS NOT `new URL(...)` INSIDE `voiceFrameProcessor.ts`. `new URL('./voiceFrameProcessor.ts',
 * import.meta.url)` reads correctly in the dev server — which transforms the `.ts` on request and
 * serves it as JavaScript — and is wrong in a production build, where Vite treats it as a plain
 * asset reference and copies the file VERBATIM. The deployed page then asked the browser to load
 * TypeScript source: served with the `.ts` extension, which every static server resolves through
 * mime-db to `video/mp2t`, and rejected by `addModule` as a module MIME type mismatch before a line
 * of it ran. The same file also still carried `@/shared/voiceEndpoint` as a bare specifier and
 * TypeScript's own syntax, so no MIME type would have made it loadable.
 *
 * `?worker&url` is the bundler's "build this entry on its own and give me the URL" — the emitted
 * file is `.js`, self-contained, and carries the shared `StreamingVad` the worklet imports, which
 * is what keeps the detector a single implementation rather than a copy on the audio thread.
 *
 * The query import cannot live in `voiceFrameProcessor.ts` itself: the bundler's separate build of
 * that file would contain the very import that started it.
 *
 * Used by `src/modules/chat/hooks/useVoiceInput.ts` to load the shipping capture engine.
 */
// The module behind this specifier is the bundler's build of the entry, whose default export is a
// URL. oxlint resolves the specifier as a source path and so cannot see an export that only exists
// after the build; the bundler and `vite/client`'s own `*?worker&url` declaration both can.
// oxlint-disable-next-line import/default
import workletModuleUrl from '@/modules/chat/audio/voiceFrameProcessor.ts?worker&url';

export function voiceFrameProcessorUrl(): string | null {
  // A build that produced no URL is treated by the caller exactly like a browser without
  // `AudioWorklet`: the capture engine refuses to start instead of loading an empty URL.
  return workletModuleUrl || null;
}
