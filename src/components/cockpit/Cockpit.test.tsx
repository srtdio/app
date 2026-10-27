// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitFull, CockpitTab } from '@/lib/cockpit/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const layout = vi.hoisted(() => ({ laptop: true }));
vi.mock('@/lib/use-is-laptop', () => ({
  useIsLaptop: () => layout.laptop,
  isLaptopNow: () => layout.laptop,
  prefersReducedMotion: () => true,
}));

const calls = vi.hoisted(() => ({ full: [] as [string, boolean][], status: 0 }));
vi.mock('@/lib/cockpit/client', () => ({
  fetchCockpitStatus: () => {
    calls.status += 1;
    return Promise.resolve({ checked_at: '2026-10-27T10:00:00Z', level: 'green', alerts: [] });
  },
  fetchCockpitFull: (tab: CockpitTab, open: boolean) => {
    calls.full.push([tab, open]);
    const answer: CockpitFull = {
      checked_at: '2026-10-27T10:00:00Z',
      level: 'green',
      alerts: [],
      tab,
      tiles: {
        errors: { state: 'error', reason: "Can't reach Sentry" },
        backend: { state: 'ok', value: 0, level: 'green' },
        email: { state: 'ok', value: 12, level: 'green' },
        chat: { state: 'ok', value: 30, level: 'green' },
        traffic: { state: 'ok', value: 410, level: 'green' },
        users: { state: 'ok', value: 7, level: 'green' },
      },
      data: null,
    } as CockpitFull;
    return Promise.resolve(answer);
  },
}));

import {
  CockpitDot,
  CockpitPanel,
  SWIPE_CLOSE_PX,
  swipeCloses,
} from '@/components/cockpit/Cockpit';
import { getCockpitState, resetCockpitState } from '@/lib/cockpit/store';

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(): Promise<HTMLButtonElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <>
        <CockpitDot />
        <CockpitPanel />
      </>,
    );
    await wait(10);
  });
  const dot = document.querySelector<HTMLButtonElement>('[data-cockpit-dot]');
  if (dot === null) throw new Error('no dot');
  return dot;
}

async function settle(ms = 250): Promise<void> {
  await act(async () => {
    await wait(ms);
  });
}

const panel = () => document.querySelector<HTMLElement>('aside[aria-label="Cockpit"]');
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Cockpit"]');

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

beforeEach(() => {
  resetCockpitState();
  calls.full = [];
  calls.status = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Cockpit dot', () => {
  it('paints grey with no request on its first frame', async () => {
    const dot = await mount();
    expect(dot.getAttribute('data-cockpit-dot')).toBe('grey');
    expect(dot.getAttribute('aria-label')).toBe('Cockpit');
    expect(calls.status).toBe(0);
    expect(calls.full).toEqual([]);
    expect(dot.className).toContain('h-11');
  });
});

describe('Cockpit on laptop', () => {
  beforeEach(() => {
    layout.laptop = true;
  });

  it('the dot opens the side panel on Needs you; Esc and X close it', async () => {
    const dot = await mount();
    await act(async () => dot.click());
    await settle();
    expect(panel()).not.toBeNull();
    expect(sheet()).toBeNull();
    expect(calls.full[0]).toEqual(['needs', true]);
    expect(dot.getAttribute('aria-label')).toBe('Cockpit: all clear');
    expect(panel()?.textContent).toContain('All clear');
    expect(panel()?.textContent).toContain("Can't reach Sentry");

    await pressEscape();
    await settle();
    expect(getCockpitState().open).toBe(false);
    expect(panel()).toBeNull();

    await act(async () => dot.click());
    await settle();
    const x = panel()?.querySelector<HTMLButtonElement>('[aria-label="Close"]');
    await act(async () => x?.click());
    await settle();
    expect(panel()).toBeNull();
  });

  it('a tile picks its tab, and reopening returns to that tab', async () => {
    const dot = await mount();
    await act(async () => dot.click());
    await settle();
    const usersTile = [...(panel()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => b.textContent?.startsWith('Users'),
    );
    await act(async () => usersTile?.click());
    await settle();
    expect(calls.full.at(-1)).toEqual(['users', true]);
    await pressEscape();
    await settle();
    await act(async () => dot.click());
    await settle();
    expect(calls.full.at(-1)).toEqual(['users', true]);
    expect(getCockpitState().tab).toBe('users');
  });
});

describe('Cockpit on phone', () => {
  beforeEach(() => {
    layout.laptop = false;
  });

  it('the dot opens a bottom sheet; X closes it', async () => {
    const dot = await mount();
    await act(async () => dot.click());
    await settle();
    expect(sheet()).not.toBeNull();
    expect(panel()).toBeNull();
    const x = sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]');
    await act(async () => x?.click());
    await settle();
    expect(getCockpitState().open).toBe(false);
  });

  it('the sheet carries the swipe-down close; a swipe from the top closes', async () => {
    const dot = await mount();
    await act(async () => dot.click());
    await settle();
    expect(sheet()?.querySelector('[data-cockpit-swipe]')).not.toBeNull();
    expect(swipeCloses({ y: 100, atTop: true }, 100 + SWIPE_CLOSE_PX + 1)).toBe(true);
    // Scrolled down inside, a short pull, or an upward swipe: the sheet stays.
    expect(swipeCloses({ y: 100, atTop: false }, 400)).toBe(false);
    expect(swipeCloses({ y: 100, atTop: true }, 150)).toBe(false);
    expect(swipeCloses({ y: 300, atTop: true }, 100)).toBe(false);
    expect(swipeCloses(null, 400)).toBe(false);
  });

  it('Esc closes the sheet too', async () => {
    const dot = await mount();
    await act(async () => dot.click());
    await settle();
    await pressEscape();
    await settle();
    expect(getCockpitState().open).toBe(false);
  });
});
