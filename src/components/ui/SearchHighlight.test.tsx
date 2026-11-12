// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOW_LAYER_CLASS,
  glowInset,
  GLOW_MS,
  glowTarget,
  JUMP_SETTLE_MS,
  Highlight,
  highlightNodes,
  SEARCH_MARK_CLASS,
  SearchWordsContext,
} from '@/components/ui/SearchHighlight';
import { DUR_WIPE_MS, resetMotionPreferenceForTests, resetPlayerForTests } from '@/lib/motion';

// The person's reduced-motion setting, flipped per case.
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  prefersReducedMotion: () => motion.reduced,
}));

const html = (nodes: ReturnType<typeof highlightNodes>): string =>
  renderToStaticMarkup(<>{nodes}</>);

describe('highlightNodes (the one matching rule)', () => {
  it('marks every word that starts with a searched word, case-insensitive', () => {
    const out = html(highlightNodes('Diwali lights and diwali sweets', ['diwali', 'swe']));
    expect(out.match(/<mark/g)).toHaveLength(3);
    expect(out).toContain('>Diwali</mark>');
    expect(out).toContain('>sweets</mark>');
    expect(out).not.toContain('>lights</mark>');
  });

  it('marks a word inside a rendered @username', () => {
    expect(html(highlightNodes('ask @ashar now', ['asha']))).toContain('>ashar</mark>');
  });

  it('only matches at word starts and leaves text untouched without words', () => {
    expect(html(highlightNodes('candiwali', ['diwali']))).not.toContain('<mark');
    expect(highlightNodes('plain', [])).toEqual(['plain']);
  });

  it('uses the annotation fill with --fg ink (readable in light and dark)', () => {
    expect(html(highlightNodes('word', ['word']))).toContain(SEARCH_MARK_CLASS);
    expect(SEARCH_MARK_CLASS).toContain('bg-search-mark');
    expect(SEARCH_MARK_CLASS).toContain('[color:var(--search-mark-fg)]');
  });

  it('Highlight takes the screen jump words from context, or its own words', () => {
    const inJump = renderToStaticMarkup(
      <SearchWordsContext.Provider value={['launch']}>
        <Highlight text="Launch plan" />
      </SearchWordsContext.Provider>,
    );
    expect(inJump).toContain('>Launch</mark>');
    expect(renderToStaticMarkup(<Highlight text="Launch plan" />)).not.toContain('<mark');
    expect(renderToStaticMarkup(<Highlight text="Launch plan" words={['plan']} />)).toContain(
      '>plan</mark>',
    );
  });
});

describe('glowTarget (arrival tint)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motion.reduced = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    resetMotionPreferenceForTests();
    resetPlayerForTests();
  });

  function row(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'target';
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  }

  const layer = (el: HTMLElement): HTMLElement | null =>
    el.querySelector<HTMLElement>('[data-jump-glow-layer]');

  it('centres the target and tints it for 2s on a layer behind its content', () => {
    const el = row();
    glowTarget(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(el.hasAttribute('data-jump-glow')).toBe(true);
    expect(layer(el)?.className).toBe(GLOW_LAYER_CLASS);
    expect(layer(el)?.classList.contains('lit-selected')).toBe(true);
    expect(layer(el)?.style.backgroundColor).toBe('');
    expect(layer(el)?.style.zIndex).toBe('-1');
    expect(el.style.isolation).toBe('isolate');
    // The row's own background is never touched.
    expect(el.style.backgroundColor).toBe('');
    vi.advanceTimersByTime(GLOW_MS - 1);
    expect(layer(el)).not.toBeNull();
  });

  it('after 2s the tint wipes away left to right (clip), never a fade, then the layer goes', () => {
    const listeners: Record<string, () => void> = {};
    const fake = {
      finish: vi.fn(() => listeners.finish?.()),
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
    };
    const animate = vi.fn(() => fake as unknown as Animation);
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = animate as unknown as HTMLElement['animate'];
    try {
      const el = row();
      glowTarget(el);
      vi.advanceTimersByTime(GLOW_MS);
      expect(animate).toHaveBeenCalledTimes(1);
      const [frames, options] = animate.mock.calls[0] as unknown as [
        Keyframe[],
        KeyframeAnimationOptions,
      ];
      expect(frames.map((f) => f.clipPath)).toEqual(['inset(0 0 0 0%)', 'inset(0 0 0 100%)']);
      expect(frames.some((f) => 'opacity' in f)).toBe(false);
      expect(options.duration).toBe(DUR_WIPE_MS);
      expect(layer(el)).not.toBeNull();
      listeners.finish?.();
      return Promise.resolve().then(() => {
        expect(layer(el)).toBeNull();
        expect(el.hasAttribute('data-jump-glow')).toBe(false);
        expect(el.style.isolation).toBe('');
      });
    } finally {
      HTMLElement.prototype.animate = original;
    }
  });

  it('motion off (no Web Animations or Reduce Motion): no smooth scroll, the tint just clears at 2s', () => {
    motion.reduced = true;
    const el = row();
    glowTarget(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    vi.advanceTimersByTime(GLOW_MS);
    expect(layer(el)).toBeNull();
    expect(el.style.transition).toBe('');
    expect(el.hasAttribute('data-jump-glow')).toBe(false);
  });

  it('a smooth scroll cut short: the target still off screen is snapped in once it should have landed', () => {
    const el = row();
    el.getBoundingClientRect = () => ({ top: -400, bottom: -340 }) as DOMRect;
    glowTarget(el);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(JUMP_SETTLE_MS);
    expect(el.scrollIntoView).toHaveBeenLastCalledWith({ block: 'center' });
  });

  it('a target that landed on screen is left where it is', () => {
    const el = row();
    el.getBoundingClientRect = () => ({ top: 300, bottom: 360 }) as DOMRect;
    glowTarget(el);
    vi.advanceTimersByTime(JUMP_SETTLE_MS);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('the cleanup (unmount) clears the timers and the tint at once', () => {
    const el = row();
    const clear = glowTarget(el);
    clear();
    expect(el.hasAttribute('data-jump-glow')).toBe(false);
    expect(layer(el)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('glowInset: 8 of room around the row content', () => {
  it('a full-bleed row (16 sides, no top or bottom padding): 8 in from the sides, 8 past top and bottom', () => {
    expect(glowInset({ top: 0, right: 16, bottom: 0, left: 16 })).toEqual({
      top: '-8px',
      right: '8px',
      bottom: '-8px',
      left: '8px',
    });
  });
  it('a row with its own 12 padding keeps the mark inside it; never past the row sideways', () => {
    expect(glowInset({ top: 12, right: 0, bottom: 12, left: 4 })).toEqual({
      top: '4px',
      right: '0px',
      bottom: '4px',
      left: '0px',
    });
  });
});
