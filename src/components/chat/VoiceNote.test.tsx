import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUTO_NEXT_DELAY_MS,
  bindVoiceAudio,
  nextSpeed,
  seekFraction,
  shouldAutoPlayNext,
  speedLabel,
  VoiceNote,
  VOICE_SPEEDS,
  createPlaybackRegistry,
  formatDuration,
  UNKNOWN_DURATION,
  voiceLabel,
  voiceProgress,
  voiceTotalSeconds,
  transcribeLinkState,
  waveTouchPhase,
  WAVE_SEEK_LOCK_PX,
  voiceBars,
  VOICE_BAR_COUNT,
  MIN_BAR_PX,
  MAX_BAR_PX,
  createVoiceRecovery,
  type VoiceAudio,
  type VoiceFailure,
} from '@/components/chat/VoiceNote';
import { voiceStore } from '@/lib/chat/transcript-store';

/** A fake audio element: set duration/currentTime, then fire an event. */
function fakeAudio(): VoiceAudio & { fire: (type: string) => void } {
  const listeners = new Map<string, Set<() => void>>();
  const audio = {
    duration: Number.NaN,
    currentTime: 0,
    pause: vi.fn(),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
  };
  return audio;
}

describe('voice note length', () => {
  it('shows "0:18" from durationMs before any media event', () => {
    expect(
      voiceLabel({ storedMs: 18_000, mediaSeconds: Number.NaN, currentSeconds: 0, playing: false }),
    ).toBe('0:18');
    expect(formatDuration(65)).toBe('1:05');
  });

  it('never renders 00:00 for a note with a stored duration', () => {
    for (const media of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const label = voiceLabel({
        storedMs: 18_000,
        mediaSeconds: media,
        currentSeconds: 0,
        playing: false,
      });
      expect(label).toBe('0:18');
      expect(label).not.toBe('00:00');
    }
  });

  it('shows --:-- when neither a stored nor a finite media length is known', () => {
    expect(
      voiceLabel({
        storedMs: undefined,
        mediaSeconds: Number.POSITIVE_INFINITY,
        currentSeconds: 0,
        playing: false,
      }),
    ).toBe(UNKNOWN_DURATION);
  });

  it('Infinity from the element does not overwrite a finite stored value', () => {
    const audio = fakeAudio();
    let media = Number.NaN;
    const unbind = bindVoiceAudio(audio, {
      duration: (s) => (media = s),
      time: () => {},
      playing: () => {},
      ended: () => {},
    });
    audio.duration = Number.POSITIVE_INFINITY;
    audio.fire('loadedmetadata');
    audio.fire('durationchange');
    expect(Number.isNaN(media)).toBe(true);
    expect(voiceTotalSeconds(18_000, media)).toBe(18);
    // Progress measures against the stored length while the media says Infinity.
    expect(voiceProgress(18_000, media, 9)).toBe(50);
    unbind();
  });

  it('durationchange with a finite value updates the length when nothing is stored', () => {
    const audio = fakeAudio();
    let media = Number.NaN;
    const unbind = bindVoiceAudio(audio, {
      duration: (s) => (media = s),
      time: () => {},
      playing: () => {},
      ended: () => {},
    });
    audio.duration = Number.POSITIVE_INFINITY;
    audio.fire('loadedmetadata');
    expect(voiceTotalSeconds(undefined, media)).toBeNull();
    audio.duration = 7.4;
    audio.fire('durationchange');
    expect(voiceTotalSeconds(undefined, media)).toBe(7.4);
    expect(
      voiceLabel({ storedMs: undefined, mediaSeconds: media, currentSeconds: 0, playing: false }),
    ).toBe('0:07');
    unbind();
  });
});

describe('one voice note at a time', () => {
  it('starting a second note pauses the first', () => {
    const registry = createPlaybackRegistry();
    const first = { pause: vi.fn() };
    const second = { pause: vi.fn() };
    registry.claim(first);
    registry.claim(first);
    expect(first.pause).not.toHaveBeenCalled();
    registry.claim(second);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(second.pause).not.toHaveBeenCalled();
    registry.release(second);
    registry.claim(first);
    expect(second.pause).not.toHaveBeenCalled();
  });

  it('a play event on one bound element pauses the other', () => {
    const a = fakeAudio();
    const b = fakeAudio();
    const on = { duration: () => {}, time: () => {}, playing: () => {}, ended: () => {} };
    const offA = bindVoiceAudio(a, on);
    const offB = bindVoiceAudio(b, on);
    a.fire('play');
    b.fire('play');
    expect(a.pause).toHaveBeenCalledOnce();
    expect(b.pause).not.toHaveBeenCalled();
    b.fire('ended');
    offA();
    offB();
  });
});

