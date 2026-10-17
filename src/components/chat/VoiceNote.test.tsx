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
  WAVEFORM_BARS,
  VOICE_BAR_COUNT,
  type VoiceAudio,
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

describe('first paint', () => {
  const base = {
    url: 'https://signed/a',
    name: 'n.webm',
    durationMs: 18_000,
    sender: { name: 'Asha Rao' },
    nextVoiceId: null,
  };
  const ids: string[] = [];
  const render = (id: string, mine = false): string => {
    ids.push(id);
    return renderToStaticMarkup(<VoiceNote {...base} messageId={id} mine={mine} />);
  };
  afterEach(() => {
    for (const id of ids.splice(0))
      voiceStore.update(id, {
        transcript: undefined,
        failedAt: undefined,
        collapsed: undefined,
        playedAt: undefined,
      });
  });

  it('renders the total length, the 44px wave with the drag guards, and the dot', () => {
    const html = render('fp-idle');
    expect(html).toContain('0:18');
    expect(html).toMatch(
      /data-voice-wave="[^"]*"[^>]*class="[^"]*h-11[^"]*touch-none[^"]*select-none/,
    );
    expect(html).toContain('[-webkit-touch-callout:none]');
    expect(html).toMatch(/data-voice-dot=""[^>]*class="[^"]*h-3 w-3[^"]*bg-accent\b/);
    expect(html).toContain('font-mono text-xs');
    // The drop-down is mounted closed, ready to reveal.
    expect(html).toContain('data-voice-transcript="closed"');
    expect(html).not.toContain('data-voice-transcript="open"');
  });

  it('draws the dot white on an own bubble', () => {
    expect(render('fp-own', true)).toMatch(/data-voice-dot=""[^>]*class="[^"]*bg-accent-fg/);
  });

  it('shows the mic badge fg-3 until played, then accent', () => {
    expect(render('fp-unplayed')).toContain('text-fg-3');
    voiceStore.update('fp-played', { playedAt: 1 });
    const html = render('fp-played');
    expect(html).toContain('data-voice-played=""');
    expect(html).toMatch(/rounded-full bg-panel-2 text-accent/);
  });

  const withLink = (id: string, mine = false): string => {
    ids.push(id);
    return renderToStaticMarkup(
      <VoiceNote
        {...base}
        messageId={id}
        mine={mine}
        onTranscribe={() => {}}
        meta={<span data-meta="row">10:42</span>}
      />,
    );
  };
  const order = (html: string, ...needles: string[]): number[] =>
    needles.map((needle) => html.indexOf(needle));

  it('received: play, wave, photo in row 1; length; Transcribe left and time right in row 3', () => {
    const html = withLink('fp-received');
    const [play, wave, mic, duration, foot, link, meta] = order(
      html,
      'aria-label="Play voice note"',
      'data-voice-wave',
      'data-voice-mic',
      'data-voice-duration',
      'data-voice-foot',
      'data-voice-link="transcribe"',
      'data-meta="row"',
    );
    expect(play).toBeGreaterThan(-1);
    expect(play).toBeLessThan(wave as number);
    expect(wave).toBeLessThan(mic as number);
    expect(duration).toBeLessThan(foot as number);
    expect(foot).toBeLessThan(link as number);
    expect(link).toBeLessThan(meta as number);
    // Row 3 is a fixed 44px row; the time is pushed right.
    expect(html).toMatch(/data-voice-foot=""[^>]*class="flex h-11 items-center/);
    expect(html).toMatch(/data-voice-meta=""[^>]*class="ml-auto flex shrink-0/);
  });

  it('own: photo, play, wave in row 1; length left and time right in row 2; no link', () => {
    const html = withLink('fp-own-layout', true);
    const [mic, play, wave, duration, meta] = order(
      html,
      'data-voice-mic',
      'aria-label="Play voice note"',
      'data-voice-wave',
      'data-voice-duration',
      'data-meta="row"',
    );
    expect(mic).toBeGreaterThan(-1);
    expect(mic).toBeLessThan(play as number);
    expect(play).toBeLessThan(wave as number);
    expect(duration).toBeLessThan(meta as number);
    expect(html).not.toContain('data-voice-link');
    expect(html).not.toContain('data-voice-foot');
    expect(html).not.toContain('Transcribe');
  });

  it('the link is plain accent text, 15px/500, 44px tall, never selecting or calling out', () => {
    const html = withLink('fp-link');
    expect(html).toMatch(
      /<button type="button" data-voice-link="transcribe" data-induction="chat-transcript" class="flex h-11 select-none items-center text-\[15px\] font-medium leading-5 \[-webkit-touch-callout:none\] shrink-0 rounded-sm text-accent /,
    );
    expect(html).toContain('>Transcribe</button>');
    expect(html).not.toMatch(/data-voice-link="transcribe"[^>]*(bg-|rounded-full|border)/);
  });

  it('no link without the transcribe flow; Show/Hide still toggles a stored transcript', () => {
    ids.push('fp-nolink');
    const bare = renderToStaticMarkup(<VoiceNote {...base} messageId="fp-nolink" />);
    expect(bare).not.toContain('data-voice-link');
    voiceStore.update('fp-nolink-shown', { transcript: 'hi' });
    ids.push('fp-nolink-shown');
    const shown = renderToStaticMarkup(<VoiceNote {...base} messageId="fp-nolink-shown" />);
    expect(shown).toContain('data-voice-link="hide"');
  });

  it('pending: "Transcribing…" in fg-2, not a button', () => {
    voiceStore.setPending('fp-pending', true);
    const html = withLink('fp-pending');
    voiceStore.setPending('fp-pending', false);
    expect(html).toMatch(
      /<span data-voice-link="pending" role="status" class="[^"]*text-fg-2">Transcribing…<\/span>/,
    );
    expect(html).not.toContain('>Transcribe</button>');
  });

  it('open: "Hide transcript" and the transcript open on first paint, selectable, under a hairline', () => {
    voiceStore.update('fp-shown', { transcript: 'नमस्ते, see you at 5' });
    const html = withLink('fp-shown');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>Hide transcript</button>');
    expect(html).toMatch(
      /data-voice-transcript="open" class="grid [^"]*visible grid-rows-\[1fr\] opacity-100/,
    );
    expect(html).toContain('border-t border-border');
    expect(html).toMatch(/select-text[^"]*text-\[15px\] leading-5 text-fg/);
    expect(html).toContain('नमस्ते, see you at 5');
    // Below row 3.
    expect(html.indexOf('data-voice-transcript')).toBeGreaterThan(html.indexOf('data-voice-foot'));
  });

  it('closed: "Show transcript" with the drop-down closed and hidden from AT', () => {
    voiceStore.update('fp-collapsed', { transcript: 'hidden text', collapsed: true });
    const html = withLink('fp-collapsed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Show transcript</button>');
    expect(html).toMatch(
      /data-voice-transcript="closed" aria-hidden="true" class="grid [^"]*invisible grid-rows-\[0fr\] opacity-0/,
    );
  });

  it('failed: "Transcript not available" in fg-3, then "Try again" in accent', () => {
    voiceStore.update('fp-failed', { failedAt: 1 });
    const html = withLink('fp-failed');
    expect(html).toMatch(
      /data-voice-link="failed" class="[^"]*text-fg-3"><span class="truncate">Transcript not available/,
    );
    expect(html).toMatch(
      /data-voice-link="retry" class="[^"]*text-accent[^"]*">Try again<\/button>/,
    );
  });

  it('reveals on height and opacity only, 180ms ease-out, none under reduced motion', () => {
    const html = withLink('fp-motion');
    expect(html).toContain(
      'transition-[grid-template-rows,opacity,visibility] duration-[180ms] ease-out motion-reduce:transition-none',
    );
    expect(html).not.toMatch(/data-voice-transcript[^>]*(translate|scale|rotate)/);
  });

  it('own notes show a stored transcript open (no link to reopen it)', () => {
    voiceStore.update('fp-own-shown', { transcript: 'mine', collapsed: true });
    const html = withLink('fp-own-shown', true);
    expect(html).toContain('data-voice-transcript="open"');
    expect(html).toContain('mine');
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

describe('T4: bars from the real waveform', () => {
  /** The inline heights of the drawn bars, in order. */
  function barHeights(html: string): number[] {
    const wave = html.slice(html.indexOf('data-voice-bars'));
    return [...wave.matchAll(/style="height:(\d+(?:\.\d+)?)%"/g)].map((m) => Number(m[1]));
  }
  const base = { url: 'blob:a', name: 'voice-note.webm', durationMs: 5_000 };

  it('renders the bars from the note peaks, resampled to the bar count', () => {
    const peaks = Array.from({ length: 48 }, (_, i) => (i < 24 ? 20 : 100));
    const html = renderToStaticMarkup(<VoiceNote {...base} peaks={peaks} />);
    expect(html).toContain('data-voice-bars="peaks"');
    const heights = barHeights(html);
    expect(heights).toHaveLength(VOICE_BAR_COUNT);
    expect(heights[0]).toBe(20);
    expect(heights.at(-1)).toBe(100);
    expect(heights).toEqual(voiceBars(peaks));
    expect(heights).not.toEqual([...WAVEFORM_BARS]);
  });

  it('a quiet stretch still draws a mark (minimum bar height)', () => {
    const bars = voiceBars(new Array<number>(48).fill(0).map((v, i) => (i === 0 ? 100 : v)));
    expect(Math.min(...bars)).toBeGreaterThan(0);
  });

  it('falls back to WAVEFORM_BARS without peaks (older notes, older clients)', () => {
    const html = renderToStaticMarkup(<VoiceNote {...base} />);
    expect(html).toContain('data-voice-bars="fallback"');
    expect(barHeights(html)).toEqual([...WAVEFORM_BARS]);
    expect(voiceBars(undefined)).toBe(WAVEFORM_BARS);
    expect(voiceBars([])).toBe(WAVEFORM_BARS);
  });

  it('played and unplayed colouring is unchanged with peaks', () => {
    const html = renderToStaticMarkup(<VoiceNote {...base} peaks={[50, 60]} />);
    const wave = html.slice(html.indexOf('data-voice-bars'));
    // Nothing played yet: every bar is the unplayed ink.
    expect((wave.match(new RegExp('flex-1 rounded-sm bg-fg-3', 'g')) ?? []).length).toBe(
      VOICE_BAR_COUNT,
    );
    expect(wave).not.toContain('data-played');
  });
});
