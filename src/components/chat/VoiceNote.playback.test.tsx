// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// MessageThread (for OWN_BUBBLE_CONTENT) pulls the agora-chat browser SDK.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { OWN_BUBBLE_CONTENT } from '@/components/chat/MessageThread';
import { PRESSABLE_ROW_BASE } from '@/components/ui/PressableRow';
import { VOICE_START_TIMEOUT_MS, VoiceNote } from '@/components/chat/VoiceNote';
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
  vi.useRealTimers();
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

const pauseButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Pause voice note"]')!;

function fire(audio: HTMLAudioElement, type: string): void {
  act(() => {
    audio.dispatchEvent(new Event(type));
  });
}

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
      reason: 'error',
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
  it('a note that never starts shows the error row once the watchdog runs out twice', async () => {
    vi.useFakeTimers();
    play.mockResolvedValue(undefined);
    const refreshUrl = vi.fn(async () => 'https://r2/fresh');
    mount({ peekUrl: () => 'https://r2/a', refreshUrl });
    act(() => playButton().click());
    await flush();
    act(() => {
      vi.advanceTimersByTime(VOICE_START_TIMEOUT_MS);
    });
    await flush();
    expect(refreshUrl).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-voice-error]')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(VOICE_START_TIMEOUT_MS);
    });
    await flush();
    expect(document.querySelector('[data-voice-error]')?.textContent).toContain("Can't play here.");
    expect(logError).toHaveBeenCalledWith('chat: voice note play failed', {
      name: 'NoProgress',
      code: null,
      mime: 'audio/webm',
      retried: 'yes',
      reason: 'stall',
    });
  });

  it('a user pause during a retry cancels it with no error row', async () => {
    play.mockResolvedValue(undefined);
    const waiting: Array<(url: string | null) => void> = [];
    const refreshUrl = vi.fn(() => new Promise<string | null>((resolve) => waiting.push(resolve)));
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl });
    act(() => playButton().click());
    await flush();
    fireError(audio);
    // The retry's re-presign is in flight: the control still offers pause.
    act(() => pauseButton().click());
    waiting.shift()?.('https://r2/fresh');
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-voice-error]')).toBeNull();
    expect(logError).not.toHaveBeenCalled();
    expect(playButton()).not.toBeNull();
  });

  it('a pause the element makes during an attempt fails, and twice shows the error row', async () => {
    play.mockResolvedValue(undefined);
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/b' });
    act(() => playButton().click());
    await flush();
    fire(audio, 'pause');
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    fire(audio, 'pause');
    await flush();
    expect(document.querySelector('[data-voice-error]')).not.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      'chat: voice note play failed',
      expect.objectContaining({ name: 'Paused', reason: 'stall' }),
    );
  });

  it('unmount clears every watchdog: nothing fires afterwards', async () => {
    vi.useFakeTimers();
    play.mockResolvedValue(undefined);
    const refreshUrl = vi.fn(async () => 'https://r2/fresh');
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl });
    act(() => playButton().click());
    await flush();
    fire(audio, 'seeking');
    act(() => root?.unmount());
    root = null;
    vi.advanceTimersByTime(VOICE_START_TIMEOUT_MS * 3);
    await flush();
    expect(refreshUrl).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('the own-bubble hover tint skips every voice control and still tints other buttons', async () => {
    // The tint's selector, as the arbitrary variant writes it (minus :hover).
    const variant = /\[&_(button\S*?):hover\]:bg-white\/\[\.24\]/.exec(OWN_BUBBLE_CONTENT)?.[1];
    expect(variant).toBe('button:not([data-upload-ring]):not([data-voice-control])');
    const selector = variant!;
    voiceStore.update('pb-1', { transcript: 'hello there', collapsed: true });
    play.mockRejectedValue(new DOMException('no', 'NotSupportedError'));
    const audio = mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/b' });
    fire(audio, 'play');
    // Play/pause, the speed pill and the Transcribe link while playing.
    const playingButtons = [...document.querySelectorAll('[data-voice-note] button')];
    expect(document.querySelector('[data-voice-speed]')).not.toBeNull();
    fire(audio, 'pause');
    act(() => playButton().click());
    await flush();
    await flush();
    // The error row's "Read the transcript".
    expect(document.querySelector('[data-voice-read]')).not.toBeNull();
    const failedButtons = [...document.querySelectorAll('[data-voice-note] button')];
    const controls = [...playingButtons, ...failedButtons];
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const button of controls) expect(button.matches(selector)).toBe(false);
    // Any other button in an own bubble keeps the tint; the upload ring never had it.
    const other = document.createElement('button');
    const ring = document.createElement('button');
    ring.setAttribute('data-upload-ring', '');
    expect(other.matches(selector)).toBe(true);
    expect(ring.matches(selector)).toBe(false);
  });

  it('play is a bare glyph on the shared PressableRow surface: no fill or radius of its own', () => {
    mount({ peekUrl: () => 'https://r2/a', refreshUrl: async () => 'https://r2/a' });
    // Only the primitive's own surface classes (rounded-lg, hover:bg-panel-2)
    // may carry a radius or fill; VoiceNote adds none.
    const own = playButton()
      .className.split(/\s+/)
      .filter((c) => !PRESSABLE_ROW_BASE.split(' ').includes(c) && c !== 'rounded-lg')
      .join(' ');
    expect(own).not.toMatch(/\brounded-/);
    expect(own).not.toMatch(/(^|\s)(hover:|active:|focus:)?!?bg-/);
    expect(playButton().hasAttribute('data-voice-control')).toBe(true);
  });
});
