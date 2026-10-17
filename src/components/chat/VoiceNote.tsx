// The voice-note body that sits inside the normal message bubble shell (same
// radius, border and own/peer tint as a text bubble, owned by MessageBubble),
// WhatsApp style. Received, three rows: [play 44x44] [waveform with dot]
// [sender photo 40px + mic badge]; the mono m:ss length under the wave's start;
// the always-visible Transcribe link left and the bubble's time right in a
// fixed 44px row. Own, two rows: [own photo + mic badge] [play] [waveform];
// the length left and the time and ticks right. The mic badge is fg-3 until
// the note has played to the end once on this device, then accent; while
// playing the photo slot shows a speed pill cycling 1x / 1.5x / 2x (remembered
// for the session across notes). When a note ends and the message right below
// is an unplayed voice note from the same sender, that one starts 350ms later.
// The length shows before play from the stored durationMs (the recorder's
// value); a finite media duration (loadedmetadata or durationchange) refines
// it, and a non-finite one (MediaRecorder webm reports Infinity) never replaces
// it. One note plays at a time across the app. No recording, no presign logic
// (the url is handed in, null while the presign is still in flight).
//
// The transcript state is read synchronously from the per-device transcript
// store so first paint is final. On a received note the link reads
// "Transcribe", "Transcribing…", "Hide transcript" / "Show transcript", or
// "Transcript not available" + "Try again"; the transcript drops down under the
// link row. Own notes carry no link (the menu's Transcribe stays).
//
// The bars are drawn from the note's own peaks (read from the finished
// recording, resampled to the bar count) when it carries them; older notes and older
// clients fall back to the fixed WAVEFORM_BARS. While an own note uploads, the
// play spot holds the UploadRing (tap X cancels the send) and the wave is a
// plain flat line of the same length; when the upload finishes, X becomes play
// and the line becomes the waveform in a 150ms opacity crossfade (nothing
// moves or resizes).

import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { UploadRing } from '@/components/chat/UploadRing';
import { IconMic, IconPause, IconPlay } from '@/components/ui/icons';
import {
  cancelPendingLongPressesWithin,
  LONG_PRESS_MS,
  MOVE_CANCEL_PX,
} from '@/components/ui/useLongPress';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { logger } from '@/lib/logger';
import { resamplePeaks } from '@/lib/chat/waveform-peaks';
import {
  transcriptView,
  useVoiceRecord,
  voiceStore,
  type TranscriptView,
} from '@/lib/chat/transcript-store';

/**
 * Fixed decorative bar heights (percent of the track): the fallback for a
 * note without peaks (older notes, older clients).
 */
export const WAVEFORM_BARS: readonly number[] = [
  35, 60, 45, 80, 55, 70, 40, 90, 50, 65, 30, 75, 48, 85, 42, 68, 38, 72, 52, 58,
];

/** How many bars the wave draws. */
export const VOICE_BAR_COUNT = 20;

/** The lowest bar drawn from peaks (percent), so a quiet stretch still shows a mark. */
const MIN_BAR = 8;

/**
 * The bar heights (percent) to draw: the note's peaks resampled to the bar
 * count when it has them, else the fixed fallback. Pure.
 */
export function voiceBars(peaks: readonly number[] | undefined): readonly number[] {
  if (peaks === undefined || peaks.length === 0) return WAVEFORM_BARS;
  return resamplePeaks(peaks, VOICE_BAR_COUNT).map((height) => Math.max(MIN_BAR, height));
}

/** The label when no length is known yet. */
export const UNKNOWN_DURATION = '--:--';

/** Format a second count as m:ss ("0:18", "12:05"); negatives clamp to 0. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function usable(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0;
}

/**
 * The note's length in seconds: a finite media duration when the element has
 * reported one, else the stored durationMs, else null (unknown).
 */
export function voiceTotalSeconds(
  storedMs: number | undefined,
  mediaSeconds: number,
): number | null {
  if (usable(mediaSeconds)) return mediaSeconds;
  if (storedMs !== undefined && usable(storedMs)) return storedMs / 1000;
  return null;
}

