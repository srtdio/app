// The chat's incoming-message tone and tab badge. The tone is synthesised with
// Web Audio (two short soft sine notes, no audio file) and plays only for a
// live message from someone else when the tab is hidden or the message is in a
// chat other than the open one; never for own messages, never for anything
// replayed on load or catch-up, and at most once per 2s. The tab title carries
// "(N) " for the total unread across the user's chats, gone at 0. The rules are
// pure and unit-tested; the hook (ChatTabSignals) only wires them.

/** At most one tone per this window. */
export const TONE_THROTTLE_MS = 2_000;

/** A message older than this when it arrives is a replay (load, catch-up): no tone. */
const TONE_REPLAY_WINDOW_MS = 10_000;

/** One incoming live message, as the store commits it. */
export interface ToneInput {
  /** The message is the viewer's own (another device). */
  own: boolean;
  /** The chat it belongs to. */
  channelId: string;
  /** Its created_at (ms). */
  messageAtMs: number;
  /** When the chat list became ready (ms); null while it is still loading. */
  readyAtMs: number | null;
  /** The chat open on screen, if any. */
  activeChannelId: string | null;
  /** document.hidden. */
  tabHidden: boolean;
  /** The last tone (ms), null before the first. */
  lastToneAtMs: number | null;
  nowMs: number;
}

/** Whether this message plays the tone. Pure. */
export function shouldPlayTone(input: ToneInput): boolean {
  if (input.own) return false;
  // Initial load: nothing tones until the list is ready, and nothing sent before it.
  if (input.readyAtMs === null || input.messageAtMs < input.readyAtMs) return false;
  // Catch-up replay: a message that is already old when it arrives.
  if (input.nowMs - input.messageAtMs > TONE_REPLAY_WINDOW_MS) return false;
  if (!input.tabHidden && input.channelId === input.activeChannelId) return false;
  if (input.lastToneAtMs !== null && input.nowMs - input.lastToneAtMs < TONE_THROTTLE_MS) {
    return false;
  }
  return true;
}

const PREFIX = /^\(\d+\) /;

/** The tab title with "(N) " for N unread, or bare at 0; any old prefix is replaced. Pure. */
export function tabTitle(title: string, unread: number): string {
  const bare = title.replace(PREFIX, '');
  return unread > 0 ? `(${unread}) ${bare}` : bare;
}

/** The Web Audio surface the tone needs (an AudioContext, or a test fake). */
export interface ToneContext {
  currentTime: number;
  state?: string;
  destination: unknown;
  resume?: () => Promise<void>;
  createOscillator: () => {
    type: string;
    frequency: { setValueAtTime: (value: number, at: number) => void };
    connect: (node: unknown) => unknown;
    start: (at: number) => void;
    stop: (at: number) => void;
  };
  createGain: () => {
    gain: {
      setValueAtTime: (value: number, at: number) => void;
      linearRampToValueAtTime: (value: number, at: number) => void;
      exponentialRampToValueAtTime: (value: number, at: number) => void;
    };
    connect: (node: unknown) => unknown;
  };
}

let shared: ToneContext | null = null;

function audioContext(): ToneContext | null {
  if (shared !== null) return shared;
  if (typeof window === 'undefined') return null;
  const Ctor =
    (window as unknown as { AudioContext?: new () => ToneContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: new () => ToneContext }).webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/**
 * Play the soft two-note tone (about 220ms). Silent where Web Audio is missing
 * or the browser has not allowed audio yet; never throws.
 */
export function playNotifyTone(ctx: ToneContext | null = audioContext()): boolean {
  if (ctx === null) return false;
  try {
    if (ctx.state === 'suspended') void ctx.resume?.().catch(() => undefined);
    const t0 = ctx.currentTime;
    const notes: readonly [number, number][] = [
      [880, 0],
      [1320, 0.09],
    ];
    for (const [freq, offset] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + offset);
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.linearRampToValueAtTime(0.06, t0 + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.14);
    }
    return true;
  } catch {
    return false;
  }
}

// The last tone from ANY source (chat or Activity), device clock: the two never
// double up inside TONE_THROTTLE_MS.
let lastSharedToneMs: number | null = null;

/**
 * Play the tone unless any source played it within TONE_THROTTLE_MS. Chat and
 * Activity both call this, so a chat message and an Activity row arriving
 * together sound once. Returns whether it played.
 */
export function playToneShared(
  nowMs: number = Date.now(),
  ctx: ToneContext | null = audioContext(),
): boolean {
  if (lastSharedToneMs !== null && nowMs - lastSharedToneMs < TONE_THROTTLE_MS) return false;
  if (!playNotifyTone(ctx)) return false;
  lastSharedToneMs = nowMs;
  return true;
}

/** Test hook: forget the last shared tone. */
export function resetSharedTone(): void {
  lastSharedToneMs = null;
}