describe('seek, speed and the auto-play chain', () => {
  it('maps a pointer X within the wave to 0..1, clamped; Y plays no part', () => {
    const rect = { left: 100, width: 200 };
    expect(seekFraction(100, rect)).toBe(0);
    expect(seekFraction(200, rect)).toBe(0.5);
    expect(seekFraction(300, rect)).toBe(1);
    expect(seekFraction(50, rect)).toBe(0);
    expect(seekFraction(900, rect)).toBe(1);
    expect(seekFraction(150, { left: 0, width: 0 })).toBe(0);
  });

  it('cycles 1x -> 1.5x -> 2x -> 1x', () => {
    expect(VOICE_SPEEDS).toEqual([1, 1.5, 2]);
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(3)).toBe(1);
    expect([1, 1.5, 2].map(speedLabel)).toEqual(['1×', '1.5×', '2×']);
  });

  it('hands on 350ms later only to an unplayed next note', () => {
    expect(AUTO_NEXT_DELAY_MS).toBe(350);
    expect(shouldAutoPlayNext('m2', undefined)).toBe(true);
    expect(shouldAutoPlayNext('m2', 123)).toBe(false);
    expect(shouldAutoPlayNext(null, undefined)).toBe(false);
    expect(shouldAutoPlayNext(undefined, undefined)).toBe(false);
  });
});

describe('the error listener', () => {
  it('reports media errors with the MediaError code and is removed on teardown', () => {
    const audio = fakeAudio();
    const errors: Array<number | null> = [];
    const removed: string[] = [];
    const remove = audio.removeEventListener;
    audio.removeEventListener = (type, fn) => {
      removed.push(type);
      remove(type, fn);
    };
    const unbind = bindVoiceAudio(audio, {
      duration: () => {},
      time: () => {},
      playing: () => {},
      ended: () => {},
      error: (code) => errors.push(code),
    });
    audio.error = { code: 4 };
    audio.fire('error');
    expect(errors).toEqual([4]);
    unbind();
    expect(removed).toContain('error');
    audio.fire('error');
    expect(errors).toEqual([4]);
  });
});

