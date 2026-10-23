import { useTranslation } from 'react-i18next';
import { Play, Square } from 'lucide-react';

import { Button } from '@/shared/ui';
import type { VoiceClip, VoiceClipPlayState, VoiceClipSlot, VoiceClipTrack } from '@/shared/types';

type VoiceClipButtonProps = {
  clips: VoiceClipSlot;
  state: VoiceClipPlayState;
  onToggle: (track: VoiceClipTrack) => void;
};

/**
 * `M:SS`, or `H:MM:SS` once the audio reaches an hour; the recorder's sub-second precision is not shown.
 *
 * The hours field is what keeps a long capture honest: a bare `61:23` reads as ambiguous between one
 * hour and one minute, and there is no ceiling on how long a recording may run.
 */
const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/**
 * The four names a replay control announces, one pair per track.
 *
 * Named rather than assembled from the track at the call site: the accessible name is what the two
 * controls are told apart by — by a screen reader, and by a test that has no other way to say which
 * one it means — so the names are chosen here, once, where the translation keys can be read.
 */
const TRACK_LABELS = {
  original: { idle: 'voice.replayOriginal', active: 'voice.stopReplayOriginal' },
  trimmed: { idle: 'voice.replayTrimmed', active: 'voice.stopReplayTrimmed' },
} as const;

/**
 * One track's replay control: an icon and how long that audio is — nothing else.
 *
 * The byte count used to sit beside the duration, but the two controls are read against each other
 * and their sizes disagree with their lengths: the trimmed audio is the shorter one and, being PCM
 * rather than the recorder's opus, the larger one. That made a smaller, better take read as worse.
 * The duration alone is the fact the pair is compared by. `data-clip-url` is the blob this control
 * would play, published so a test can compare the two sources rather than infer them.
 */
function ClipReplay({
  track,
  clip,
  state,
  onToggle,
}: {
  track: VoiceClipTrack;
  clip: VoiceClip;
  state: VoiceClipPlayState[VoiceClipTrack];
  onToggle: (track: VoiceClipTrack) => void;
}) {
  const { t } = useTranslation('chat');
  const isActive = state !== 'idle';

  // One label, read by both the tooltip and the accessible name, so the announced
  // name cannot drift from the visible one. Mirrors VoiceInputButton's mic.
  const label = t(TRACK_LABELS[track][isActive ? 'active' : 'idle']);

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={(e) => {
        e.preventDefault();
        onToggle(track);
      }}
      className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
      title={label}
      aria-label={label}
      data-clip-url={clip.url}
    >
      {isActive ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      <span className="font-medium tabular-nums text-foreground">{formatDuration(clip.meta.durationMs)}</span>
    </Button>
  );
}

/**
 * Rendered by chat's ChatComposer immediately right of the microphone, and only
 * while a recording is in the slot. Replays the last thing the user said — and, when
 * the trim applied, the upload that was made of it, so the two can be heard against
 * each other.
 *
 * Either control is absent rather than disabled when its own audio is missing. The trimmed one is
 * absent when there is no trimmed audio (`fallback` in the trim reading): a second control over the
 * recording's own bytes would claim a trim the run never made. The original one is absent when the
 * raw recording was never kept: a disabled control would claim a recording that is not there.
 *
 * Ghost styling on purpose: `TokenUsageSummary` next to it is a bordered pill, and
 * two bordered pills in a row read as the same kind of thing — but one is the
 * previous message and the other is session state.
 */
export default function VoiceClipButton({ clips, state, onToggle }: VoiceClipButtonProps) {
  return (
    <>
      {clips.original && (
        <ClipReplay track="original" clip={clips.original} state={state.original} onToggle={onToggle} />
      )}
      {clips.trimmed && (
        <ClipReplay track="trimmed" clip={clips.trimmed} state={state.trimmed} onToggle={onToggle} />
      )}
    </>
  );
}
