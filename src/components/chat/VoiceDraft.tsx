// The voice note pieces every writing box shares (chat Composer, catch-up
// reply): the recording row (round X cancel | dotted track with live bars
// filling from the right | m:ss | round check = stop and keep), the kept note
// waiting in the open box as a chip (round play, bars, length, a small round X
// at its top-right corner), the older draft row above the composer (FT42) and
// the "Stop recording?" ask on system Back while recording. Store rules live
// in src/lib/chat/voice-draft.ts. Tokens only, so light and dark stay at
// parity; every control has a 44 hit.
//
// The live bars are not read from the microphone: no Web Audio graph may
// touch the recording stream (it changes WebKit's recorder output, see
// use-audio-recorder.ts), so each bar's height is a fixed pseudo-level per
// index. A new bar joins at the right every RECORDING_BAR_MS; each bar's
// height is transform scaleY only (no timed move). Under Reduce Motion the
// bars only step with the elapsed seconds.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  ICON_SIZE,
  IconCheck,
  IconPause,
  IconPlay,
  IconSend,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { textRole } from '@/components/ui/Text';
import { UploadRetry, UploadRing } from '@/components/ui/UploadRing';
import { cn } from '@/lib/cn';
import { motionOff } from '@/lib/motion';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { BACK_GUARD_STEP_KEY, stepMarkerOf } from '@/lib/chat/use-history-step';
import { voiceDraftLabel, type VoiceDraft } from '@/lib/chat/voice-draft';
import { clockLength } from '@/lib/catch-up/text';
import { readHeader, rememberRecorderMime, voiceFileType } from '@/lib/chat/audio-sniff';
import { voicePeaks } from '@/lib/chat/voice-peaks';
import { MIN_VOICE_NOTE_MS, type RecordingResult } from '@/lib/chat/use-audio-recorder';

type DataAttrs = Readonly<Record<`data-${string}`, string>>;

/** The most bars the recording track holds (older ones leave on the left). */
export const RECORDING_BARS_MAX = 64;

/** A new live bar joins the track this often while recording (ms). */
export const RECORDING_BAR_MS = 150;

/** Bars a kept note's chip draws when its peaks are unknown. */
export const VOICE_CHIP_BARS = 24;

/** The fixed pseudo-level of bar `index`, 0.25..1 (two decimals). Pure. */
export function liveBarHeight(index: number): number {
  const x = Math.sin((index + 1) * 12.9898) * 43758.5453;
  return Math.round((0.25 + 0.75 * (x - Math.floor(x))) * 100) / 100;
}

/** The last `max` bars of `count`, keyed by their index (newest last). Pure. */
export function liveBars(
  count: number,
  max: number = RECORDING_BARS_MAX,
): { key: number; scale: number }[] {
  const total = Math.max(0, Math.floor(count));
  const out: { key: number; scale: number }[] = [];
  for (let i = Math.max(0, total - max); i < total; i += 1) {
    out.push({ key: i, scale: liveBarHeight(i) });
  }
  return out;
}

/** A kept note's bars: its peaks squeezed to `count` (0.25..1), else the pseudo-levels. Pure. */
export function chipBars(
  peaks: readonly number[] | undefined,
  count: number = VOICE_CHIP_BARS,
): number[] {
  if (peaks === undefined || peaks.length === 0) {
    return Array.from({ length: count }, (_, i) => liveBarHeight(i));
  }
  const max = Math.max(...peaks, 0.0001);
  return Array.from({ length: count }, (_, i) => {
    const at = peaks[Math.min(peaks.length - 1, Math.floor((i * peaks.length) / count))] ?? 0;
    return Math.round(Math.max(0.25, Math.min(1, at / max)) * 100) / 100;
  });
}

/**
 * How many live bars the track shows: one per RECORDING_BAR_MS while
 * `active`; under Reduce Motion one per elapsed second (no timer of its own).
 */
export function useRecordingBars(active: boolean, seconds: number): number {
  const [ticks, setTicks] = useState(0);
  const off = motionOff();
  useEffect(() => {
    if (!active) {
      setTicks(0);
      return undefined;
    }
    if (off) return undefined;
    const id = window.setInterval(() => setTicks((t) => t + 1), RECORDING_BAR_MS);
    return () => window.clearInterval(id);
  }, [active, off]);
  return off ? Math.floor(seconds) : ticks;
}