/** The label: elapsed time while playing or paused mid-way, else the length. */
export function voiceLabel(params: {
  storedMs: number | undefined;
  mediaSeconds: number;
  currentSeconds: number;
  playing: boolean;
}): string {
  if (params.playing || params.currentSeconds > 0) return formatDuration(params.currentSeconds);
  const total = voiceTotalSeconds(params.storedMs, params.mediaSeconds);
  return total === null ? UNKNOWN_DURATION : formatDuration(total);
}

/** Played share in percent, against the known length; 0 when unknown. */
export function voiceProgress(
  storedMs: number | undefined,
  mediaSeconds: number,
  currentSeconds: number,
): number {
  const total = voiceTotalSeconds(storedMs, mediaSeconds);
  if (total === null) return 0;
  return Math.min(100, Math.max(0, (currentSeconds / total) * 100));
}

/** The slice of HTMLAudioElement the note binds to; a fake satisfies it in tests. */
export interface VoiceAudio {
  duration: number;
  currentTime: number;
  pause: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Wire an audio element's events to the note's state. A duration event only
 * reports a usable (finite, positive) value, so Infinity or NaN never
 * overwrites what the note already shows. Returns the teardown.
 */
export function bindVoiceAudio(
  audio: VoiceAudio,
  on: {
    duration: (seconds: number) => void;
    time: (seconds: number) => void;
    playing: (playing: boolean) => void;
    ended: () => void;
  },
): () => void {
  const onDuration = (): void => {
    if (usable(audio.duration)) on.duration(audio.duration);
  };
  const onTime = (): void => on.time(audio.currentTime);
  const onPlay = (): void => {
    voicePlayback.claim(audio);
    on.playing(true);
  };
  const onPause = (): void => on.playing(false);
  const onEnded = (): void => {
    voicePlayback.release(audio);
    on.ended();
  };
  const events: Array<[string, () => void]> = [
    ['loadedmetadata', onDuration],
    ['durationchange', onDuration],
    ['timeupdate', onTime],
    ['play', onPlay],
    ['pause', onPause],
    ['ended', onEnded],
  ];
  for (const [type, fn] of events) audio.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of events) audio.removeEventListener(type, fn);
  };
}

/** Anything that can be paused. */
interface Pausable {
  pause: () => void;
}

/** Tracks the one playing note; claiming a new one pauses the previous. */
export function createPlaybackRegistry(): {
  claim: (audio: Pausable) => void;
  release: (audio: Pausable) => void;
} {
  let active: Pausable | null = null;
  return {
    claim(audio) {
      if (active !== null && active !== audio) active.pause();
      active = audio;
    },
    release(audio) {
      if (active === audio) active = null;
    },
  };
}

/** The app-wide registry: one voice note plays at a time. */
export const voicePlayback = createPlaybackRegistry();

/** Whether a waveform bar sits inside the played-so-far share (progress 0-100). */
export function barPlayed(index: number, progress: number, count = VOICE_BAR_COUNT): boolean {
  return progress > 0 && ((index + 0.5) / count) * 100 <= progress;
}

/** Playback speeds the pill cycles through, in order. */
export const VOICE_SPEEDS = [1, 1.5, 2] as const;

/** The speed after `rate` in the cycle (an unknown rate restarts at 1x). */
export function nextSpeed(rate: number): number {
  const index = VOICE_SPEEDS.findIndex((speed) => speed === rate);
  return VOICE_SPEEDS[(index + 1) % VOICE_SPEEDS.length] ?? 1;
}

/** The pill label for a rate: "1×", "1.5×", "2×". */
export function speedLabel(rate: number): string {
  return `${rate}×`;
}

/** The chosen speed, shared by every note for the rest of the session. */
let sessionRate = 1;

