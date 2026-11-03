// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanBackdrop } from '@/components/auth/PlanBackdrop';
import { backdropMonthLabel, backdropWeekdays } from '@/components/auth/plan-backdrop-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = new Date(2026, 9, 25, 12);

let root: Root | null = null;
let completeSpy: { mockRestore: () => void } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
  // jsdom never loads images; start every one as still loading.
  completeSpy = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  completeSpy?.mockRestore();
  vi.useRealTimers();
});

function render(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<PlanBackdrop />);
  });
}

function layer(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-plan-backdrop-layer]')!;
}

describe('PlanBackdrop', () => {
  it('is hidden from assistive tech and ignores pointers', () => {
    render();
    const el = document.querySelector<HTMLElement>('[data-plan-backdrop]')!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toContain('pointer-events-none');
  });

  it('images are decorative and low priority', () => {
    render();
    const images = [...document.querySelectorAll('img')];
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('decoding')).toBe('async');
      expect(img.getAttribute('fetchpriority')).toBe('low');
      expect(img.getAttribute('draggable')).toBe('false');
      expect(img.getAttribute('src')).toMatch(/^\/induction-sample\/thumb\/[a-z0-9-]+\.jpg$/);
    }
  });

  it('holds no copy beyond digits, weekday labels and the month label', () => {
    render();
    let text = document.querySelector('[data-plan-backdrop]')!.textContent ?? '';
    text = text.split(backdropMonthLabel(TODAY)).join('');
    const weekdays = backdropWeekdays();
    for (const label of weekdays) text = text.split(label).join('');
    for (const label of weekdays) text = text.split(label.charAt(0)).join('');
    expect(text).toMatch(/^\d*$/);
  });

  it('renders its final state at once and never fades, loaded or not (motion: final state first)', () => {
    render();
    const cls = layer().className;
    expect(cls).not.toMatch(/opacity|transition|duration-|animate-/);
    // Images still loading change nothing: no hold, no reveal.
    act(() => {
      document.querySelectorAll('img').forEach((img) => img.dispatchEvent(new Event('load')));
    });
    expect(layer().className).toBe(cls);
  });
});
