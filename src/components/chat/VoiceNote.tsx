// The voice-note body that sits inside the normal message bubble shell (same
// radius and own/peer fill as a text bubble, owned by MessageBubble). One
// layout for both sides, only the colours differ. In a chat bubble the note
// is a fixed 264px wide with a 4px top/bottom, 6px right and 0 left inset (it
// pulls out of the shell's padding). Row 1: [play 44x44, a bare 20px glyph]
// [waveform: 30 bars from the stored peaks and a 10px seek dot] [sender photo
// 34px + a 14px mic badge, or while playing the speed pill 1x / 1.5x / 2x,
// remembered for the session across notes]. Row 2 starts under the wave
// (46px): the length (elapsed while playing or paused mid-way) · Transcribe /
// Hide text left, the bubble's time and ticks right. The transcript panel
// drops down under row 2; when playback failed an error row there offers
// "Read the transcript". The received mic badge is accent until this device
// has played the note to the end once, then muted. When a note ends and the
// message right below is an unplayed voice note from the same sender, that
// one starts 350ms later. One note plays at a time across the app.
//
// The length shows before play from the stored durationMs (the recorder's
// value); a finite media duration (loadedmetadata or durationchange) refines
// it, and a non-finite one (MediaRecorder webm reports Infinity) never replaces
// it. No recording here. The url is handed in (null while the presign is still
// in flight) and set on the element imperatively, so a background refresh
// never reloads a note that is playing or paused mid-way. A tap plays from a
// fresh url: when the held one is expired or within 60s of expiry the note
// asks for a new presign first (refreshUrl). The first media error or play()
// rejection forces one re-presign and retries once; a second failure shows the
// error row and is logged (error name, MediaError code, mime, retried).
//
// The transcript state is read synchronously from the per-device transcript
// store so first paint is final.
//
// While an own note uploads, the play spot holds the UploadRing (tap X cancels
// the send) and the wave is a plain flat line of the same length; when the
// upload finishes, X becomes play and the line becomes the waveform in a 150ms
// opacity crossfade (nothing moves or resizes).

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
import { sized, useChatLayout, type ChatSize } from '@/components/chat/chat-type';
import {
  ICON_SIZE,
  IconAlertTriangle,
  IconMic,
  IconPauseFill,
  IconPlay,
} from '@/components/ui/icons';
import {
  cancelPendingLongPressesWithin,
  LONG_PRESS_MS,
  MOVE_CANCEL_PX,
} from '@/components/ui/useLongPress';
import { PressableRow } from '@/components/ui/PressableRow';
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
 * Fixed decorative levels (percent): the fallback for a note without peaks
 * (older notes, older clients), resampled to the bar count like real peaks.
 */
export const WAVEFORM_BARS: readonly number[] = [
  35, 60, 45, 80, 55, 70, 40, 90, 50, 65, 30, 75, 48, 85, 42, 68, 38, 72, 52, 58,
];

/** How many bars the wave draws. */
export const VOICE_BAR_COUNT = 30;

/** The shortest bar (px), so a quiet stretch still shows a mark. */
export const MIN_BAR_PX = 3;

/** The tallest bar (px). */
export const MAX_BAR_PX = 20;

/**
 * The bar heights (px, MIN_BAR_PX..MAX_BAR_PX) to draw: the note's peaks
 * resampled to the bar count when it has them, else the fixed fallback. Pure.
 */