/** Where along the wave (0..1) a pointer at clientX sits; X only, clamped. */
export function seekFraction(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** Gap between one note ending and the next one in the chain starting. */
export const AUTO_NEXT_DELAY_MS = 350;

/** Mounted notes by message id, so an ending note can start the next one. */
const voiceChain = new Map<string, () => void>();
/** The armed chain step; any user play or pause cancels it. */
let pendingNext: ReturnType<typeof setTimeout> | null = null;

function cancelPendingNext(): void {
  if (pendingNext !== null) clearTimeout(pendingNext);
  pendingNext = null;
}

/**
 * Whether an ended note hands on to `nextId`: there is one (the message right
 * below, a voice note from the same sender) and it has not played yet. Pure.
 */
export function shouldAutoPlayNext(
  nextId: string | null | undefined,
  nextPlayedAt: number | undefined,
): nextId is string {
  return typeof nextId === 'string' && nextId !== '' && nextPlayedAt === undefined;
}

/** A play() rejection worth reporting: an abort from a quick pause is not. */
function logPlayFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  logger.error('chat: voice note play failed', {
    name: error instanceof Error ? error.name : 'unknown',
  });
}

/** A touch on the wave seeks once it moves this far (px) along X before the hold time. */
export const WAVE_SEEK_LOCK_PX = 8;

/**
 * A touch on the wave: 'pending' until it decides; 'seek' (a horizontal drag);
 * 'hold' (the bubble's long-press owns it); 'none' (moved, but neither).
 */
export type WaveTouchPhase = 'pending' | 'seek' | 'hold' | 'none';

/**
 * Where a pending touch on the wave stands, WhatsApp style: a horizontal move
 * of WAVE_SEEK_LOCK_PX within LONG_PRESS_MS starts seeking; still pending at
 * LONG_PRESS_MS it is the bubble's long-press; any other move past the
 * long-press tolerance is neither. Pure.
 */
export function waveTouchPhase(
  start: { x: number; y: number; t: number },
  at: { x: number; y: number; t: number },
): WaveTouchPhase {
  if (at.t - start.t >= LONG_PRESS_MS) return 'hold';
  const dx = at.x - start.x;
  const dy = at.y - start.y;
  if (Math.abs(dx) >= WAVE_SEEK_LOCK_PX) return 'seek';
  if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) return 'none';
  return 'pending';
}

/** The Transcribe link's label state on a received note. */
export type TranscribeLinkState = 'transcribe' | 'pending' | 'hide' | 'show' | 'failed';

/** The link state for a transcript view. Pure. */
export function transcribeLinkState(view: TranscriptView): TranscribeLinkState {
  switch (view.kind) {
    case 'none':
      return 'transcribe';
    case 'pending':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'shown':
      return view.collapsed ? 'show' : 'hide';
  }
}

/** Swallow a pointer event here: a tap on the link never reaches swipe or long-press. */
function stopPointer(e: { stopPropagation: () => void }): void {
  e.stopPropagation();
}

const STOP_POINTER = {
  onPointerDown: stopPointer,
  onPointerMove: stopPointer,
  onPointerUp: stopPointer,
  onPointerCancel: stopPointer,
};

/** The link's type and 44px hit row; never selects text or opens the callout. */
const LINK_TEXT =
  'flex h-11 select-none items-center text-[15px] font-medium leading-5 [-webkit-touch-callout:none]';
const LINK_BUTTON = cn(
  LINK_TEXT,
  'shrink-0 rounded-sm text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
);

/** The always-visible Transcribe link on a received note; null when there is nothing to offer. */
function TranscribeLink(props: {
  state: TranscribeLinkState;
  onTranscribe: (() => void) | undefined;
  onCollapse: (collapsed: boolean) => void;
}): ReactElement | null {
  const { state, onTranscribe } = props;
  switch (state) {
    case 'transcribe':
      return onTranscribe === undefined ? null : (
        <button
          type="button"
          data-voice-link="transcribe"
          onClick={onTranscribe}
          className={LINK_BUTTON}
        >
          Transcribe
        </button>
      );
    case 'pending':
      return (
        <span
          data-voice-link="pending"
          role="status"
          className={cn(LINK_TEXT, 'shrink-0 text-fg-2')}
        >
          Transcribing…
        </span>
      );
    case 'hide':
    case 'show':
      return (
        <button
          type="button"
          data-voice-link={state}
          data-induction={INDUCTION_KEYS.chatTranscript}
          aria-expanded={state === 'hide'}
          onClick={() => props.onCollapse(state === 'hide')}
          className={LINK_BUTTON}
        >
          {state === 'hide' ? 'Hide transcript' : 'Show transcript'}
        </button>
      );
    case 'failed':
      return (
        <>
          <span data-voice-link="failed" className={cn(LINK_TEXT, 'min-w-0 text-fg-3')}>
            <span className="truncate">Transcript not available</span>
          </span>
          {onTranscribe !== undefined ? (
            <button
              type="button"
              data-voice-link="retry"
              onClick={onTranscribe}
              className={LINK_BUTTON}
            >
              Try again
            </button>
          ) : null}
        </>
      );
  }
}

