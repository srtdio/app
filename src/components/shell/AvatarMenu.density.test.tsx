// @vitest-environment jsdom
// Density in the account menu (decided 8 Nov 2026): under Appearance, a
// "Density" label and three tap chips (Compact, Cozy, Calm) in a 3-column grid.
// A tap applies at once (<html data-density> + the device cache, no await) and
// saves fire-and-forget through user_density_set; a failed save reverts and
// shows "Couldn't save density." with Retry. The menu stays open throughout.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, userDensitySet } = vi.hoisted(() => ({
  navigate: vi.fn(),
  userDensitySet: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/components/induction/InductionProvider', () => ({ useInduction: () => null }));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => ({ theme: 'light', toggle: vi.fn() }) }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { tag: 'supabase' } }));
vi.mock('@srtdio/rpc', () => ({ userDensitySet }));
vi.mock('@/lib/use-current-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-current-profile')>()),
  getProfileSnapshot: () => ({ userId: 'u-1', profile: null, loading: false, error: false }),
}));

import { AvatarMenu, DENSITY_SAVE_FAILED } from '@/components/shell/AvatarMenu';
import { resetDensityForTest } from '@/lib/density';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onClose = vi.fn();

beforeEach(() => {
  navigate.mockReset();
  onClose.mockReset();
  userDensitySet.mockReset();
  userDensitySet.mockResolvedValue({ ok: true, data: null });
  localStorage.clear();
  resetDensityForTest();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  localStorage.clear();
  resetDensityForTest();
});

function mount(): void {
  root = createRoot(host!);
  act(() => root!.render(<AvatarMenu open onClose={onClose} />));
}

const html = (): string | undefined => document.documentElement.dataset.density;
const chip = (d: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-density-pick="${d}"]`)!;
const picked = (): string[] =>
  Array.from(document.querySelectorAll('[data-density-pick][data-selected="true"]')).map(
    (el) => el.getAttribute('data-density-pick') ?? '',
  );

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('AvatarMenu: the Density row', () => {
  it('sits right under Appearance: the "Density" label, then Compact, Cozy, Calm in grid-cols-3', () => {
    mount();
    const row = document.querySelector('[data-density-row]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('Density');
    const appearance = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (el) => el.textContent === 'Appearance',
    );
    expect(appearance?.nextElementSibling).toBe(row);
    const group = row!.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Density');
    expect(group?.className.split(' ')).toEqual(expect.arrayContaining(['grid', 'grid-cols-3']));
    const chips = Array.from(group!.querySelectorAll<HTMLButtonElement>('[data-density-pick]'));
    expect(chips.map((c) => c.textContent)).toEqual(['Compact', 'Cozy', 'Calm']);
    expect(chips.map((c) => c.getAttribute('data-density-pick'))).toEqual([
      'compact',
      'cozy',
      'calm',
    ]);
    for (const c of chips) {
      expect(c.getAttribute('role')).toBe('radio');
      expect(c.hasAttribute('aria-pressed')).toBe(false);
      // A tap chip filling its cell: the 44 box, the label centred on the face.
      expect(c.className).toContain('min-h-11');
      expect(c.querySelector('[data-chip-face]')?.className).toContain('justify-center');
    }
    // The density chips are not menu items (the arrow keys move between rows).
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent),
    ).not.toContain('Compact');
  });

  it('the picked density has data-selected and aria-checked; Cozy by default', () => {
    mount();
    expect(picked()).toEqual(['cozy']);
    expect(chip('cozy').getAttribute('aria-checked')).toBe('true');
    expect(chip('compact').getAttribute('aria-checked')).toBe('false');
  });

  it('shows the density already on <html> (booted from the device)', () => {
    document.documentElement.dataset.density = 'calm';
    mount();
    expect(picked()).toEqual(['calm']);
  });

  it('the laptop popover is w-72 (room for the three chips)', () => {
    mount();
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.className.split(' ')).toContain('w-72');
    expect(menu?.className.split(' ')).not.toContain('w-60');
  });

  it('a tap applies at once: <html data-density> and the device cache, then one save', () => {
    let settle: (v: unknown) => void = () => {};
    userDensitySet.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    mount();
    act(() => chip('compact').click());
    // Applied before the save settles (no await on the tap path).
    expect(html()).toBe('compact');
    expect(localStorage.getItem('sorted-density')).toBe('compact');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('compact');
    expect(picked()).toEqual(['compact']);
    expect(userDensitySet).toHaveBeenCalledTimes(1);
    expect(userDensitySet).toHaveBeenCalledWith(
      { tag: 'supabase' },
      { p_density: 'compact', p_trace_id: expect.any(String) },
    );
    const traceId = (userDensitySet.mock.calls[0]?.[1] as { p_trace_id: string }).p_trace_id;
    expect(traceId.length).toBeGreaterThan(0);
    settle({ ok: true, data: null });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a saved pick stays, with no error, and the menu stays open', async () => {
    mount();
    act(() => chip('calm').click());
    await flush();
    expect(html()).toBe('calm');
    expect(picked()).toEqual(['calm']);
    expect(document.body.textContent).not.toContain(DENSITY_SAVE_FAILED);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('tapping the density already picked saves nothing', () => {
    mount();
    act(() => chip('cozy').click());
    expect(userDensitySet).not.toHaveBeenCalled();
    expect(html()).toBe('cozy');
  });

  it('a failed save ({ok:false}) reverts and shows the error with Retry; the menu stays open', async () => {
    userDensitySet.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'down' },
    });
    mount();
    act(() => chip('compact').click());
    expect(html()).toBe('compact');
    await flush();
    expect(html()).toBe('cozy');
    expect(localStorage.getItem('sorted-density')).toBe('cozy');
    expect(localStorage.getItem('sorted-density:u-1')).toBe('cozy');
    expect(picked()).toEqual(['cozy']);
    expect(DENSITY_SAVE_FAILED).toBe("Couldn't save density.");
    const alert = document.querySelector('[data-density-row] [role="alert"]');
    expect(alert?.textContent).toContain("Couldn't save density.");
    const retry = Array.from(alert!.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // Retry re-applies the failed pick and saves it again.
    userDensitySet.mockResolvedValue({ ok: true, data: null });
    act(() => retry!.click());
    expect(html()).toBe('compact');
    expect(document.body.textContent).not.toContain(DENSITY_SAVE_FAILED);
    await flush();
    expect(userDensitySet).toHaveBeenCalledTimes(2);
    expect(userDensitySet.mock.calls[1]?.[1]).toEqual({
      p_density: 'compact',
      p_trace_id: expect.any(String),
    });
    expect(html()).toBe('compact');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a save that throws reverts the same way', async () => {
    userDensitySet.mockRejectedValue(new Error('network'));
    mount();
    act(() => chip('calm').click());
    await flush();
    expect(html()).toBe('cozy');
    expect(document.body.textContent).toContain(DENSITY_SAVE_FAILED);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a late failure never undoes a newer pick', async () => {
    let failFirst: (v: unknown) => void = () => {};
    userDensitySet
      .mockReturnValueOnce(new Promise((resolve) => (failFirst = resolve)))
      .mockResolvedValue({ ok: true, data: null });
    mount();
    act(() => chip('compact').click());
    act(() => chip('calm').click());
    expect(html()).toBe('calm');
    failFirst({ ok: false, error: { code: 'internal', message: 'down' } });
    await flush();
    expect(html()).toBe('calm');
    expect(picked()).toEqual(['calm']);
    expect(document.body.textContent).not.toContain(DENSITY_SAVE_FAILED);
  });
});