describe('playback recovery', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  function setup(opts: {
    peek?: string | null;
    plays?: Array<Promise<void>>;
    refreshed?: Array<string | null>;
  }) {
    let applied: string | null = 'https://r2/old';
    const applies: string[] = [];
    const plays = [...(opts.plays ?? [])];
    const refreshed = [...(opts.refreshed ?? ['https://r2/new'])];
    const play = vi.fn(() => plays.shift() ?? Promise.resolve());
    const refreshUrl = vi.fn<(force: boolean) => Promise<string | null>>(
      async () => refreshed.shift() ?? null,
    );
    const failed = vi.fn<(failure: VoiceFailure) => void>();
    const recovery = createVoiceRecovery({
      player: {
        get applied() {
          return applied;
        },
        apply: (url) => {
          applied = url;
          applies.push(url);
        },
        play,
      },
      peekUrl: () => (opts.peek === undefined ? 'https://r2/old' : opts.peek),
      refreshUrl,
      failed,
    });
    return { recovery, play, refreshUrl, failed, applies };
  }
  const notSupported = (): Promise<void> =>
    Promise.reject(new DOMException('no', 'NotSupportedError'));

  it('plays straight away from a url that is still fresh', async () => {
    const { recovery, play, refreshUrl } = setup({});
    recovery.play();
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(refreshUrl).not.toHaveBeenCalled();
  });

  it('re-presigns on a tap near expiry, then plays the new url', async () => {
    const { recovery, play, refreshUrl, applies } = setup({ peek: null });
    recovery.play();
    expect(play).not.toHaveBeenCalled();
    await flush();
    expect(refreshUrl).toHaveBeenCalledWith(false);
    expect(applies).toEqual(['https://r2/new']);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('a media error forces one re-presign and retries play once, then fails', async () => {
    const { recovery, play, refreshUrl, failed } = setup({
      refreshed: ['https://r2/new', 'https://r2/newer'],
    });
    recovery.play();
    await flush();
    recovery.mediaError(4);
    await flush();
    expect(refreshUrl).toHaveBeenCalledTimes(1);
    expect(refreshUrl).toHaveBeenCalledWith(true);
    expect(play).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
    recovery.mediaError(4);
    await flush();
    expect(refreshUrl).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith({ name: 'MediaError', code: 4, retried: true });
    recovery.mediaError(4);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('a play() rejection retries once; the second rejection is final', async () => {
    const { recovery, play, failed } = setup({ plays: [notSupported(), notSupported()] });
    recovery.play();
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    expect(failed).toHaveBeenCalledWith({ name: 'NotSupportedError', code: null, retried: true });
  });

  it('an AbortError is never a failure', async () => {
    const { recovery, play, failed, refreshUrl } = setup({
      plays: [Promise.reject(new DOMException('paused', 'AbortError'))],
    });
    recovery.play();
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(refreshUrl).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('a failed re-presign is final, without a retry', async () => {
    const { recovery, play, failed } = setup({ refreshed: [null] });
    recovery.play();
    await flush();
    recovery.mediaError(2);
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith({ name: 'PresignError', code: null, retried: true });
  });

  it('an error while not playing re-presigns but never starts playback', async () => {
    const { recovery, play, refreshUrl } = setup({});
    recovery.mediaError(2);
    await flush();
    expect(refreshUrl).toHaveBeenCalledWith(true);
    expect(play).not.toHaveBeenCalled();
  });

  it('after audio starts, a later failure gets its own retry', async () => {
    const { recovery, refreshUrl, failed } = setup({
      refreshed: ['https://r2/a', 'https://r2/b'],
    });
    recovery.play();
    await flush();
    recovery.mediaError(2);
    await flush();
    recovery.started();
    recovery.mediaError(2);
    await flush();
    expect(refreshUrl).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe('first paint', () => {
  const base = {
    url: 'https://signed/a',
    name: 'n.webm',
    durationMs: 18_000,
    sender: { name: 'Asha Rao' },
    nextVoiceId: null,
  };
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids.splice(0))
      voiceStore.update(id, {
        transcript: undefined,
        failedAt: undefined,
        collapsed: undefined,
        playedAt: undefined,
      });
  });
  const render = (id: string, mine = false, withFlow = true): string => {
    ids.push(id);
    return renderToStaticMarkup(
      <VoiceNote
        {...base}
        messageId={id}
        mine={mine}
        bubbleInset
        {...(withFlow ? { onTranscribe: () => {} } : {})}
        meta={<span data-meta="row">10:42</span>}
      />,
    );
  };
  const order = (html: string, ...needles: string[]): number[] =>
    needles.map((needle) => html.indexOf(needle));

  it('is a fixed 264px wide with the 4/6/4/0 inset in a bubble', () => {
    const html = render('fp-size');
    expect(html).toMatch(/data-voice-note=""[^>]*class="[^"]*w-\[264px\][^"]*pb-1 pr-1\.5 pt-1/);
    expect(html).toContain('font-sans');
    expect(html).not.toContain('font-mono');
  });

  it('same layout on both sides: play, wave, photo; then length · Transcribe and the time', () => {
    for (const mine of [false, true]) {
      const html = render(`fp-layout-${String(mine)}`, mine);
      const [play, wave, mic, duration, link, meta] = order(
        html,
        'aria-label="Play voice note"',
        'data-voice-wave',
        'data-voice-mic',
        'data-voice-duration',
        'data-voice-link="transcribe"',
        'data-meta="row"',
      );
      expect(play).toBeGreaterThan(-1);
      expect(play).toBeLessThan(wave as number);
      expect(wave).toBeLessThan(mic as number);
      expect(mic).toBeLessThan(duration as number);
      expect(duration).toBeLessThan(link as number);
      expect(link).toBeLessThan(meta as number);
      expect(html).toMatch(
        /data-voice-foot=""[^>]*class="flex min-h-4 items-center[^"]*pl-\[46px\]/,
      );
    }
  });

  it('offers Transcribe on sent and received notes', () => {
    expect(render('fp-tr-received')).toContain('>Transcribe</button>');
    expect(render('fp-tr-sent', true)).toContain('>Transcribe</button>');
  });

  it('play is a bare 44x44 hit area with a 20px glyph, accent received, white sent', () => {
    const received = render('fp-play-r');
    expect(received).toMatch(/aria-label="Play voice note" class="flex h-11 w-11[^"]*text-accent /);
    expect(received).not.toMatch(/aria-label="Play voice note"[^>]*class="[^"]*\bbg-accent\b/);
    expect(received).toContain('width="20" height="20"');
    expect(render('fp-play-s', true)).toMatch(
      /aria-label="Play voice note" class="flex h-11 w-11[^"]*text-accent-fg/,
    );
  });

  it('draws the 10px seek dot in the played colour on both sides', () => {
    expect(render('fp-dot-r')).toMatch(
      /data-voice-dot=""[^>]*class="[^"]*h-2\.5 w-2\.5 rounded-full bg-accent\b/,
    );
    expect(render('fp-dot-s', true)).toMatch(
      /data-voice-dot=""[^>]*class="[^"]*h-2\.5 w-2\.5 rounded-full bg-accent-fg/,
    );
  });

  it('received badge is accent until this device played the note, then muted', () => {
    expect(render('fp-unplayed')).toMatch(
      /data-voice-mic="unplayed" class="[^"]*bg-accent text-accent-fg/,
    );
    voiceStore.update('fp-played', { playedAt: 1 });
    const html = render('fp-played');
    expect(html).toContain('data-voice-played=""');
    expect(html).toMatch(/data-voice-mic="played" class="[^"]*bg-fg-3\b/);
  });

  it('sent badge is white with an accent mic, ringed in the bubble colour', () => {
    expect(render('fp-own-badge', true)).toMatch(
      /data-voice-mic="own" class="[^"]*ring-2 ring-bubble-own bg-accent-fg text-\[color:var\(--accent\)\]/,
    );
  });

  it('the duration is Inter 12px medium tabular; Transcribe semibold with a 44px hit area', () => {
    const html = render('fp-type');
    expect(html).toMatch(/data-voice-foot=""[^>]*text-xs leading-4/);
    expect(html).toContain('data-voice-duration="" class="font-medium tabular-nums"');
    expect(html).toMatch(
      /data-voice-link="transcribe"[^>]*class="shrink-0 rounded-sm font-semibold relative after:absolute after:inset-x-0 after:-inset-y-3\.5/,
    );
  });

  it('no Transcribe without the flow; Hide text still folds a stored transcript', () => {
    expect(render('fp-nolink', false, false)).not.toContain('data-voice-link');
    voiceStore.update('fp-nolink-shown', { transcript: 'hi' });
    expect(render('fp-nolink-shown', false, false)).toContain('>Hide text</button>');
  });

  it('pending: "Transcribing…", not a button', () => {
    voiceStore.setPending('fp-pending', true);
    const html = render('fp-pending');
    voiceStore.setPending('fp-pending', false);
    expect(html).toContain('<span data-voice-link="pending" role="status"');
    expect(html).not.toContain('>Transcribe</button>');
  });

  it('open: "Hide text" and the transcript panel open on first paint, below row 2', () => {
    voiceStore.update('fp-shown', { transcript: 'नमस्ते, see you at 5' });
    const html = render('fp-shown');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>Hide text</button>');
    expect(html).toMatch(/data-voice-transcript="open" class="grid [^"]*visible grid-rows-\[1fr\]/);
    expect(html).toMatch(
      /select-text[^"]*rounded-\[14px\][^"]*text-\[15px\] leading-\[21px\] bg-panel-3 text-fg/,
    );
    expect(html).toContain('नमस्ते, see you at 5');
    expect(html.indexOf('data-voice-transcript')).toBeGreaterThan(html.indexOf('data-voice-foot'));
  });

  it('folded: "Transcribe" reopens it; the panel is closed and hidden from AT', () => {
    voiceStore.update('fp-collapsed', { transcript: 'hidden text', collapsed: true });
    const html = render('fp-collapsed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Transcribe</button>');
    expect(html).toMatch(
      /data-voice-transcript="closed" aria-hidden="true" class="grid [^"]*invisible grid-rows-\[0fr\]/,
    );
  });

  it('opens on height only, 180ms ease-out, none under reduced motion', () => {
    const html = render('fp-motion');
    expect(html).toContain(
      'transition-[grid-template-rows] duration-[180ms] ease-out motion-reduce:transition-none',
    );
    expect(html).not.toMatch(/data-voice-transcript[^>]*(translate|scale|rotate|opacity)/);
  });

  it('shows no error row before any playback failure', () => {
    const html = render('fp-no-error');
    expect(html).not.toContain('data-voice-error');
    expect(html).not.toContain('play here.');
  });
});