export function voiceBars(peaks: readonly number[] | undefined): readonly number[] {
  const source = peaks === undefined || peaks.length === 0 ? WAVEFORM_BARS : peaks;
  return resamplePeaks(source, VOICE_BAR_COUNT).map((level) =>
    Math.round(MIN_BAR_PX + (Math.min(100, Math.max(0, level)) / 100) * (MAX_BAR_PX - MIN_BAR_PX)),
  );
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
  /** The element's MediaError, when it has one. */
  error?: { code: number } | null;
  pause: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Wire an audio element's events to the note's state. A duration event only
 * reports a usable (finite, positive) value, so Infinity or NaN never
 * overwrites what the note already shows. `error` hears the element's media
 * errors (with the MediaError code, null when absent), `started` the
 * 'playing' event (audio is actually coming out), `paused` every 'pause',
 * `buffering` 'waiting' and 'stalled', `seeking` / `seeked` the seek pair.
 * Returns the teardown, which removes every listener it added.
 */
export function bindVoiceAudio(
  audio: VoiceAudio,
  on: {
    duration: (seconds: number) => void;
    time: (seconds: number) => void;
    playing: (playing: boolean) => void;
    ended: () => void;
    error?: (code: number | null) => void;
    started?: () => void;
    paused?: () => void;
    buffering?: () => void;
    seeking?: () => void;
    seeked?: () => void;
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
  const onPause = (): void => {
    on.playing(false);
    on.paused?.();
  };
  const onEnded = (): void => {
    voicePlayback.release(audio);
    on.ended();
  };
  const onError = (): void => on.error?.(audio.error?.code ?? null);
  const onStarted = (): void => on.started?.();
  const onBuffering = (): void => on.buffering?.();
  const onSeeking = (): void => on.seeking?.();
  const onSeeked = (): void => on.seeked?.();
  const events: Array<[string, () => void]> = [
    ['loadedmetadata', onDuration],
    ['durationchange', onDuration],
    ['timeupdate', onTime],
    ['play', onPlay],
    ['playing', onStarted],
    ['pause', onPause],
    ['ended', onEnded],
    ['error', onError],
    ['waiting', onBuffering],
    ['stalled', onBuffering],
    ['seeking', onSeeking],
    ['seeked', onSeeked],
  ];
  for (const [type, fn] of events) audio.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of events) audio.removeEventListener(type, fn);
  };
}

/** A play attempt must show 'playing' and then move currentTime within this. */
export const VOICE_START_TIMEOUT_MS = 10_000;
/** Mid-play, 'waiting' or 'stalled' with no currentTime progress for this long fails. */
export const VOICE_STALL_TIMEOUT_MS = 15_000;
/** A seek with no 'seeked' within this fails. */
export const VOICE_SEEK_TIMEOUT_MS = 5_000;

/** What failed: a media error, a play() rejection, no progress, or a seek that never lands. */
export type VoiceFailReason = 'error' | 'reject' | 'stall' | 'seek';

/** What a final playback failure reports (never a user id or a url). */
export interface VoiceFailure {
  name: string;
  /** The MediaError code, null for any other failure. */
  code: number | null;
  retried: boolean;
  reason: VoiceFailReason;
}

/** The element-side moves the recovery makes; the component backs it with the <audio>. */
export interface VoicePlayer {
  /** The url set on the element, null before one is. */
  readonly applied: string | null;
  /** The element's playback position in seconds. */
  readonly currentTime: number;
  /** Point the element at a url (keeping the position when paused mid-way). */
  apply: (url: string) => void;
  play: () => Promise<void>;
}

type Failure = Omit<VoiceFailure, 'retried'>;

/**
 * The playback recovery: plays from a fresh url and watches each attempt. An
 * attempt succeeds once 'playing' fired and a later timeupdate moved
 * currentTime; with no success within VOICE_START_TIMEOUT_MS it fails. Once
 * playing, 'waiting' / 'stalled' with no progress for VOICE_STALL_TIMEOUT_MS
 * fails, and so does a seek with no 'seeked' within VOICE_SEEK_TIMEOUT_MS. A
 * media error, a play() rejection (an AbortError from a quick pause or a src
 * swap is not one) and a pause the element makes during an attempt fail too.
 * The first failure forces one re-presign and retries once (a play retries
 * only when a play was wanted); a second failure, or a re-presign that fails,
 * is final: `failed` is called once. Each attempt counts one failure; later
 * signals for the same attempt are the same result. A failure while a
 * re-presign is in flight is held and settles as the result once it returns.
 * Only `cancel` (a user pause, another note starting, unmount) stops a
 * pending retry, without a failure. Every timer is cleared on cancel, end,
 * source change and failure. DOM-free so it is unit-tested with fakes.
 */