/** One bar: a 2 wide, 24 tall stroke drawn at its level by scaleY only. */
function Bar(props: { scale: number; className: string }): ReactElement {
  return (
    <span
      data-voice-bar=""
      className={cn('h-6 w-0.5 shrink-0 rounded-full', props.className)}
      style={{ transform: `scaleY(${props.scale})` }}
    />
  );
}

/**
 * The recording row (in the writing box while recording): round X cancel on
 * bg-fg/10 | the dotted track with the live bars (ink) filling from the right
 * | the elapsed m:ss (meta) | round check (Main) = stop and keep. Hook-free:
 * the caller hands the bar count (useRecordingBars) and the elapsed text.
 */
export function RecordingRow(props: {
  elapsed: string;
  bars: number;
  onCancel: () => void;
  onKeep: () => void;
  /** The recording is being stopped: the check spins at its width. */
  busy?: boolean;
  dataAttrs?: DataAttrs | undefined;
}): ReactElement {
  return (
    <div
      {...props.dataAttrs}
      data-recording-row=""
      role="group"
      aria-label="Recording voice note"
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1"
    >
      <Button
        type="button"
        variant="secondary"
        shape="round"
        aria-label="Cancel recording"
        data-recording-cancel=""
        className="shrink-0"
        onClick={props.onCancel}
      >
        <IconX size={ICON_SIZE.inline} />
      </Button>
      {/* justify-end: a full track drops its oldest bars off the left edge. */}
      <span
        aria-hidden="true"
        data-recording-track=""
        className="flex h-6 min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden"
      >
        <span className="min-w-0 flex-1 border-t border-dotted border-border-strong" />
        {liveBars(props.bars).map((bar) => (
          <Bar key={bar.key} scale={bar.scale} className="bg-fg" />
        ))}
      </span>
      <span data-recording-elapsed="" className={textRole('meta', 'shrink-0')}>
        {props.elapsed}
      </span>
      <Button
        type="button"
        variant="primary"
        shape="round"
        aria-label="Stop and keep voice note"
        data-recording-keep=""
        busy={props.busy === true}
        className="shrink-0"
        onClick={props.onKeep}
      >
        <IconCheck size={ICON_SIZE.control} />
      </Button>
    </div>
  );
}

/** A kept note's upload, when the box uploads it before Send (catch-up). */
export type VoiceChipUpload =
  | { state: 'uploading'; progress: number | null }
  | { state: 'failed'; onRetry: () => void };

/**
 * A kept voice note waiting in the open box: round play (Main), its bars
 * (fg-3), its length m:ss (meta), and a small round X (fg on bg, 24 visual,
 * 44 hit) on the chip's top-right corner that removes it. While it uploads the
 * play slot holds ui/UploadRing (its X cancels: the note goes); a failed
 * upload shows Retry there. Hook-free.
 */