describe('transcribe link state', () => {
  it('maps every transcript view to its label state', () => {
    expect(transcribeLinkState({ kind: 'none' })).toBe('transcribe');
    expect(transcribeLinkState({ kind: 'pending' })).toBe('pending');
    expect(transcribeLinkState({ kind: 'failed' })).toBe('failed');
    expect(transcribeLinkState({ kind: 'shown', text: 't', collapsed: false })).toBe('hide');
    expect(transcribeLinkState({ kind: 'shown', text: 't', collapsed: true })).toBe('show');
  });
});

describe('touch on the wave', () => {
  const start = { x: 100, y: 100, t: 0 };
  it('a horizontal move of 8px within 450ms seeks, either way', () => {
    expect(WAVE_SEEK_LOCK_PX).toBe(8);
    expect(waveTouchPhase(start, { x: 108, y: 100, t: 100 })).toBe('seek');
    expect(waveTouchPhase(start, { x: 92, y: 102, t: 449 })).toBe('seek');
  });
  it('under 8px it stays pending, so the bubble long-press can fire', () => {
    expect(waveTouchPhase(start, { x: 107, y: 103, t: 300 })).toBe('pending');
    expect(waveTouchPhase(start, { x: 100, y: 100, t: 10 })).toBe('pending');
  });
  it('at 450ms the gesture is the bubble long-press, even if it then moves', () => {
    expect(waveTouchPhase(start, { x: 100, y: 100, t: 450 })).toBe('hold');
    expect(waveTouchPhase(start, { x: 140, y: 100, t: 600 })).toBe('hold');
  });
  it('a vertical move past the long-press tolerance is neither', () => {
    expect(waveTouchPhase(start, { x: 102, y: 112, t: 100 })).toBe('none');
  });
});

