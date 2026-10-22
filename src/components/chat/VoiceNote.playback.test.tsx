// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { VoiceNote } from '@/components/chat/VoiceNote';
import { voiceStore } from '@/lib/chat/transcript-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const play = vi.fn<() => Promise<void>>();

beforeEach(() => {
  play.mockReset();
  logError.mockReset();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  voiceStore.update('pb-1', { transcript: undefined, collapsed: undefined, failedAt: undefined });
});

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

function mount(props: {
  onTranscribe?: () => void;
  refreshUrl?: (force: boolean) => Promise<string | null>;
  peekUrl?: () => string | null;
}): HTMLAudioElement {
  root = createRoot(host!);
  act(() =>
    root!.render(
      <VoiceNote
        url="https://r2/a"
        name="voice-note.webm"
        mime="audio/webm"
        durationMs={4_000}
        messageId="pb-1"
        sender={{ name: 'Asha Rao' }}
        bubbleInset
        {...props}
      />,
    ),
  );
  return document.querySelector('audio')!;
}

const playButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Play voice note"]')!;

function fireError(audio: HTMLAudioElement): void {
  Object.defineProperty(audio, 'error', { configurable: true, value: { code: 4 } });
  act(() => {
    audio.dispatchEvent(new Event('error'));
  });
}

describe('VoiceNote playback', () => {
  it('sets the url on the element and plays on tap', async () => {
    play.mockResolvedValue(undefined);
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/a' });
    expect(audio.getAttribute('src')).toBe('https://r2/a');
    act(() => playButton().click());
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('re-presigns on a tap near expiry before playing', async () => {
    play.mockResolvedValue(undefined);
    const refreshUrl = vi.fn(async () => 'https://r2/b');
    const audio = mount({ peekUrl: () => null, refreshUrl });
    act(() => playButton().click());
    await flush();
    expect(refreshUrl).toHaveBeenCalledWith(false);
    expect(audio.getAttribute('src')).toBe('https://r2/b');
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('a media error retries once, then shows the error row and logs without urls', async () => {
    play.mockResolvedValue(undefined);
    const refreshUrl = vi.fn(async () => 'https://r2/fresh');
    const onTranscribe = vi.fn();
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl, onTranscribe });
    act(() => playButton().click());
    await flush();
    fireError(audio);
    await flush();
    expect(refreshUrl).toHaveBeenCalledWith(true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-voice-error]')).toBeNull();
    fireError(audio);
    await flush();
    const row = document.querySelector('[data-voice-error]');
    expect(row?.textContent).toContain("Can't play here.");
    expect(logError).toHaveBeenCalledWith('chat: voice note play failed', {
      name: 'MediaError',
      code: 4,
      mime: 'audio/webm',
      retried: 'yes',
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain('https://');
    const read = document.querySelector<HTMLButtonElement>('[data-voice-read]');
    expect(read?.textContent).toBe('Read the transcript');
    act(() => read?.click());
    expect(onTranscribe).toHaveBeenCalledTimes(1);
  });

  it('"Read the transcript" opens a stored transcript and the error row hides', async () => {
    voiceStore.update('pb-1', { transcript: 'hello there', collapsed: true });
    play.mockRejectedValue(new DOMException('no', 'NotSupportedError'));
    mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/b' });
    act(() => playButton().click());
    await flush();
    await flush();
    expect(document.querySelector('[data-voice-error]')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[data-voice-read]')?.click());
    expect(document.querySelector('[data-voice-transcript="open"]')).not.toBeNull();
    expect(document.querySelector('[data-voice-error]')).toBeNull();
  });

  it('removes its error listener on unmount', () => {
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/a' });
    const removed = vi.spyOn(audio, 'removeEventListener');
    act(() => root?.unmount());
    root = null;
    expect(removed.mock.calls.map(([type]) => type)).toContain('error');
  });

  it('a background url refresh never resets a playing note', () => {
    play.mockResolvedValue(undefined);
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/a' });
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    act(() =>
      root!.render(
        <VoiceNote
          url="https://r2/refreshed"
          name="voice-note.webm"
          durationMs={4_000}
          messageId="pb-1"
          sender={{ name: 'Asha Rao' }}
        />,
      ),
    );
    expect(audio.getAttribute('src')).toBe('https://r2/a');
  });

  it('while playing, the speed pill cycles 1× -> 1.5× -> 2× -> 1×', () => {
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/a' });
    act(() => {
      audio.dispatchEvent(new Event('play'));
    });
    const pill = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>('[data-voice-speed]')!;
    expect(pill().textContent).toBe('1×');
    act(() => pill().click());
    expect(pill().textContent).toBe('1.5×');
    act(() => pill().click());
    expect(pill().textContent).toBe('2×');
    act(() => pill().click());
    expect(pill().textContent).toBe('1×');
  });
});