export function VoiceNoteChip(props: {
  durationMs: number;
  peaks?: readonly number[] | undefined;
  playing: boolean;
  onPlay: () => void;
  onRemove: () => void;
  upload?: VoiceChipUpload | undefined;
  dataAttrs?: DataAttrs | undefined;
}): ReactElement {
  const clock = clockLength(Math.round(props.durationMs / 1000));
  const upload = props.upload;
  return (
    <div
      {...props.dataAttrs}
      data-voice-chip={upload?.state ?? 'ready'}
      role="group"
      aria-label={`Voice note ${clock}`}
      className="lit-chip relative inline-flex min-w-0 max-w-full items-center gap-2 self-start rounded-xl border bg-panel py-1 pl-1 pr-4"
    >
      <span data-voice-chip-play="" className="relative grid h-11 w-11 shrink-0 place-items-center">
        {upload?.state === 'uploading' ? (
          <UploadRing
            variant="voice"
            progress={upload.progress}
            label="Cancel upload"
            onCancel={props.onRemove}
            className="absolute inset-0 m-auto"
          />
        ) : upload?.state === 'failed' ? (
          <UploadRetry
            variant="voice"
            onRetry={upload.onRetry}
            className="absolute inset-0 m-auto"
          />
        ) : (
          <Button
            type="button"
            variant="primary"
            shape="round"
            aria-label={props.playing ? 'Pause voice note' : 'Play voice note'}
            onClick={props.onPlay}
          >
            {props.playing ? (
              <IconPause size={ICON_SIZE.control} />
            ) : (
              <IconPlay size={ICON_SIZE.control} />
            )}
          </Button>
        )}
      </span>
      <span aria-hidden="true" className="flex h-6 min-w-0 items-center gap-1 overflow-hidden">
        {/* A bar's place in the waveform is its identity (the peaks never reorder). */}
        {chipBars(props.peaks).map((scale, place) => (
          <Bar key={`bar-${place}`} scale={scale} className="bg-fg-3" />
        ))}
      </span>
      <span className={textRole('meta', 'shrink-0')}>{clock}</span>
      <IconButton
        type="button"
        label="Remove voice note"
        data-voice-chip-remove=""
        // The 44 hit box; the visible disc inside it is 24.
        className="absolute -right-4 -top-4 rounded-full"
        onClick={props.onRemove}
      >
        {/* The IconButton is the 44 hit box; the visible disc inside it is 24. */}
        <span aria-hidden="true" className="grid place-items-center">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-fg text-bg">
            <IconX size={ICON_SIZE.inline} />
          </span>
        </span>
      </IconButton>
    </div>
  );
}

/** The chip with its own playback (one object URL per blob, freed on change). */
export function VoiceNoteChipPlayer(props: {
  blob: Blob;
  durationMs: number;
  peaks?: readonly number[] | undefined;
  onRemove: () => void;
  upload?: VoiceChipUpload | undefined;
  dataAttrs?: DataAttrs | undefined;
}): ReactElement {
  const playback = useBlobPlayback(props.blob);
  return (
    <>
      <VoiceNoteChip
        durationMs={props.durationMs}
        peaks={props.peaks}
        playing={playback.playing}
        onPlay={playback.toggle}
        onRemove={props.onRemove}
        upload={props.upload}
        dataAttrs={props.dataAttrs}
      />
      {playback.audio}
    </>
  );
}

/** Play / pause one blob through a hidden <audio> (its object URL freed on change). */
function useBlobPlayback(blob: Blob): {
  playing: boolean;
  toggle: () => void;
  audio: ReactElement | null;
} {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    try {
      made = URL.createObjectURL(blob);
    } catch {
      made = null;
    }
    setUrl(made);
    setPlaying(false);
    return () => {
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [blob]);
  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setPlaying(false));
  };
  const audio =
    url !== null ? (
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    ) : null;
  return { playing, toggle, audio };
}

/** A finished recording as the file a voice note sends: typed from its bytes, with its length and peaks. */
export interface PreparedVoiceNote {
  file: File;
  durationMs: number;
  /** Waveform peaks read from the finished file; undefined when they could not be read. */
  peaks: number[] | undefined;
}

/**
 * A finished recording as a voice note file, the one path chat and catch-up
 * share: null for a null, empty or sub-second recording (too short);
 * otherwise the file typed and named from its bytes (not the recorder's
 * say-so) and its peaks (capped at 1s; none on any failure).
 */
export async function prepareVoiceNote(
  rec: RecordingResult | null,
): Promise<PreparedVoiceNote | null> {
  if (rec === null || rec.blob.size === 0 || rec.durationMs < MIN_VOICE_NOTE_MS) return null;
  const { type, name } = voiceFileType(await readHeader(rec.blob), rec.recorderMime, rec.mime);
  const file = new File([rec.blob], name, { type });
  rememberRecorderMime(file, rec.recorderMime);
  const peaks = await voicePeaks(file);
  return { file, durationMs: rec.durationMs, peaks };
}

