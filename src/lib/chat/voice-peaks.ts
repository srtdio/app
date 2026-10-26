// A voice note's waveform, read from the finished recording. The blob is
// decoded on an OfflineAudioContext (decodeAudioData needs no user gesture
// and no audio session, so it never touches the live microphone), cut into
// PEAK_SAMPLE_MS windows, each window's RMS level taken, and the levels folded
// into PEAK_COUNT peaks by waveform-peaks.ts.
//
// Bounded and best effort: the whole read is capped at PEAK_TIMEOUT_MS. A
// timeout, a decode error, a silent note or a browser without
// OfflineAudioContext all give no peaks (undefined), and the note sends
// anyway with the fixed bars. Never throws, never blocks a send past the cap.

import { downsamplePeaks, PEAK_SAMPLE_MS } from '@/lib/chat/waveform-peaks';

/** The hard cap on reading peaks before a send goes ahead without them. */
export const PEAK_TIMEOUT_MS = 1000;

/** The slice of AudioBuffer read here. */
export interface DecodedAudio {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData: (channel: number) => Float32Array;
}

/** The slice of OfflineAudioContext used here; a fake satisfies it in tests. */
export interface DecodeContext {
  decodeAudioData: (
    data: ArrayBuffer,
    success?: (buffer: DecodedAudio) => void,
    failure?: (error: unknown) => void,
  ) => Promise<DecodedAudio> | void;
}

/**
 * The browser's OfflineAudioContext (webkit-prefixed on older Safari), sized
 * to the minimum: it only decodes. Null when absent or it throws.
 */
function browserDecodeContext(): DecodeContext | null {
  const scope = globalThis as unknown as {
    OfflineAudioContext?: new (channels: number, length: number, rate: number) => DecodeContext;
    webkitOfflineAudioContext?: new (
      channels: number,
      length: number,
      rate: number,
    ) => DecodeContext;
  };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (Ctor === undefined) return null;
  try {
    return new Ctor(1, 1, 44_100);
  } catch {
    return null;
  }
}

/** The RMS level of samples[from, to); 0 for an empty or non-finite window. Pure. */
export function rmsWindow(samples: ArrayLike<number>, from: number, to: number): number {
  const end = Math.min(to, samples.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / (end - from));
  return Number.isFinite(rms) ? rms : 0;
}

/**
 * The decoded audio as PEAK_COUNT peaks: channel 0 in PEAK_SAMPLE_MS RMS
 * windows, downsampled. Undefined for no samples or all silence (no waveform
 * rather than a flat one). Pure.
 */
export function peaksFromAudio(audio: DecodedAudio): number[] | undefined {
  if (audio.numberOfChannels < 1 || !(audio.sampleRate > 0)) return undefined;
  const samples = audio.getChannelData(0);
  if (samples.length === 0) return undefined;
  const size = Math.max(1, Math.round((audio.sampleRate * PEAK_SAMPLE_MS) / 1000));
  const levels: number[] = [];
  for (let from = 0; from < samples.length; from += size) {
    levels.push(rmsWindow(samples, from, from + size));
  }
  const peaks = downsamplePeaks(levels);
  return peaks.some((p) => p > 0) ? peaks : undefined;
}

/** decodeAudioData in either shape: the promise, or the older callback form. */
function decode(ctx: DecodeContext, data: ArrayBuffer): Promise<DecodedAudio> {
  return new Promise<DecodedAudio>((resolve, reject) => {
    const returned = ctx.decodeAudioData(data, resolve, reject);
    if (returned !== undefined) returned.then(resolve, reject);
  });
}

interface VoicePeaksDeps {
  createContext?: () => DecodeContext | null;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Read the waveform of a finished recording within the cap. Resolves to 48
 * peaks, or undefined on timeout, decode error, silence or no
 * OfflineAudioContext. Never rejects.
 */
export function voicePeaks(blob: Blob, deps: VoicePeaksDeps = {}): Promise<number[] | undefined> {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let ctx: DecodeContext | null;
  try {
    ctx = (deps.createContext ?? browserDecodeContext)();
  } catch {
    ctx = null;
  }
  if (ctx === null) return Promise.resolve(undefined);
  const context = ctx;
  return new Promise<number[] | undefined>((resolve) => {
    let settled = false;
    const finish = (peaks: number[] | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      resolve(peaks);
    };
    const timer = setTimer(() => finish(undefined), deps.timeoutMs ?? PEAK_TIMEOUT_MS);
    void (async (): Promise<number[] | undefined> => {
      const data = await blob.arrayBuffer();
      return peaksFromAudio(await decode(context, data));
    })().then(finish, () => finish(undefined));
  });
}
