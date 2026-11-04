// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// syncThemeColorMeta writes the current screen's top surface (bar-tint) onto
// every theme-color meta: --panel for 'panel', the painted canvas for 'bg',
// in whichever theme the app shows (not the OS scheme).

const TOKENS = {
  light: { panel: '#ffffff', bg: 'rgb(247, 248, 249)' },
  dark: { panel: '#141519', bg: 'rgb(12, 13, 16)' },
} as const;

let reads = 0;

function stubComputed(): void {
  reads = 0;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
    reads += 1;
    const dark = document.documentElement.classList.contains('dark');
    const t = dark ? TOKENS.dark : TOKENS.light;
    return {
      backgroundColor: t.bg,
      getPropertyValue: (name: string) => (name === '--panel' ? ` ${t.panel}` : ''),
    } as unknown as CSSStyleDeclaration;
  });
}

function addMetas(): void {
  document.head.innerHTML = `
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141519" />`;
}

const contents = (): (string | null)[] =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'));

async function load() {
  vi.resetModules();
  return import('@/lib/theme');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  addMetas();
  stubComputed();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('syncThemeColorMeta', () => {
  it('panel in light writes --panel light to every meta', async () => {
    const { syncThemeColorMeta } = await load();
    syncThemeColorMeta('panel');
    expect(contents()).toEqual(['#ffffff', '#ffffff']);
  });

  it('panel in dark writes --panel dark to every meta', async () => {
    const { syncThemeColorMeta } = await load();
    document.documentElement.classList.add('dark');
    syncThemeColorMeta('panel');
    expect(contents()).toEqual(['#141519', '#141519']);
  });

  it('bg writes the painted canvas, light and dark', async () => {
    const { syncThemeColorMeta } = await load();
    syncThemeColorMeta('bg');
    expect(contents()).toEqual([TOKENS.light.bg, TOKENS.light.bg]);
    document.documentElement.classList.add('dark');
    syncThemeColorMeta('bg');
    expect(contents()).toEqual([TOKENS.dark.bg, TOKENS.dark.bg]);
  });

  it('a theme change keeps the screen tint (route set panel, toggle to dark)', async () => {
    const { syncThemeColorMeta, toggleTheme } = await load();
    syncThemeColorMeta('panel');
    expect(toggleTheme()).toBe('dark');
    expect(contents()).toEqual(['#141519', '#141519']);
    expect(toggleTheme()).toBe('light');
    expect(contents()).toEqual(['#ffffff', '#ffffff']);
  });

  it('follows the app theme, not the OS scheme (dark chosen on a light phone)', async () => {
    vi.stubGlobal(
      'matchMedia',
      (q: string) => ({ matches: q.includes('light'), media: q }) as unknown as MediaQueryList,
    );
    localStorage.setItem('sorted-theme', 'dark');
    const { initTheme, syncThemeColorMeta } = await load();
    initTheme();
    syncThemeColorMeta('panel');
    expect(contents()).toEqual(['#141519', '#141519']);
  });

  it('starts on the canvas tint outside the shell (initTheme before any route)', async () => {
    const { initTheme } = await load();
    initTheme();
    expect(contents()).toEqual([TOKENS.light.bg, TOKENS.light.bg]);
  });

  it('one computed-style read per call, no write when the value already matches', async () => {
    const { syncThemeColorMeta } = await load();
    syncThemeColorMeta('panel');
    reads = 0;
    // Both metas now hold --panel light; a second sync for the same tint writes nothing.
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
    const spies = metas.map((m) => vi.spyOn(m, 'setAttribute'));
    syncThemeColorMeta('panel');
    expect(reads).toBe(1);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
