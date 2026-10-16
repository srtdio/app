import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arriveAt,
  GLOW_FADE_MS,
  GLOW_MS,
  glowNode,
  highlightRuns,
  searchWordsFrom,
  withSearchTerm,
} from '@/lib/search/search-jump';

/** A minimal element: the style and attributes glowNode touches. */
function fakeNode(bg = ''): HTMLElement {
  const attrs = new Set<string>();
  return {
    style: { backgroundColor: bg, transition: '' },
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
    hasAttribute: (name: string) => attrs.has(name),
    scrollIntoView: vi.fn(),
  } as unknown as HTMLElement;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('withSearchTerm (one jump mechanism for every result)', () => {
  it('adds ?q= after the destination target param, whatever the type', () => {
    expect(withSearchTerm('/p/gbl-3?comment=c3', 'diwali')).toBe('/p/gbl-3?comment=c3&q=diwali');
    expect(withSearchTerm('/chat?channel=g&message=m1', 'diwali lights')).toBe(
      '/chat?channel=g&message=m1&q=diwali%20lights',
    );
    expect(withSearchTerm('/plans/p1?item=i7', 'x y')).toBe('/plans/p1?item=i7&q=x%20y');
    expect(withSearchTerm('/chat?channel=g&task=t8', 'due')).toBe('/chat?channel=g&task=t8&q=due');
    expect(withSearchTerm('/p/gbl-1', 'diwali')).toBe('/p/gbl-1?q=diwali');
    expect(withSearchTerm('/assets?asset=f5', 'logo')).toBe('/assets?asset=f5&q=logo');
  });
  it('an empty term leaves the path as it is (recents)', () => {
    expect(withSearchTerm('/p/gbl-1', '  ')).toBe('/p/gbl-1');
  });
  it('reads back as the search splits it', () => {
    expect(searchWordsFrom(new URLSearchParams('q=Diwali%20Lights'))).toEqual(['diwali', 'lights']);
    expect(searchWordsFrom(new URLSearchParams(''))).toEqual([]);
  });
});

describe('highlightRuns: the palette rule (case-insensitive word prefix)', () => {
  it('marks word starts only, inside @username too', () => {
    const runs = highlightRuns('Ping @diwali.team about Diwalis, not undiwali', ['diwali']);
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(['diwali', 'Diwalis']);
  });
});

describe('glowNode: 2s tint, then it fades', () => {
  it('tints for 2s, fades, then restores the node', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const node = fakeNode('red');
    glowNode(node, { reducedMotion: false });
    expect(node.style.backgroundColor).toBe('var(--accent-soft)');
    expect(node.style.transition).toContain('background-color');
    expect(node.hasAttribute('data-search-glow')).toBe(true);
    vi.advanceTimersByTime(GLOW_MS - 1);
    expect(node.style.backgroundColor).toBe('var(--accent-soft)');
    vi.advanceTimersByTime(1);
    expect(node.style.backgroundColor).toBe('red');
    vi.advanceTimersByTime(GLOW_FADE_MS);
    expect(node.hasAttribute('data-search-glow')).toBe(false);
    expect(node.style.transition).toBe('');
  });
  it('reduced motion: no transition, the tint clears at 2s', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const node = fakeNode();
    glowNode(node, { reducedMotion: true });
    expect(node.style.transition).toBe('none');
    vi.advanceTimersByTime(GLOW_MS);
    expect(node.style.backgroundColor).toBe('');
    expect(node.hasAttribute('data-search-glow')).toBe(false);
  });
  it('the cleanup (unmount) resets at once and cancels the timers', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const node = fakeNode();
    const stop = glowNode(node, { reducedMotion: false });
    stop();
    expect(node.hasAttribute('data-search-glow')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('arriveAt centres the target (smooth, or instant under reduced motion)', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    const node = fakeNode();
    arriveAt(node, { reducedMotion: false });
    expect(node.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    const still = fakeNode();
    arriveAt(still, { reducedMotion: true });
    expect(still.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });
});
