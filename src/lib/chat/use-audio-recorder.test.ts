import { afterEach, describe, expect, it } from 'vitest';
import { baseMime, pickRecorderMimeType, recordingFileName } from '@/lib/chat/use-audio-recorder';

// Only the exported pure helpers are exercised here: the repo's vitest runs in
// node with no MediaRecorder / getUserMedia, so the hook and any real recorder
// are out of scope. pickRecorderMimeType is tested by stubbing the global.

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
});