describe('bars from the real waveform', () => {
  /** The inline heights (px) of the drawn bars, in order. */
  function barHeights(html: string): number[] {
    const wave = html.slice(html.indexOf('data-voice-bars'));
    return [...wave.matchAll(/style="height:(\d+)px"/g)].map((m) => Number(m[1]));
  }
  const base = { url: 'blob:a', name: 'voice-note.webm', durationMs: 5_000 };

  it('draws 30 bars, 3-20px, from the note peaks', () => {
    const peaks = Array.from({ length: 48 }, (_, i) => (i < 24 ? 0 : 100));
    const html = renderToStaticMarkup(<VoiceNote {...base} peaks={peaks} />);
    expect(html).toContain('data-voice-bars="peaks"');
    const heights = barHeights(html);
    expect(VOICE_BAR_COUNT).toBe(30);
    expect(heights).toHaveLength(30);
    expect(heights[0]).toBe(MIN_BAR_PX);
    expect(heights.at(-1)).toBe(MAX_BAR_PX);
    expect(heights).toEqual(voiceBars(peaks));
  });

  it('falls back to the fixed levels without peaks, still 30 bars in range', () => {
    const html = renderToStaticMarkup(<VoiceNote {...base} />);
    expect(html).toContain('data-voice-bars="fallback"');
    const heights = barHeights(html);
    expect(heights).toHaveLength(30);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(MIN_BAR_PX);
    expect(Math.max(...heights)).toBeLessThanOrEqual(MAX_BAR_PX);
  });

  it('unplayed bars: the muted token received, white at 45% sent; 2px wide, 1px radius', () => {
    const received = renderToStaticMarkup(<VoiceNote {...base} peaks={[50, 60]} />);
    const wave = received.slice(received.indexOf('data-voice-bars'));
    expect((wave.match(/w-0\.5 shrink-0 rounded-\[1px\] bg-fg-3"/g) ?? []).length).toBe(30);
    expect(wave).not.toContain('data-played');
    const sent = renderToStaticMarkup(<VoiceNote {...base} mine peaks={[50, 60]} />);
    expect(sent).toContain('w-0.5 shrink-0 rounded-[1px] bg-white/[.45]');
  });
});
