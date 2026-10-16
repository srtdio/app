// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOW_MS,
  glowById,
  glowTarget,
  Highlight,
  highlightNodes,
  SEARCH_MARK_CLASS,
  SearchWordsContext,
} from '@/components/ui/SearchHighlight';
import { DUR_SLOW_MS } from '@/lib/motion';

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
    expect(SEARCH_MARK_CLASS).toContain('bg-annotation-bg');
    expect(SEARCH_MARK_CLASS).toContain('[color:var(--fg)]');
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
  let reduced = false;
  beforeEach(() => {
    vi.useFakeTimers();
    reduced = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reduced && query.includes('reduce'),
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function row(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'target';
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  }

  it('centres the target, tints it for 2s, then fades the tint out', () => {
    const el = row();
    glowTarget(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(el.style.backgroundColor).toBe('var(--accent-soft)');
    expect(el.hasAttribute('data-jump-glow')).toBe(true);
    vi.advanceTimersByTime(GLOW_MS - 1);
    expect(el.style.backgroundColor).toBe('var(--accent-soft)');
    vi.advanceTimersByTime(1);
    // Fading: a transition back to the row's own background.
    expect(el.style.transition).toContain('background-color');
    expect(el.style.backgroundColor).toBe('');
    vi.advanceTimersByTime(DUR_SLOW_MS * 3);
    expect(el.hasAttribute('data-jump-glow')).toBe(false);
    expect(el.style.transition).toBe('');
  });

  it('reduced motion: no smooth scroll, no fade; the tint just clears at 2s', () => {
    reduced = true;
    const el = row();
    glowTarget(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    vi.advanceTimersByTime(GLOW_MS);
    expect(el.style.backgroundColor).toBe('');
    expect(el.style.transition).toBe('');
    expect(el.hasAttribute('data-jump-glow')).toBe(false);
  });

  it('the cleanup (unmount) clears the timers and the tint at once', () => {
    const el = row();
    const clear = glowTarget(el);
    clear();
    expect(el.hasAttribute('data-jump-glow')).toBe(false);
    expect(el.style.backgroundColor).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a target that is not rendered (deleted, inaccessible) is a quiet no-op', () => {
    const clear = glowById('nowhere');
    expect(vi.getTimerCount()).toBe(0);
    expect(() => clear()).not.toThrow();
  });
});

describe('search highlight contrast, light and dark', () => {
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  const HASH = String.fromCharCode(35);
  function tokens(selector: string): Map<string, string> {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('}', start));
    const out = new Map<string, string>();
    const pattern = new RegExp(`--([\\w-]+):\\s*${HASH}([0-9a-f]{6});`, 'gi');
    for (const match of body.matchAll(pattern)) out.set(match[1] ?? '', match[2] ?? '');
    return out;
  }
  function luminance(hex: string): number {
    const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function ratio(a: string, b: string): number {
    const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    it(`--fg on --annotation-bg is at least 4.5:1 (${theme})`, () => {
      const t = tokens(selector);
      expect(ratio(t.get('fg') ?? '', t.get('annotation-bg') ?? '')).toBeGreaterThanOrEqual(4.5);
    });
  }
});
