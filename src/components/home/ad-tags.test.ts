// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { warn } }));

const META = 'https://connect.facebook.net/en_US/fbevents.js';
const GTAG = 'https://www.googletagmanager.com/gtag/js';
const LINKEDIN = 'https://snap.licdn.com/li.lms-analytics/insight.min.js';

function scripts(prefix: string): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll('script')).filter((s) => s.src.startsWith(prefix));
}

async function run(times = 1): Promise<void> {
  const { loadAdTags } = await import('./ad-tags');
  for (let i = 0; i < times; i += 1) loadAdTags();
  vi.runAllTimers();
  // Let the lazy logger import settle.
  await vi.dynamicImportSettled();
}

function setIds(ids: Partial<Record<string, string>>): void {
  for (const [name, value] of Object.entries(ids)) vi.stubEnv(name, value ?? '');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  warn.mockClear();
  // Force the setTimeout path; jsdom has no requestIdleCallback.
  vi.stubGlobal('requestIdleCallback', undefined);
  setIds({
    VITE_META_PIXEL_ID: '',
    VITE_GOOGLE_TAG_ID: '',
    VITE_GOOGLE_ADS_ID: '',
    VITE_LINKEDIN_PARTNER_ID: '',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  delete window.fbq;
  delete window._fbq;
  delete window.dataLayer;
  delete window.gtag;
  delete window.lintrk;
  delete window._linkedin_partner_id;
  delete window._linkedin_data_partner_ids;
});

describe('loadAdTags', () => {
  it('injects nothing with no ids set', async () => {
    await run();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(window.fbq).toBeUndefined();
    expect(window.gtag).toBeUndefined();
    expect(window.lintrk).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('waits until after first paint', async () => {
    setIds({ VITE_META_PIXEL_ID: '123' });
    const { loadAdTags } = await import('./ad-tags');
    loadAdTags();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    vi.runAllTimers();
    expect(scripts(META)).toHaveLength(1);
  });

  it('injects exactly one script per vendor with all ids set', async () => {
    setIds({
      VITE_META_PIXEL_ID: '123456',
      VITE_GOOGLE_TAG_ID: 'G-ABC123',
      VITE_LINKEDIN_PARTNER_ID: '7890',
    });
    await run();
    expect(scripts(META)).toHaveLength(1);
    expect(scripts(GTAG)).toHaveLength(1);
    expect(scripts(LINKEDIN)).toHaveLength(1);
    expect(document.querySelectorAll('script')).toHaveLength(3);
    for (const s of document.querySelectorAll('script')) expect(s.async).toBe(true);
    expect(window.fbq?.queue).toEqual([
      ['init', '123456'],
      ['track', 'PageView'],
    ]);
    expect(window._linkedin_partner_id).toBe('7890');
    expect(window._linkedin_data_partner_ids).toEqual(['7890']);
    expect(typeof window.lintrk).toBe('function');
  });

  it('loads one gtag script and configures both Google ids', async () => {
    setIds({ VITE_GOOGLE_TAG_ID: 'G-ABC123', VITE_GOOGLE_ADS_ID: 'AW-456789' });
    await run();
    const gtag = scripts(GTAG);
    expect(gtag).toHaveLength(1);
    expect(gtag[0]?.src).toBe(`${GTAG}?id=G-ABC123`);
    const calls = (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(calls[0]?.[0]).toBe('js');
    expect(calls.filter((c) => c[0] === 'config')).toEqual([
      ['config', 'G-ABC123'],
      ['config', 'AW-456789'],
    ]);
  });

  it('uses the Ads id for the gtag script when it is the only Google id', async () => {
    setIds({ VITE_GOOGLE_ADS_ID: 'AW-456789' });
    await run();
    expect(scripts(GTAG).map((s) => s.src)).toEqual([`${GTAG}?id=AW-456789`]);
  });

  it('skips invalid ids with a warning and never throws', async () => {
    setIds({
      VITE_META_PIXEL_ID: 'abc',
      VITE_GOOGLE_TAG_ID: 'UA-1',
      VITE_GOOGLE_ADS_ID: 'G-123',
      VITE_LINKEDIN_PARTNER_ID: '12x',
    });
    await expect(run()).resolves.toBeUndefined();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(4));
    expect(warn).toHaveBeenCalledWith('ad tag id invalid, skipped', { var: 'VITE_META_PIXEL_ID' });
  });

  it('injects nothing new on a second call', async () => {
    setIds({
      VITE_META_PIXEL_ID: '123456',
      VITE_GOOGLE_TAG_ID: 'G-ABC123',
      VITE_GOOGLE_ADS_ID: 'AW-456789',
      VITE_LINKEDIN_PARTNER_ID: '7890',
    });
    await run(2);
    const { loadAdTags } = await import('./ad-tags');
    loadAdTags();
    vi.runAllTimers();
    expect(document.querySelectorAll('script')).toHaveLength(3);
    expect(window.fbq?.queue).toHaveLength(2);
    expect(window.dataLayer).toHaveLength(3);
  });
});

describe('ad-tags import boundary', () => {
  // Vitest runs from the repo root (jsdom gives import.meta.url an http scheme).
  const root = process.cwd();
  const homeDir = join('src', 'components', 'home') + sep;
  const SKIP = new Set([
    'node_modules',
    'dist',
    '.git',
    'coverage',
    'playwright-report',
    'test-results',
  ]);
  const SOURCE = /\.(ts|tsx|mts|cts)$/;
  const IMPORTS_AD_TAGS = /(?:from\s+|import\s*\(\s*|import\s+)['"][^'"]*\/ad-tags(?:\.ts)?['"]/;

  function walk(dir: string, out: string[]): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (SOURCE.test(name)) out.push(path);
    }
    return out;
  }

  it('is imported only from src/components/home/', () => {
    const files = ['src', 'packages', 'workers', 'tests', 'e2e'].flatMap((dir) => {
      try {
        return walk(join(root, dir), []);
      } catch {
        return [];
      }
    });
    const importers = files
      .filter((file) => IMPORTS_AD_TAGS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(importers).toContain(join('src', 'components', 'home', 'HomeEntry.tsx'));
    expect(importers.filter((file) => !file.startsWith(homeDir))).toEqual([]);
  });
});
