// The reminder chime: its own short two-note tone (Web Audio, never the message
// tone in notify-sound.ts), played up to three times over about five seconds.
//
// Browsers (iPhone Safari above all) only start audio after a user gesture, so
// the AudioContext is created lazily on the first pointerdown or keydown and
// never before. A chime asked for before that gesture waits and plays on the
// first tap after open. stop() silences it at once and cancels the repeats;
// dispose() also closes the context and removes the unlock listeners.

/** The repeats of one chime and their spacing: three tones over about 5 s. */
export const CHIME_REPEATS = 3;
export const CHIME_GAP_MS = 2_000;
/** One tone: two notes, the second a fifth above, each with a short decay. */
const NOTES_HZ = [880, 1320] as const;
const NOTE_S = 0.32;
const NOTE_GAP_S = 0.14;
const PEAK_GAIN = 0.18;

/** The slice of AudioContext the chime uses (a fake in tests). */
export interface ChimeAudioContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): ChimeOscillator;
  createGain(): ChimeGain;
}

export interface ChimeOscillator {
  type: string;
  frequency: { setValueAtTime(value: number, at: number): unknown };
  connect(node: unknown): unknown;
  start(at: number): void;
  stop(at?: number): void;
  disconnect(): void;
}

export interface ChimeGain {
  gain: {
    setValueAtTime(value: number, at: number): unknown;
    linearRampToValueAtTime(value: number, at: number): unknown;
    exponentialRampToValueAtTime(value: number, at: number): unknown;
  };
  connect(node: unknown): unknown;
  disconnect(): void;
}

/** Where the unlock listens (window in the app, a fake in tests). */
export interface GestureTarget {
  addEventListener(type: 'pointerdown' | 'keydown', listener: () => void, options?: boolean): void;
  removeEventListener(
    type: 'pointerdown' | 'keydown',
    listener: () => void,
    options?: boolean,
  ): void;
}

export interface Chime {
  /** Play one chime (three tones, or `repeats`); replaces one already playing. Returns its stop. */
  play(repeats?: number): () => void;
  /** Silence the current chime and cancel its repeats (or a pending one). */
  stop(): void;
  /** Whether a chime has repeats still to play or is waiting for the first gesture. */
  active(): boolean;
  /** Stop, close the context and remove the gesture listeners. */
  dispose(): void;
}

interface ChimeDeps {
  createContext?: () => ChimeAudioContext | null;
  target?: GestureTarget | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function defaultContext(): ChimeAudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    return new Ctor() as unknown as ChimeAudioContext;
  } catch {
    return null;
  }
}

/**
 * Create the chime. Nothing audible or allocated happens until a gesture on
 * `target` (default: window) and a play() call.
 */
export function createChime(deps: ChimeDeps = {}): Chime {
  const makeContext = deps.createContext ?? defaultContext;
  const target: GestureTarget | null =
    deps.target !== undefined ? deps.target : typeof window !== 'undefined' ? window : null;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let ctx: ChimeAudioContext | null = null;
  let unlocked = false;
  let pending = false;
  let pendingRepeats = CHIME_REPEATS;
  let timers: unknown[] = [];
  let voices: { osc: ChimeOscillator; gain: ChimeGain }[] = [];
  let disposed = false;

  function silence(): void {
    for (const { osc, gain } of voices) {
      try {
        osc.stop();
      } catch {
        // Already stopped on its own schedule.
      }
      osc.disconnect();
      gain.disconnect();
    }
    voices = [];
  }

  function tone(): void {
    if (ctx === null) return;
    const start = ctx.currentTime + 0.01;
    NOTES_HZ.forEach((hz, i) => {
      if (ctx === null) return;
      const at = start + i * NOTE_GAP_S;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + NOTE_S + 0.02);
      voices.push({ osc, gain });
    });
  }

  function clearTimers(): void {
    for (const t of timers) clearTimer(t);
    timers = [];
  }

  function stop(): void {
    pending = false;
    clearTimers();
    silence();
  }

  function start(repeats: number): void {
    clearTimers();
    silence();
    if (ctx !== null && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const count = Math.max(1, Math.floor(repeats));
    for (let i = 0; i < count; i += 1) {
      timers.push(
        setTimer(() => {
          if (i === count - 1) timers = [];
          tone();
        }, i * CHIME_GAP_MS),
      );
    }
  }

  function onGesture(): void {
    if (disposed) return;
    if (ctx === null) ctx = makeContext();
    if (ctx === null) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    unlocked = true;
    removeListeners();
    if (pending) {
      pending = false;
      start(pendingRepeats);
    }
  }

  function removeListeners(): void {
    target?.removeEventListener('pointerdown', onGesture, true);
    target?.removeEventListener('keydown', onGesture, true);
  }

  target?.addEventListener('pointerdown', onGesture, true);
  target?.addEventListener('keydown', onGesture, true);

  return {
    play(repeats = CHIME_REPEATS) {
      if (disposed) return () => {};
      if (!unlocked || ctx === null) {
        pending = true;
        pendingRepeats = repeats;
      } else {
        start(repeats);
      }
      return stop;
    },
    stop,
    active: () => pending || timers.length > 0,
    dispose() {
      disposed = true;
      stop();
      removeListeners();
      const closing = ctx;
      ctx = null;
      if (closing !== null) void closing.close().catch(() => undefined);
    },
  };
}