export function createVoiceRecovery(deps: {
  player: VoicePlayer;
  /** A still-valid url (more than 60s from expiry), else null. */
  peekUrl: () => string | null;
  /** A url from the presign cache (force: always a new presign); null on failure. */
  refreshUrl: (force: boolean) => Promise<string | null>;
  failed: (failure: VoiceFailure) => void;
  /** Whether a play is wanted (a tap until it is paused, ends or fails). */
  wanted?: (wanted: boolean) => void;
}): {
  /** A tap (or the auto-play chain): play from a fresh url. */
  play: () => void;
  /** A user pause, another note starting, or unmount: stop without a failure. */
  cancel: () => void;
  /** The element reported a media error. */
  mediaError: (code: number | null) => void;
  /** The element fired 'playing'. */
  started: () => void;
  /** A timeupdate at `seconds`. */
  progress: (seconds: number) => void;
  /** The element fired 'waiting' or 'stalled'. */
  buffering: () => void;
  /** The element fired 'seeking'. */
  seeking: () => void;
  /** The element fired 'seeked'. */
  seeked: () => void;
  /** The element paused on its own (not a user pause). */
  elementPaused: () => void;
  /** The note ended. */
  stopped: () => void;
  /** The element's source was swapped outside the recovery. */
  sourceChanged: () => void;
} {
  let wantPlay = false;
  let retried = false;
  let busy = false;
  let done = false;
  // Bumped by cancel: a re-presign started before it settles without a result.
  let epoch = 0;
  // The current attempt, and the last one whose failure was counted.
  let attemptId = 0;
  let failedId = -1;
  // 'starting' until the attempt shows progress, then 'playing'.
  let live: 'none' | 'starting' | 'playing' = 'none';
  let sawPlaying = false;
  let baseline = 0;
  let stallAt = 0;
  let held: Failure | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let seekTimer: ReturnType<typeof setTimeout> | null = null;

  const want = (next: boolean): void => {
    if (wantPlay === next) return;
    wantPlay = next;
    deps.wanted?.(next);
  };
  const clearTimers = (): void => {
    if (startTimer !== null) clearTimeout(startTimer);
    if (stallTimer !== null) clearTimeout(stallTimer);
    if (seekTimer !== null) clearTimeout(seekTimer);
    startTimer = null;
    stallTimer = null;
    seekTimer = null;
  };
  const final = (failure: Failure, didRetry: boolean): void => {
    clearTimers();
    done = true;
    live = 'none';
    want(false);
    deps.failed({ ...failure, retried: didRetry });
  };
  const attempt = (): void => {
    clearTimers();
    attemptId += 1;
    const id = attemptId;
    live = 'starting';
    sawPlaying = false;
    baseline = deps.player.currentTime;
    startTimer = setTimeout(() => {
      startTimer = null;
      if (attemptId === id && live === 'starting') {
        fail({ name: 'NoProgress', code: null, reason: 'stall' });
      }
    }, VOICE_START_TIMEOUT_MS);
    void deps.player.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // A rejection from an attempt a newer one replaced is not this attempt's.
      if (attemptId !== id) return;
      fail({ name: error instanceof Error ? error.name : 'unknown', code: null, reason: 'reject' });
    });
  };
  // Count a failure as the current attempt's result: retry once, then final.
  const count = (failure: Failure): void => {
    failedId = attemptId;
    live = 'none';
    clearTimers();
    if (retried) {
      final(failure, true);
      return;
    }
    retried = true;
    withUrl(true, failure, () => {
      if (wantPlay) attempt();
    });
  };
  // Resolve a url (forced or from the cache), apply it, then run `then`.
  const withUrl = (force: boolean, cause: Failure | null, then: () => void): void => {
    busy = true;
    held = null;
    const at = epoch;
    void deps.refreshUrl(force).then((url) => {
      busy = false;
      const result = held;
      held = null;
      // Cancelled meanwhile with no play tapped since: no failure, no play.
      if (at !== epoch && !wantPlay) {
        if (url !== null && url !== deps.player.applied) deps.player.apply(url);
        return;
      }
      if (url === null) {
        final({ name: 'PresignError', code: null, reason: cause?.reason ?? 'error' }, retried);
        return;
      }
      if (force || url !== deps.player.applied) deps.player.apply(url);
      if (result !== null) {
        count(result);
        return;
      }
      then();
    });
  };
  function fail(failure: Failure): void {
    if (done) return;
    // A later signal for an attempt already counted is the same result.
    if (failedId === attemptId && live === 'none') return;
    if (busy) {
      held ??= failure;
      return;
    }
    count(failure);
  }

  return {
    play() {
      want(true);
      retried = false;
      done = false;
      if (busy) return;
      const fresh = deps.peekUrl();
      if (fresh !== null) {
        if (fresh !== deps.player.applied) deps.player.apply(fresh);
        attempt();
        return;
      }
      withUrl(false, null, attempt);
    },
    cancel() {
      epoch += 1;
      held = null;
      live = 'none';
      clearTimers();
      want(false);
    },
    mediaError(code) {
      fail({ name: 'MediaError', code, reason: 'error' });
    },
    started() {
      sawPlaying = true;
      baseline = deps.player.currentTime;
    },
    progress(seconds) {
      if (live === 'starting') {
        if (!sawPlaying || seconds <= baseline) return;
        live = 'playing';
        if (startTimer !== null) clearTimeout(startTimer);
        startTimer = null;
        // Audio is coming out: the next failure starts a fresh retry.
        retried = false;
        return;
      }
      if (live === 'playing' && stallTimer !== null && seconds > stallAt) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    },
    buffering() {
      if (live !== 'playing' || stallTimer !== null) return;
      stallAt = deps.player.currentTime;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (live === 'playing' && deps.player.currentTime <= stallAt) {
          fail({ name: 'Stall', code: null, reason: 'stall' });
        }
      }, VOICE_STALL_TIMEOUT_MS);
    },
    seeking() {
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        seekTimer = null;
        fail({ name: 'SeekTimeout', code: null, reason: 'seek' });
      }, VOICE_SEEK_TIMEOUT_MS);
    },
    seeked() {
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = null;
    },
    elementPaused() {
      if (live === 'starting' || (busy && wantPlay)) {
        fail({ name: 'Paused', code: null, reason: 'stall' });
        return;
      }
      // A pause while playing (an interruption): the note simply stops.
      live = 'none';
      clearTimers();
      want(false);
    },
    stopped() {
      live = 'none';
      clearTimers();
      want(false);
    },
    sourceChanged() {
      clearTimers();
    },
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
  /** Whether `audio` is the one note claimed now. */
  owns: (audio: Pausable) => boolean;
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
    owns(audio) {
      return active === audio;
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

/** The Transcribe button's state in row 2. */
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

/**
 * The in-bubble inset: pull out of the shell's padding (BUBBLE_PAD) to a 4px
 * top/bottom, 6px right, 0 left edge, at a fixed 264px. The top pulls up only
 * when nothing (a reply quote, a forwarded label, a mark) sits above the note.
 */
const BUBBLE_INSET: ChatSize = {
  touch:
    'w-[264px] -mx-3 -mb-2 [[data-bubble]>:empty+[data-bubble-content]>:first-child>*>&]:-mt-2',
  laptop:
    'w-[264px] -ml-[9px] -mr-[7px] -mb-[8px] [[data-bubble]>:empty+[data-bubble-content]>:first-child>*>&]:-mt-[6px]',
};

/** Row 2 and the error row start under the wave: 44px play + 2px gap. */
const UNDER_WAVE = 'pl-[46px]';

/**
 * A 44px tall text control on a 16px row, without growing the row: the
 * PressableRow is 44 tall (its min-h) and -14px margins top and bottom give
 * back the 28px, with the text centred.
 */
const TALL_HIT = 'flex -my-3.5 items-center';

/** Per side colours. Sent avoids the class names the own bubble restyles. */
function sideTone(mine: boolean): {
  glyph: string;
  played: string;
  unplayed: string;
  ink: string;
  focus: string;
  ring: string;
  panel: string;
  panelInk: string;
  pill: string;
} {
  return mine
    ? {
        glyph: 'text-accent-fg',
        played: 'bg-accent-fg',
        unplayed: 'bg-white/[.45]',
        ink: 'text-accent-fg',
        focus: 'focus-visible:ring-accent-fg',
        ring: 'ring-bubble-own',
        panel: 'bg-white/[.16]',
        panelInk: 'text-accent-fg',
        pill: 'bg-white/[.22] text-accent-fg',
      }
    : {
        glyph: 'text-accent',
        played: 'bg-accent',
        unplayed: 'bg-fg-3',
        ink: 'text-fg-2',
        focus: 'focus-visible:ring-accent',
        ring: 'ring-panel-2',
        panel: 'bg-panel-3',
        panelInk: 'text-fg',
        pill: 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent',
      };
}

/** The Transcribe / Hide text control in row 2; null when there is nothing to offer. */
function transcribeLink(props: {
  state: TranscribeLinkState;
  onTranscribe: (() => void) | undefined;
  onCollapse: (collapsed: boolean) => void;
  className: string;
}): ReactElement | null {
  const { state, onTranscribe, className } = props;
  switch (state) {
    case 'transcribe':
    case 'failed':
      return onTranscribe === undefined ? null : (
        <PressableRow
          inline
          type="button"
          data-voice-control=""
          data-voice-link={state === 'failed' ? 'retry' : 'transcribe'}
          data-induction={INDUCTION_KEYS.chatTranscript}
          onClick={onTranscribe}
          className={className}
        >
          Transcribe
        </PressableRow>
      );
    case 'pending':
      return (
        <span data-voice-link="pending" role="status" className="shrink-0 font-semibold">
          Transcribing…
        </span>
      );
    case 'hide':
    case 'show':
      return (
        <PressableRow
          inline
          type="button"
          data-voice-control=""
          data-voice-link={state}
          data-induction={INDUCTION_KEYS.chatTranscript}
          aria-expanded={state === 'hide'}
          onClick={() => props.onCollapse(state === 'hide')}
          className={className}
        >
          {state === 'hide' ? 'Hide text' : 'Transcribe'}
        </PressableRow>
      );
  }
}

/**
 * The transcript panel: a rounded tinted box with the selectable text. It
 * reveals on height only (grid rows 0fr to 1fr), 180ms ease-out, Y only;
 * reduced motion shows it at once. It mounts in its current state, so a stored
 * transcript paints open on first paint with no transition. The width never
 * changes.
 */
function TranscriptDrop(props: {
  text: string;
  open: boolean;
  panel: string;
  ink: string;
}): ReactElement {
  const { text, open } = props;
  return (
    <div
      data-voice-transcript={open ? 'open' : 'closed'}
      aria-hidden={open ? undefined : true}
      className={cn(
        'grid transition-[grid-template-rows] duration-[180ms] ease-out motion-reduce:transition-none',
        open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="pl-1.5 pt-1">
          <p
            dir="auto"
            className={cn(
              'select-text whitespace-pre-wrap rounded-[14px] px-3 py-2 [overflow-wrap:anywhere] text-lg',
              props.panel,
              props.ink,
            )}
          >
            {text}
          </p>
        </div>
      </div>
    </div>
  );
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
  mime,
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
  storedTranscript,
  peekUrl,
  refreshUrl,
  bubbleInset = false,
}: {
  url: string | null;
  name: string;
  /** The attachment's MIME, for the failure log only. */
  mime?: string | undefined;
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
  /** Own bubble: the controls, bars and badge draw on the bubble-own fill. */
  mine?: boolean | undefined;
  /** Whose photo fills the photo slot while the note is not playing. */
  sender?: { name: string; src?: string | undefined } | undefined;
  /** The message right below, when it is a voice note from the same sender. */
  nextVoiceId?: string | null | undefined;
  /** The bubble's time (and ticks), right of row 2. */
  meta?: ReactNode;
  /** Recorded notes: run the tap-to-transcribe flow. */
  onTranscribe?: (() => void) | undefined;
  /**
   * A transcript stored on the message itself (attachment_meta), as the
   * onboarding sample week's voice note carries: shown folded until tapped,
   * with no transcription call.
   */
  storedTranscript?: string | undefined;
  /** A presigned note: the cached url while it is more than 60s from expiry, else null. */
  peekUrl?: (() => string | null) | undefined;
  /** A presigned note: a url through the presign cache (force: a new presign); null on failure. */
  refreshUrl?: ((force: boolean) => Promise<string | null>) | undefined;
  /** In a chat bubble: the fixed 264px width and the bubble inset. */
  bubbleInset?: boolean | undefined;
}): ReactElement {
  const layout = useChatLayout();
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const appliedRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaSeconds, setMediaSeconds] = useState(Number.NaN);
  const [rate, setRate] = useState(sessionRate);
  const [playFailed, setPlayFailed] = useState(false);
  // A play is wanted (from the tap until a pause, the end or a final failure).
  const [wanted, setWanted] = useState(false);
  // The drag position (0..1) while the wave is held; null when not dragging.
  const [drag, setDrag] = useState<number | null>(null);
  // The touch on the wave, from its pointerdown until it lifts.
  const touch = useRef<{ x: number; y: number; t: number; phase: WaveTouchPhase } | null>(null);
  const { record, pending } = useVoiceRecord(messageId);
  const played = record?.playedAt !== undefined;
  const latest = useRef({ messageId, nextVoiceId, mime, peekUrl, refreshUrl });
  latest.current = { messageId, nextVoiceId, mime, peekUrl, refreshUrl };

  const recoveryRef = useRef<ReturnType<typeof createVoiceRecovery> | null>(null);
  if (recoveryRef.current === null) {
    recoveryRef.current = createVoiceRecovery({
      player: {
        get applied() {
          return appliedRef.current;
        },
        apply(next) {
          const audio = audioRef.current;
          if (audio === null) return;
          const at = audio.currentTime;
          // A non-finite duration (MediaRecorder webm) may never answer a seek,
          // so the position is only restored on a seekable note.
          const seekable = usable(audio.duration);
          audio.src = next;
          appliedRef.current = next;
          if (at > 0 && seekable) audio.currentTime = at;
        },
        get currentTime() {
          return audioRef.current?.currentTime ?? 0;
        },
        play() {
          const audio = audioRef.current;
          return audio === null ? Promise.resolve() : audio.play();
        },
      },
      // A local file (no presign) is always fresh.
      peekUrl: () => {
        const peek = latest.current.peekUrl;
        return peek === undefined ? appliedRef.current : peek();
      },
      refreshUrl: (force) => {
        const refresh = latest.current.refreshUrl;
        return refresh === undefined ? Promise.resolve(appliedRef.current) : refresh(force);
      },
      failed: (failure) => {
        // A stalled load may still deliver later: the failed note stays silent.
        audioRef.current?.pause();
        setPlaying(false);
        setPlayFailed(true);
        logger.error('chat: voice note play failed', {
          name: failure.name,
          code: failure.code,
          mime: latest.current.mime ?? 'unknown',
          retried: failure.retried ? 'yes' : 'no',
          reason: failure.reason,
        });
      },
      wanted: setWanted,
    });
  }
  const recovery = recoveryRef.current;

  // The handed-in url goes on the element unless the note is playing or paused
  // mid-way: a refresh never resets it (a tap picks up the fresh url).
  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || url === null || appliedRef.current === url) return;
    if (appliedRef.current !== null && (!audio.paused || audio.currentTime > 0)) return;
    audio.src = url;
    appliedRef.current = url;
    recovery.sourceChanged();
  }, [url, recovery]);

  const start = (audio: HTMLAudioElement): void => {
    voicePlayback.claim(audio);
    audio.defaultPlaybackRate = sessionRate;
    audio.playbackRate = sessionRate;
    setRate(sessionRate);
    recovery.play();
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    const unbind = bindVoiceAudio(audio, {
      duration: setMediaSeconds,
      time: (seconds) => {
        setCurrent(seconds);
        recovery.progress(seconds);
      },
      playing: setPlaying,
      paused: () => {
        // A late event from before the latest play(), or the end of the note.
        if (!audio.paused || audio.ended) return;
        // Another note took over (the registry paused this one): not a failure.
        if (voicePlayback.owns(audio)) recovery.elementPaused();
        else recovery.cancel();
      },
      buffering: recovery.buffering,
      seeking: recovery.seeking,
      seeked: recovery.seeked,
      error: recovery.mediaError,
      started: () => {
        recovery.started();
        setPlayFailed(false);
      },
      ended: () => {
        recovery.stopped();
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
      recovery.cancel();
      audio.pause();
      voicePlayback.release(audio);
    };
  }, [recovery]);

  // Register this note so the one above it can hand on to it.
  useEffect(() => {
    if (messageId === undefined) return;
    const play = (): void => {
      const audio = audioRef.current;
      if (audio !== null && appliedRef.current !== null) start(audio);
    };
    voiceChain.set(messageId, play);
    return () => {
      if (voiceChain.get(messageId) === play) voiceChain.delete(messageId);
    };
  }, [messageId]);

  // Pause shows from the tap on, through any retry, until it stops or fails.
  const active = playing || wanted;
  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    cancelPendingNext();
    if (active) {
      // The user's pause: stops a pending retry too, with no error row.
      recovery.cancel();
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

  const tone = sideTone(mine);
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
  // Mouse: the wave owns its pointer, a press seeks at once and a drag follows.
  // Touch and pen, WhatsApp style: the press reaches the bubble, which arms its
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

  const withStored =
    storedTranscript !== undefined && storedTranscript !== '' && record?.transcript === undefined
      ? { ...record, transcript: storedTranscript, collapsed: record?.collapsed ?? true }
      : record;
  const view = transcriptView(withStored, pending);
  const dropOpen = view.kind === 'shown' && !view.collapsed;
  const openTranscript = (): void => {
    if (messageId === undefined) return;
    if (view.kind === 'shown') voiceStore.update(messageId, { collapsed: false });
    else onTranscribe?.();
  };
  const canOpenTranscript = view.kind === 'shown' || onTranscribe !== undefined;
  // The controls are PressableRows: their accent focus ring is the base; an
  // own note adds an accent-fg offset so the ring reads on the solid bubble.
  const controlFocus = cn(
    'cursor-pointer select-none [-webkit-touch-callout:none]',
    mine && 'focus-visible:ring-offset-2 focus-visible:ring-offset-accent-fg',
  );
  const link =
    messageId !== undefined
      ? transcribeLink({
          state: transcribeLinkState(view),
          onTranscribe,
          onCollapse: (collapsed) => voiceStore.update(messageId, { collapsed }),
          className: cn('shrink-0 font-semibold', TALL_HIT, controlFocus),
        })
      : null;
  const metaSlot =
    meta !== undefined ? (
      <span data-voice-meta="" className="ml-auto flex shrink-0 items-center [&>*]:mt-0">
        {meta}
      </span>
    ) : null;

  // 44x44 transparent hit area; the visible control is the bare 20px glyph.
  const playControl = (
    <PressableRow
      inline
      type="button"
      data-voice-control=""
      onClick={toggle}
      disabled={disabled}
      aria-label={active ? 'Pause voice note' : 'Play voice note'}
      {...(uploading ? { 'aria-hidden': true, tabIndex: -1 } : {})}
      className={cn(
        'flex h-11 min-w-[44px] shrink-0 items-center justify-center disabled:cursor-default',
        controlFocus,
        tone.glyph,
        upload === undefined
          ? playFailed
            ? 'opacity-[.45]'
            : null
          : cn(
              'transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
              uploading
                ? 'invisible opacity-0'
                : url === null || playFailed
                  ? 'opacity-[.45]'
                  : 'opacity-100',
            ),
      )}
    >
      {active ? <IconPauseFill size={ICON_SIZE.control} /> : <IconPlay size={ICON_SIZE.control} />}
    </PressableRow>
  );
  // An own note sent this session: the play spot holds the ring while it
  // uploads (40px, absolutely centred inside the 44px spot, so nothing moves
  // and nothing leaves the slot), then play.
  // The slot is the same element with or without an upload, so play never
  // remounts (or loses focus) when the send records and the ring goes.
  const playButton = (
    <div
      data-voice-play-slot={upload === undefined ? undefined : uploading ? 'upload' : 'play'}
      className="relative h-11 w-11 shrink-0"
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

  // The 44px right slot: the sender photo (34px) with the 14px mic badge, or
  // while playing the speed pill.
  const photoSlot = (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center">
      {playing ? (
        <PressableRow
          inline
          type="button"
          data-voice-control=""
          data-voice-speed=""
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speedLabel(rate)}`}
          className={cn('flex h-11 min-w-[44px] items-center justify-center', controlFocus)}
        >
          <span
            className={cn(
              'flex h-6 items-center rounded-full px-2 text-sm font-semibold leading-4 tabular-nums',
              tone.pill,
            )}
          >
            {speedLabel(rate)}
          </span>
        </PressableRow>
      ) : sender !== undefined ? (
        <span className="relative flex" data-voice-played={played ? '' : undefined}>
          {/* The 40px header photo drawn at 34px (its box is sized inline). */}
          <span className="flex [&>*]:!h-[34px] [&>*]:!w-[34px]">
            <Avatar
              name={sender.name}
              {...(sender.src !== undefined ? { src: sender.src } : {})}
              size="header"
            />
          </span>
          <span
            aria-hidden="true"
            data-voice-mic={mine ? 'own' : played ? 'played' : 'unplayed'}
            className={cn(
              'absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2',
              tone.ring,
              mine
                ? 'bg-accent-fg text-[color:var(--accent)]'
                : played
                  ? 'bg-fg-3 text-panel-2'
                  : 'bg-accent text-accent-fg',
            )}
          >
            <IconMic size={12} />
          </span>
        </span>
      ) : null}
    </div>
  );

  const showError = playFailed && !dropOpen;

  return (
    <div
      data-voice-note=""
      data-voice-side={mine ? 'own' : 'received'}
      className={cn(
        'flex flex-col font-sans',
        bubbleInset ? cn(sized(BUBBLE_INSET, layout), 'pb-1 pr-1.5 pt-1') : 'w-full',
      )}
    >
      <audio ref={audioRef} preload="metadata" className="hidden" />
      <div className="flex items-center gap-0.5">
        {playButton}
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
          className={cn(
            'relative flex h-11 min-w-0 flex-1 cursor-pointer touch-none select-none items-center rounded-sm [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2',
            tone.focus,
          )}
        >
          <div
            data-voice-bars={peaks !== undefined && peaks.length > 0 ? 'peaks' : 'fallback'}
            className={cn(
              'flex h-7 w-full items-center justify-between',
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
                  'w-0.5 shrink-0 rounded-[1px]',
                  barPlayed(index, progress, bars.length) ? tone.played : tone.unplayed,
                )}
                style={{ height: `${height}px` }}
              />
            ))}
          </div>
          {upload !== undefined ? (
            // While uploading: a plain flat line, the wave's full length.
            <span
              aria-hidden="true"
              data-voice-flat={uploading ? 'shown' : 'hidden'}
              className={cn(
                'pointer-events-none absolute inset-x-0 top-1/2 -mt-px h-0.5 rounded-full',
                tone.unplayed,
                'transition-opacity duration-150 motion-reduce:transition-none',
                uploading ? 'opacity-100' : 'opacity-0',
              )}
            />
          ) : null}
          <span
            aria-hidden="true"
            data-voice-dot=""
            className={cn(
              'pointer-events-none absolute top-1/2 -ml-[5px] -mt-[5px] h-2.5 w-2.5 rounded-full',
              tone.played,
              upload !== undefined &&
                'transition-opacity duration-150 motion-reduce:transition-none',
              uploading && 'opacity-0',
            )}
            style={{ left: `${progress}%` }}
          />
        </div>
        {photoSlot}
      </div>
      {/* Row 2: length · Transcribe under the wave's start, the time and ticks right. */}
      <div
        data-voice-foot=""
        className={cn(
          'flex min-h-4 items-center gap-1 whitespace-nowrap text-sm leading-4',
          UNDER_WAVE,
          tone.ink,
        )}
      >
        <span data-voice-duration="" className="font-medium tabular-nums" title={name}>
          {label}
        </span>
        {link !== null ? (
          <span className="flex min-w-0 items-center gap-1" {...STOP_POINTER}>
            <span aria-hidden="true">·</span>
            {link}
          </span>
        ) : null}
        {metaSlot}
      </div>
      {showError ? (
        <div
          data-voice-error=""
          role="alert"
          className={cn(
            'flex min-h-4 items-center gap-1 whitespace-nowrap text-sm leading-4',
            UNDER_WAVE,
            tone.ink,
          )}
          {...STOP_POINTER}
        >
          <IconAlertTriangle size={ICON_SIZE.inline} className="shrink-0" />
          <span>Can&apos;t play here.</span>
          {canOpenTranscript ? (
            <PressableRow
              inline
              type="button"
              data-voice-control=""
              data-voice-read=""
              onClick={openTranscript}
              className={cn('shrink-0 font-semibold underline', TALL_HIT, controlFocus)}
            >
              Read the transcript
            </PressableRow>
          ) : null}
        </div>
      ) : null}
      {messageId !== undefined ? (
        <TranscriptDrop
          text={view.kind === 'shown' ? view.text : ''}
          open={dropOpen}
          panel={tone.panel}
          ink={tone.panelInk}
        />
      ) : null}
      {spacer !== undefined ? (
        <p className="h-3 text-sm leading-3" aria-hidden="true">
          {spacer}
        </p>
      ) : null}
    </div>
  );
}
