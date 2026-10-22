import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  baseMime,
  MIN_VOICE_NOTE_MS,
  pickRecorderMimeType,
  recordingFileName,
  useAudioRecorder,
  type AudioRecorder,
} from '@/lib/chat/use-audio-recorder';

// The exported pure helpers are exercised directly; the repo's vitest runs in
// node with no MediaRecorder / getUserMedia, so T1 drives the hook once through
// a server render with stubbed globals. pickRecorderMimeType is tested by
// stubbing the global.

describe('baseMime', () => {
  it('strips codecs and params and lowercases', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('  AUDIO/MP4 ')).toBe('audio/mp4');
  });

  it('passes the empty string through', () => {
    expect(baseMime('')).toBe('');
  });
});

describe('recordingFileName', () => {
  it('maps each known audio mime to its file name', () => {
    expect(recordingFileName('audio/webm;codecs=opus')).toBe('voice-note.webm');
    expect(recordingFileName('audio/mp4')).toBe('voice-note.m4a');
    expect(recordingFileName('audio/mpeg')).toBe('voice-note.mp3');
  });

  it('falls back to .webm for anything else', () => {
    expect(recordingFileName('audio/ogg')).toBe('voice-note.webm');
    expect(recordingFileName('')).toBe('voice-note.webm');
  });
});

describe('pickRecorderMimeType', () => {
  const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    } else {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
    }
  });

  it("returns '' when MediaRecorder is undefined", () => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    expect(pickRecorderMimeType()).toBe('');
  });

  it('prefers a supported type', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: (t: string) => t === 'audio/webm',
    } as never;
    expect(pickRecorderMimeType()).toBe('audio/webm');
  });

  it('tries mp4 before webm', () => {
    const asked: string[] = [];
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: (t: string) => {
        asked.push(t);
        return t === 'audio/mp4' || t === 'audio/webm';
      },
    } as never;
    expect(pickRecorderMimeType()).toBe('audio/mp4');
    expect(asked[0]).toBe('audio/mp4');
  });

  it("returns '' when neither container is supported", () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: () => false,
    } as never;
    expect(pickRecorderMimeType()).toBe('');
  });
});

describe('T1: the recorder attaches nothing to the live stream', () => {
  const scope = globalThis as Record<string, unknown>;
  const saved = ['MediaRecorder', 'AudioContext', 'webkitAudioContext', 'navigator'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete scope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    vi.restoreAllMocks();
  });

  it('start and stop never create an AudioContext or a MediaStreamSource; MediaRecorder gets the stream as is', async () => {
    const createMediaStreamSource = vi.fn();
    const AudioContextSpy = vi.fn(() => ({ createMediaStreamSource }));
    scope.AudioContext = AudioContextSpy;
    scope.webkitAudioContext = AudioContextSpy;
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: vi.fn(async () => stream) } },
    });
    const received: unknown[] = [];
    class FakeRecorder {
      static isTypeSupported = (t: string): boolean => t === 'audio/mp4';
      mimeType = 'audio/mp4';
      state = 'inactive';
      private listeners = new Map<string, Array<(e: unknown) => void>>();
      constructor(s: MediaStream) {
        received.push(s);
      }
      addEventListener(type: string, fn: (e: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      start(): void {
        this.state = 'recording';
      }
      stop(): void {
        this.state = 'inactive';
        for (const fn of this.listeners.get('dataavailable') ?? []) fn({ data: new Blob(['x']) });
        for (const fn of this.listeners.get('stop') ?? []) fn({});
      }
    }
    scope.MediaRecorder = FakeRecorder;

    let hook: AudioRecorder | null = null;
    function Probe(): ReactElement {
      hook = useAudioRecorder();
      return <span />;
    }
    renderToStaticMarkup(<Probe />);
    const recorder = hook as unknown as AudioRecorder;
    expect(await recorder.start()).toBe(true);
    expect(received).toEqual([stream]);
    expect(AudioContextSpy).not.toHaveBeenCalled();
    expect(createMediaStreamSource).not.toHaveBeenCalled();
  });

  it('the module source holds no Web Audio wiring at all', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./use-audio-recorder.ts', import.meta.url)),
      'utf8',
    );
    for (const banned of ['AudioContext', 'createMediaStreamSource', 'createAnalyser']) {
      expect(source).not.toContain(banned);
    }
  });
});

describe('durationMs: the exact recorded length', () => {
  const scope = globalThis as Record<string, unknown>;
  const saved = ['MediaRecorder', 'navigator'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete scope[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(): { recorder: AudioRecorder; trackStop: ReturnType<typeof vi.fn> } {
    vi.useFakeTimers();
    const trackStop = vi.fn();
    const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: vi.fn(async () => stream) } },
    });
    class FakeRecorder {
      static isTypeSupported = (t: string): boolean => t === 'audio/webm';
      mimeType = 'audio/webm;codecs=opus';
      state = 'inactive';
      private listeners = new Map<string, Array<(e: unknown) => void>>();
      addEventListener(type: string, fn: (e: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      start(): void {
        this.state = 'recording';
      }
      stop(): void {
        this.state = 'inactive';
        for (const fn of this.listeners.get('dataavailable') ?? []) fn({ data: new Blob(['x']) });
        for (const fn of this.listeners.get('stop') ?? []) fn({});
      }
    }
    scope.MediaRecorder = FakeRecorder;
    let hook: AudioRecorder | null = null;
    function Probe(): ReactElement {
      hook = useAudioRecorder();
      return <span />;
    }
    renderToStaticMarkup(<Probe />);
    return { recorder: hook as unknown as AudioRecorder, trackStop };
  }

  it('is one authoritative second', () => {
    expect(MIN_VOICE_NOTE_MS).toBe(1000);
  });

  it.each([400, 999, 1000, 2300])('a %i ms recording resolves durationMs %i', async (ms) => {
    const { recorder, trackStop } = setup();
    expect(await recorder.start()).toBe(true);
    vi.advanceTimersByTime(ms);
    const rec = await recorder.stop();
    expect(rec?.durationMs).toBe(ms);
    expect(rec?.mime).toBe('audio/webm');
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it('measures from start to the stop event, not a whole-second counter', async () => {
    const { recorder } = setup();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(10_000);
    await recorder.start();
    now.mockReturnValueOnce(12_300.4);
    expect((await recorder.stop())?.durationMs).toBe(2300);
  });

  it('cancel resolves nothing: the mic stops and a later stop gives null', async () => {
    const { recorder, trackStop } = setup();
    await recorder.start();
    vi.advanceTimersByTime(1500);
    recorder.cancel();
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(await recorder.stop()).toBeNull();
  });
});