/** The draft row's markup. Hook-free (playback state comes in) so it is unit tested. */
export function voiceDraftView(props: {
  durationMs: number;
  playing: boolean;
  busy: boolean;
  onPlay: () => void;
  onSend: () => void;
  onDelete: () => void;
}): ReactElement {
  const label = voiceDraftLabel(props.durationMs);
  return (
    <div
      data-voice-draft=""
      role="group"
      aria-label={`Saved ${label.toLowerCase()}`}
      className="flex items-center gap-1 rounded-xl border bg-panel-2 py-1 pl-1 pr-1 lit-card-muted"
    >
      <IconButton
        type="button"
        data-voice-draft-play=""
        label={props.playing ? 'Pause voice note' : 'Play voice note'}
        onClick={props.onPlay}
        className="shrink-0"
      >
        {props.playing ? (
          <IconPause size={ICON_SIZE.control} />
        ) : (
          <IconPlay size={ICON_SIZE.control} />
        )}
      </IconButton>
      <span className="min-w-0 flex-1 truncate text-base text-fg-2 tabular-nums">{label}</span>
      <IconButton
        type="button"
        data-voice-draft-delete=""
        label="Delete voice note"
        disabled={props.busy}
        onClick={props.onDelete}
        className="shrink-0 text-bad hover:bg-bad-soft hover:text-bad"
      >
        <IconTrash size={ICON_SIZE.control} />
      </IconButton>
      <Button
        type="button"
        variant="primary"
        shape="round"
        data-voice-draft-send=""
        aria-label="Send voice note"
        busy={props.busy}
        onClick={props.onSend}
        className="shrink-0"
      >
        <IconSend size={ICON_SIZE.control} />
      </Button>
    </div>
  );
}

/** The draft row with its own playback (one object URL per draft, freed on change). */
export function VoiceDraftBar(props: {
  draft: VoiceDraft;
  busy: boolean;
  onSend: () => void;
  onDelete: () => void;
}): ReactElement {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    try {
      made = URL.createObjectURL(props.draft.blob);
    } catch {
      made = null;
    }
    setUrl(made);
    setPlaying(false);
    return () => {
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [props.draft.blob]);
  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setPlaying(false));
  };
  return (
    <>
      {voiceDraftView({
        durationMs: props.draft.durationMs,
        playing,
        busy: props.busy,
        onPlay: toggle,
        onSend: props.onSend,
        onDelete: props.onDelete,
      })}
      {url !== null ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      ) : null}
    </>
  );
}

const STOP_RECORDING_TITLE = 'Stop recording?';
export const STOP_RECORDING_KEEP = 'Keep recording';
export const STOP_RECORDING_SAVE = 'Save as draft';
export const STOP_RECORDING_DISCARD = 'Discard';

/**
 * System Back while recording (7d): Keep recording, Save as draft or Discard.
 * A modal alert dialog: focus moves in, Tab stays inside, Escape and a scrim
 * tap keep recording.
 */
export function StopRecordingDialog(props: {
  onKeep: () => void;
  onSave: () => void;
  onDiscard: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, props.onKeep);
  useModalFocus(panelRef, true);
  return createPortal(
    <div
      data-stop-recording=""
      className="fixed inset-0 z-sheet flex items-end justify-center px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center"
    >
      {/* A tap outside the panel keeps recording, like Escape. */}
      <Backdrop aria-label={STOP_RECORDING_KEEP} onClick={props.onKeep} position="absolute" />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={STOP_RECORDING_TITLE}
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-2xl border bg-panel p-6 lit-overlay outline-none"
      >
        <h2 className="text-lg font-semibold text-fg">{STOP_RECORDING_TITLE}</h2>
        <div className="mt-6 flex flex-col gap-2">
          <Button variant="primary" onClick={props.onKeep}>
            {STOP_RECORDING_KEEP}
          </Button>
          <Button variant="secondary" onClick={props.onSave}>
            {STOP_RECORDING_SAVE}
          </Button>
          <Button variant="danger" onClick={props.onDiscard}>
            {STOP_RECORDING_DISCARD}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Leave after a Back the guard held: drop the guard (its entry pops), then go
 * back once more so the Back the user pressed takes effect. When the guard's
 * entry is not on top (never placed), one back is enough.
 */
export function leaveAfterGuard(release: () => void, win: Window = window): void {
  const guarded = stepMarkerOf(win.history.state, BACK_GUARD_STEP_KEY) !== null;
  if (!guarded) {
    release();
    win.history.back();
    return;
  }
  const onPop = (): void => {
    win.removeEventListener('popstate', onPop);
    win.history.back();
  };
  win.addEventListener('popstate', onPop);
  release();
}
