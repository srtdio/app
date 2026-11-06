// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  AlertsBlock,
  EmailOptInRow,
  optedOutByOther,
  pauseLabel,
} from '@/components/settings/ProfileSettingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'u-me';
const OTHER = 'u-owner';
const KEY = `sorted:alert-prefs:v1:${ME}`;
const HOUR_MS = 3_600_000;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function mount(): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AlertsBlock userId={ME} />));
  return host;
}

function seed(prefs: {
  sound: boolean;
  notifications: boolean;
  pausedUntilMs: number | null;
  pausedHours: number | null;
}): void {
  window.localStorage.setItem(KEY, JSON.stringify(prefs));
}

function stored(): Record<string, unknown> {
  const raw = window.localStorage.getItem(KEY);
  expect(raw).not.toBeNull();
  return JSON.parse(raw ?? '{}') as Record<string, unknown>;
}

function chips(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[data-pause-hours]')];
}

function switchFor(el: HTMLElement, label: string): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  expect(found).not.toBeNull();
  return found!;
}

const LABELS = ['1 hour', '2 hours', '3 hours', '4 hours', '5 hours', '6 hours'];

describe('Alerts on this device', () => {
  it('idle: two switches, Pause for, six chips, no banner', () => {
    const el = mount();
    expect(el.textContent).toContain('Alerts on this device');
    expect(el.querySelector('h3')?.className).toContain(
      'text-sm font-semibold uppercase tracking-[0.06em] text-fg-2',
    );
    expect(el.querySelectorAll('[role="switch"]')).toHaveLength(2);
    switchFor(el, 'Sound');
    switchFor(el, 'Alerts');
    expect(el.textContent).toContain('Pause for');
    const all = chips(el);
    expect(all.map((c) => c.textContent)).toEqual(LABELS);
    for (const chip of all) {
      expect(chip.className).toContain('min-h-11');
      expect(chip.className).toContain('w-full');
      expect(chip.getAttribute('aria-pressed')).toBe('false');
    }
    expect(el.querySelector('[data-alerts-paused]')).toBeNull();
    expect(el.textContent).not.toContain('Paused until');
    expect(el.textContent).not.toContain('Resume');
  });

  it('paused: banner with Paused until and Resume; Pause for stays; the active chip is selected', () => {
    seed({
      sound: true,
      notifications: true,
      pausedUntilMs: Date.now() + 2 * HOUR_MS,
      pausedHours: 2,
    });
    const el = mount();
    const banner = el.querySelector<HTMLElement>('[data-alerts-paused]');
    expect(banner).not.toBeNull();
    expect(banner!.className).toContain(
      'mt-4 flex items-center justify-between gap-3 rounded-lg bg-accent-soft py-2 pr-2 pl-3 lit-tint',
    );
    expect(banner!.textContent).toContain('Paused until');
    expect(banner!.querySelector('.font-mono.tabular-nums')).not.toBeNull();
    expect(banner!.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(banner!.textContent).toContain('Resume');
    // Never replaced while paused: the label and all six chips still render.
    expect(el.textContent).toContain('Pause for');
    const all = chips(el);
    expect(all).toHaveLength(6);
    const selected = all.filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(selected.map((c) => c.textContent)).toEqual(['2 hours']);
    expect(selected[0]!.className).toContain('lit-pill');
  });

  it('an ended pause shows no banner and no selected chip', () => {
    seed({ sound: true, notifications: true, pausedUntilMs: Date.now() - 1000, pausedHours: 3 });
    const el = mount();
    expect(el.querySelector('[data-alerts-paused]')).toBeNull();
    expect(chips(el).some((c) => c.getAttribute('aria-pressed') === 'true')).toBe(false);
  });

  it('tapping a chip stores the pause; Resume clears it', () => {
    const el = mount();
    const four = chips(el).find((c) => c.textContent === '4 hours')!;
    act(() => four.click());
    const paused = stored();
    expect(paused.pausedHours).toBe(4);
    expect(typeof paused.pausedUntilMs).toBe('number');
    expect(paused.pausedUntilMs as number).toBeGreaterThan(Date.now() + 3 * HOUR_MS);
    expect(el.querySelector('[data-alerts-paused]')).not.toBeNull();
    const resume = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Resume')!;
    act(() => resume.click());
    const resumed = stored();
    expect(resumed.pausedHours ?? null).toBeNull();
    expect(resumed.pausedUntilMs ?? null).toBeNull();
    expect(el.querySelector('[data-alerts-paused]')).toBeNull();
  });

  it('the Sound switch toggles the stored sound', () => {
    seed({ sound: true, notifications: true, pausedUntilMs: null, pausedHours: null });
    const el = mount();
    const sound = switchFor(el, 'Sound');
    expect(sound.getAttribute('aria-checked')).toBe('true');
    act(() => sound.click());
    expect(stored().sound).toBe(false);
    expect(switchFor(el, 'Sound').getAttribute('aria-checked')).toBe('false');
    // Notifications is untouched.
    expect(stored().notifications).toBe(true);
  });

  it('chip labels', () => {
    expect(pauseLabel(1)).toBe('1 hour');
    expect(pauseLabel(6)).toBe('6 hours');
  });

  it('tokens only, no shadow or motion classes on the banner', () => {
    seed({ sound: true, notifications: true, pausedUntilMs: Date.now() + HOUR_MS, pausedHours: 1 });
    const el = mount();
    const html = el.innerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain('dark:');
    expect(html).not.toMatch(/\bshadow-/);
    const banner = el.querySelector<HTMLElement>('[data-alerts-paused]')!;
    expect(banner.className).not.toMatch(/transition|duration-|animate-/);
  });
});

describe('Turned off by', () => {
  const by = { userId: OTHER, name: 'Ravi Menon' };

  it('shows the line with a PersonTrigger when off and opted out by someone else', () => {
    const out = renderToStaticMarkup(
      <EmailOptInRow checked={false} onChange={() => {}} optedOutBy={by} />,
    );
    expect(out).toContain('Turned off by ');
    expect(out).toContain(`data-person-trigger="${OTHER}"`);
    expect(out).toContain('Ravi Menon');
  });

  it('is hidden while the emails are on, and with no one named', () => {
    const on = renderToStaticMarkup(<EmailOptInRow checked onChange={() => {}} optedOutBy={by} />);
    expect(on).not.toContain('Turned off by');
    const none = renderToStaticMarkup(
      <EmailOptInRow checked={false} onChange={() => {}} optedOutBy={null} />,
    );
    expect(none).not.toContain('Turned off by');
  });

  it('names someone only when off and by another person', () => {
    expect(optedOutByOther({ email_opt_in: false, emailOptOutBy: OTHER }, ME)).toBe(OTHER);
    expect(optedOutByOther({ email_opt_in: false, emailOptOutBy: ME }, ME)).toBeNull();
    expect(optedOutByOther({ email_opt_in: false, emailOptOutBy: null }, ME)).toBeNull();
    expect(optedOutByOther({ email_opt_in: true, emailOptOutBy: OTHER }, ME)).toBeNull();
    expect(optedOutByOther(null, ME)).toBeNull();
  });
});