/**
 * The transcript drop-down: a hairline rule, then the selectable text. It
 * reveals on height (grid rows 0fr to 1fr) and opacity, 180ms ease-out, Y only;
 * reduced motion shows it at once. It mounts in its current state, so a stored
 * transcript paints open on first paint with no transition.
 */
function TranscriptDrop({ text, open }: { text: string; open: boolean }): ReactElement {
  return (
    <div
      data-voice-transcript={open ? 'open' : 'closed'}
      aria-hidden={open ? undefined : true}
      className={cn(
        'grid transition-[grid-template-rows,opacity,visibility] duration-[180ms] ease-out motion-reduce:transition-none',
        open ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="border-t border-border pb-1 pt-2">
          <p
            dir="auto"
            className="select-text whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-5 text-fg"
          >
            {text}
          </p>
        </div>
      </div>
    </div>
  );
}

/** An own note's in-flight or failed status line (own notes carry no link). */
function OwnTranscriptStatus({ view }: { view: TranscriptView }): ReactElement | null {
  if (view.kind === 'pending') {
    return (
      <p
        data-voice-transcript="pending"
        role="status"
        className="flex h-11 items-center border-t border-border text-[15px] leading-5 text-fg-2"
      >
        Transcribing…
      </p>
    );
  }
  if (view.kind === 'failed') {
    return (
      <p
        data-voice-transcript="failed"
        className="flex h-11 items-center border-t border-border text-[15px] leading-5 text-fg-3"
      >
        Transcript not available
      </p>
    );
  }
  return null;
}

/** The voice ring's place: absolutely centred inside the (relative, 44px) play slot. */
export const VOICE_RING_POSITION =
  'absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2';

/** An own note's upload: the ring (active) or, once done, play in its place. */
export interface VoiceUpload {
  /** True while the file still uploads: the X shows, the wave is a flat line. */
  active: boolean;
  /** Upload progress 0..1; null while unknown (the ring spins). */
  progress: number | null;
  onCancel?: (() => void) | undefined;
}

export function VoiceNote({
  url,
  name,
  durationMs,
  peaks,
  upload,
  spacer,
  messageId,
  mine = false,
  sender,
  nextVoiceId,
  meta,
  onTranscribe,
}: {
  url: string | null;
  name: string;
  /** The stored length from the attachment meta; absent on older notes. */
  durationMs: number | undefined;
  /** The recorded waveform (0..100 levels); absent on older notes. */
  peaks?: readonly number[] | undefined;
  /** An own note sent this session: its upload state (absent: a plain note). */
  upload?: VoiceUpload | undefined;
  /** The bubble's inline time spacer, placed at the end of the last line. */
  spacer?: ReactNode;
  /** The recorded message's id: keys the played state and the transcript. */
  messageId?: string | undefined;
  /** Own bubble: photo first, the dot and badge draw on the bubble-own fill. */
  mine?: boolean | undefined;
  /** Whose photo fills the photo slot while the note is not playing. */
  sender?: { name: string; src?: string | undefined } | undefined;
  /** The message right below, when it is a voice note from the same sender. */
  nextVoiceId?: string | null | undefined;
  /** The bubble's time (and ticks): right of the Transcribe row, or of the length on own notes. */
  meta?: ReactNode;
  /** Received, recorded notes only: run the tap-to-transcribe flow. */
  onTranscribe?: (() => void) | undefined;
}): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaSeconds, setMediaSeconds] = useState(Number.NaN);
  const [rate, setRate] = useState(sessionRate);
  // The drag position (0..1) while the wave is held; null when not dragging.
  const [drag, setDrag] = useState<number | null>(null);
  // The touch on the wave, from its pointerdown until it lifts.
  const touch = useRef<{ x: number; y: number; t: number; phase: WaveTouchPhase } | null>(null);
  const { record, pending } = useVoiceRecord(messageId);
  const played = record?.playedAt !== undefined;
  const latest = useRef({ messageId, nextVoiceId });
  latest.current = { messageId, nextVoiceId };

  const start = (audio: HTMLAudioElement): void => {
    voicePlayback.claim(audio);
    audio.defaultPlaybackRate = sessionRate;
    audio.playbackRate = sessionRate;
    setRate(sessionRate);
    void audio.play().catch((error: unknown) => {
      setPlaying(false);
      logPlayFailure(error);
    });
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    const unbind = bindVoiceAudio(audio, {
      duration: setMediaSeconds,
      time: setCurrent,
      playing: setPlaying,
      ended: () => {
        setPlaying(false);
        setCurrent(0);
        const { messageId: id, nextVoiceId: nextId } = latest.current;
        if (id === undefined) return;
        if (voiceStore.get(id)?.playedAt === undefined) {
          voiceStore.update(id, { playedAt: Date.now() });
        }
        cancelPendingNext();
        if (!shouldAutoPlayNext(nextId, voiceStore.get(nextId ?? '')?.playedAt)) return;
        pendingNext = setTimeout(() => {
          pendingNext = null;
          if (voiceStore.get(nextId)?.playedAt === undefined) voiceChain.get(nextId)?.();
        }, AUTO_NEXT_DELAY_MS);
      },
    });
    return () => {
      unbind();
      audio.pause();
      voicePlayback.release(audio);
    };
  }, []);

  // Register this note so the one above it can hand on to it.
  useEffect(() => {
    if (messageId === undefined) return;
    const play = (): void => {
      const audio = audioRef.current;
      if (audio !== null && audio.src !== '') start(audio);
    };
    voiceChain.set(messageId, play);
    return () => {
      if (voiceChain.get(messageId) === play) voiceChain.delete(messageId);
    };
  }, [messageId]);

  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    cancelPendingNext();
    if (playing) {
      audio.pause();
      return;
    }
    start(audio);
  };

  const cycleSpeed = (): void => {
    const next = nextSpeed(rate);
    sessionRate = next;
    setRate(next);
    const audio = audioRef.current;
    if (audio !== null) {
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
    }
  };

  const uploading = upload?.active === true;
  const disabled = url === null || uploading;
  const bars = voiceBars(peaks);
  const total = voiceTotalSeconds(durationMs, mediaSeconds);
  const shownSeconds = drag !== null && total !== null ? drag * total : current;
  const progress = voiceProgress(durationMs, mediaSeconds, shownSeconds);
  const label = voiceLabel({
    storedMs: durationMs,
    mediaSeconds,
    currentSeconds: shownSeconds,
    playing: playing || drag !== null,
  });

  const fractionAt = (clientX: number): number =>
    seekFraction(clientX, waveRef.current?.getBoundingClientRect() ?? { left: 0, width: 0 });
  const seekTo = (fraction: number): void => {
    const audio = audioRef.current;
    if (audio === null || total === null) return;
    const seconds = fraction * total;
    audio.currentTime = seconds;
    setCurrent(seconds);
  };
  const canSeek = !disabled && total !== null;
  // Start a drag: the wave captures the pointer so the moves stay its own.
  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone; the drag ends on its own.
    }
    setDrag(fractionAt(e.clientX));
  };
  // The hold timers armed by this press on the bubble (or on anything holding the note).
  const cancelHolds = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const scope = e.currentTarget.closest('[data-bubble]') ?? document.body;
    cancelPendingLongPressesWithin(scope);
  };
  // Mouse: the wave owns its pointer, a press seeks at once (unchanged). Touch
  // and pen, WhatsApp style: the press reaches the bubble, which arms its
  // long-press and swipe; the wave keeps the moves (the swipe never sees them)
  // and a horizontal move of 8px within 450ms cancels the hold and seeks. A
  // still finger at 450ms is the bubble's long-press. The wave is touch-none,
  // select-none and callout-free, so no native selection or callout starts.
  const wave = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== 'mouse') {
        touch.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, phase: 'pending' };
        return;
      }
      e.stopPropagation();
      touch.current = null;
      if (!canSeek || e.button !== 0) return;
      beginDrag(e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const held = touch.current;
      if (held === null) {
        e.stopPropagation();
        if (drag !== null) setDrag(fractionAt(e.clientX));
        return;
      }
      if (held.phase === 'hold') return;
      e.stopPropagation();
      if (held.phase === 'pending') {
        held.phase = waveTouchPhase(held, { x: e.clientX, y: e.clientY, t: e.timeStamp });
        if (held.phase === 'hold') return;
        if (held.phase === 'seek' || held.phase === 'none') cancelHolds(e);
        if (held.phase === 'seek') {
          if (canSeek) beginDrag(e);
          else held.phase = 'none';
        }
        return;
      }
      if (held.phase === 'seek' && drag !== null) setDrag(fractionAt(e.clientX));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const held = touch.current;
      touch.current = null;
      // A touch release reaches the bubble so its swipe and hold reset.
      if (held === null) e.stopPropagation();
      if (drag === null) return;
      seekTo(fractionAt(e.clientX));
      setDrag(null);
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (touch.current === null) e.stopPropagation();
      touch.current = null;
      setDrag(null);
    },
    onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => {
      const held = touch.current;
      if (held === null) return;
      // Never the native menu or callout. A still touch is the bubble's hold
      // (its contextmenu acts as the hold); a seek or a moved touch is not.
      e.preventDefault();
      if (held.phase === 'pending' || held.phase === 'hold') {
        held.phase = 'hold';
        return;
      }
      e.stopPropagation();
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (total === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowRight' ? 5 : -5;
      seekTo(Math.min(1, Math.max(0, (current + step) / total)));
    },
  };

  const view = transcriptView(record, pending);
  const received = !mine;
  const link =
    received && messageId !== undefined ? (
      <TranscribeLink
        state={transcribeLinkState(view)}
        onTranscribe={onTranscribe}
        onCollapse={(collapsed) => voiceStore.update(messageId, { collapsed })}
      />
    ) : null;
  // Own notes carry no link, so a stored transcript there is always open.
  const dropOpen = view.kind === 'shown' && (mine || !view.collapsed);
  const showDrop = messageId !== undefined && (received || view.kind === 'shown');
  const metaSlot =
    meta !== undefined ? (
      <span data-voice-meta="" className="ml-auto flex shrink-0 items-center [&>*]:mt-0">
        {meta}
      </span>
    ) : null;

  // 44x44 hit area around the 36px square play control (primary button look).
  const playControl = (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-label={playing ? 'Pause voice note' : 'Play voice note'}
      {...(uploading ? { 'aria-hidden': true, tabIndex: -1 } : {})}
      className={cn(
        'group/play flex h-11 w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        upload === undefined
          ? 'disabled:opacity-40'
          : cn(
              'transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
              uploading ? 'invisible opacity-0' : url === null ? 'opacity-40' : 'opacity-100',
            ),
      )}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-fg group-hover/play:bg-accent-hover">
        {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
      </span>
    </button>
  );
  // An own note sent this session: the play spot holds the ring while it
  // uploads (40px, absolutely centred inside the 44px spot, so nothing moves
  // and nothing leaves the slot), then play.
  // The slot is the same element with or without an upload, so play never
  // remounts (or loses focus) when the send records and the ring goes.
  const playButton = (
    <div
      data-voice-play-slot={upload === undefined ? undefined : uploading ? 'upload' : 'play'}
      className={cn('relative h-11 w-11 shrink-0', received && '-ml-1')}
    >
      {playControl}
      {upload !== undefined ? (
        <UploadRing
          progress={upload.progress}
          onCancel={upload.onCancel}
          hidden={!uploading}
          variant="voice"
          className={VOICE_RING_POSITION}
        />
      ) : null}
    </div>
  );

  // The 44px photo slot: the sender photo (40px) with the mic badge, or while
  // playing the speed pill.
  const photoSlot = (
    <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center', mine && '-ml-0.5')}>
      {playing ? (
        <button
          type="button"
          data-voice-speed=""
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speedLabel(rate)}`}
          className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-xs text-accent-fg">
            {speedLabel(rate)}
          </span>
        </button>
      ) : sender !== undefined ? (
        <span className="relative flex" data-voice-played={played ? '' : undefined}>
          <Avatar
            name={sender.name}
            {...(sender.src !== undefined ? { src: sender.src } : {})}
            size="header"
          />
          <span
            aria-hidden="true"
            data-voice-mic=""
            className={cn(
              'absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full',
              mine ? 'bg-bubble-own' : 'bg-panel-2',
              mine
                ? played
                  ? 'text-accent-fg'
                  : 'text-accent-fg opacity-60'
                : played
                  ? 'text-accent'
                  : 'text-fg-3',
            )}
          >
            <IconMic size={12} />
          </span>
        </span>
      ) : null}
    </div>
  );

  const duration = (
    <span
      data-voice-duration=""
      className="font-mono text-xs leading-4 tabular-nums text-fg-2"
      title={name}
    >
      {label}
    </span>
  );

  return (
    <div
      data-voice-note=""
      data-voice-side={mine ? 'own' : 'received'}
      className="flex w-full flex-col"
    >
      <audio ref={audioRef} src={url ?? undefined} preload="metadata" className="hidden" />
      <div className="flex items-center gap-2">
        {mine ? photoSlot : null}
        {playButton}
        <div className="flex min-w-[120px] flex-1 flex-col">
          <div
            ref={waveRef}
            data-voice-wave=""
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Seek voice note"
            aria-valuemin={0}
            aria-valuemax={Math.round(total ?? 0)}
            aria-valuenow={Math.round(shownSeconds)}
            aria-valuetext={label}
            {...wave}
            className="relative flex h-11 cursor-pointer touch-none select-none items-center [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <div
              data-voice-bars={peaks !== undefined && peaks.length > 0 ? 'peaks' : 'fallback'}
              className={cn(
                'flex h-6 w-full items-center gap-0.5',
                upload !== undefined &&
                  'transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
                uploading && 'invisible opacity-0',
              )}
              aria-hidden="true"
            >
              {bars.map((height, index) => (
                <span
                  key={index}
                  data-played={barPlayed(index, progress, bars.length) ? '' : undefined}
                  className={cn(
                    'flex-1 rounded-sm',
                    barPlayed(index, progress, bars.length) ? 'bg-accent' : 'bg-fg-3',
                  )}
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            {upload !== undefined ? (
              // While uploading: a plain flat line, the wave's full length.
              <span
                aria-hidden="true"
                data-voice-flat={uploading ? 'shown' : 'hidden'}
                className={cn(
                  'pointer-events-none absolute inset-x-0 top-1/2 -mt-px h-0.5 rounded-full bg-fg-3',
                  'transition-opacity duration-150 motion-reduce:transition-none',
                  uploading ? 'opacity-100' : 'opacity-0',
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              data-voice-dot=""
              className={cn(
                'pointer-events-none absolute top-1/2 -ml-1.5 -mt-1.5 h-3 w-3 rounded-full',
                mine ? 'bg-accent-fg' : 'bg-accent',
                upload !== undefined &&
                  'transition-opacity duration-150 motion-reduce:transition-none',
                uploading && 'opacity-0',
              )}
              style={{ left: `${progress}%` }}
            />
          </div>
          {/* Row 2: the length under the wave's start; own notes end it with the time and ticks. */}
          <div className="-mt-1 flex min-h-4 items-center gap-2 whitespace-nowrap">
            {duration}
            {mine ? metaSlot : null}
          </div>
        </div>
        {received ? photoSlot : null}
      </div>
      {received && (link !== null || metaSlot !== null) ? (
        // Row 3: a fixed 44px row, so a label change never moves the time.
        <div data-voice-foot="" className="flex h-11 items-center gap-3 whitespace-nowrap">
          <span className="flex min-w-0 items-center gap-1" {...STOP_POINTER}>
            {link}
          </span>
          {metaSlot}
        </div>
      ) : null}
      {mine ? <OwnTranscriptStatus view={view} /> : null}
      {showDrop ? (
        <TranscriptDrop text={view.kind === 'shown' ? view.text : ''} open={dropOpen} />
      ) : null}
      {spacer !== undefined ? (
        <p className="h-3 text-xs leading-3" aria-hidden="true">
          {spacer}
        </p>
      ) : null}
    </div>
  );
}
