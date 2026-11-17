// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { searchChips } from '@/components/chat/ChannelList';
import { chipRowEdges, chipRowMask } from '@/components/ui/use-chip-row-fade';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const edges = (scrollLeft: number, clientWidth = 300, scrollWidth = 500) =>
  chipRowEdges({ scrollLeft, clientWidth, scrollWidth });

describe('chipRowEdges / chipRowMask (pure)', () => {
  it('no overflow, slack included, gives no fade', () => {
    expect(edges(0, 300, 300)).toEqual({ start: false, end: false });
    expect(edges(0, 300, 302)).toEqual({ start: false, end: false });
    expect(edges(2, 300, 302)).toEqual({ start: false, end: false });
    expect(chipRowMask(false, false)).toBe('none');
    expect(chipRowMask(false, false, true)).toBe('none');
  });

  it('start / middle / end of a 300 row over 500 of chips', () => {
    expect(edges(0)).toEqual({ start: false, end: true });
    expect(edges(100)).toEqual({ start: true, end: true });
    expect(edges(200)).toEqual({ start: true, end: false });
  });

  it('RTL scrollLeft runs negative', () => {
    expect(edges(-100)).toEqual({ start: true, end: true });
    expect(edges(-200)).toEqual({ start: true, end: false });
    expect(chipRowMask(true, true, true).startsWith('linear-gradient(to left, transparent 0')).toBe(
      true,
    );
  });

  it('single-edge masks, exact', () => {
    expect(chipRowMask(false, true)).toBe(
      'linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)',
    );
    expect(chipRowMask(true, false)).toBe(
      'linear-gradient(to right, transparent 0, black 24px, black 100%)',
    );
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(kind: 'photo' | null = null): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(searchChips({ kind, onChange: () => undefined })));
  const row = host.querySelector<HTMLDivElement>('[data-search-chips]');
  if (row === null) throw new Error('no chip row');
  return row;
}

function size(row: HTMLElement, clientWidth: number, scrollWidth: number): void {
  Object.defineProperty(row, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(row, 'scrollWidth', { configurable: true, value: scrollWidth });
}

function scrollTo(row: HTMLElement, left: number): void {
  act(() => {
    row.scrollLeft = left;
    row.dispatchEvent(new Event('scroll'));
  });
}

describe('searchChips row fade (behaviour)', () => {
  it("mask is 'none' before measuring", () => {
    const row = mount();
    expect(row.style.maskImage).toBe('none');
  });

  it('className keeps a keyboard inset and drops the static padding', () => {
    const row = mount();
    expect(row.className).toContain('scroll-px-6');
    expect(row.className).not.toContain('pr-10');
  });

  it('start / middle / end masks follow the scroll', () => {
    const row = mount();
    size(row, 300, 500);
    scrollTo(row, 0);
    expect(row.style.maskImage).toBe(chipRowMask(false, true));
    scrollTo(row, 100);
    expect(row.style.maskImage).toBe(chipRowMask(true, true));
    scrollTo(row, 200);
    expect(row.style.maskImage).toBe(chipRowMask(true, false));
    expect(row.style.webkitMaskImage).toBe(row.style.maskImage);
  });

  it("widening the row to no overflow gives 'none'", () => {
    const row = mount();
    size(row, 300, 500);
    scrollTo(row, 100);
    expect(row.style.maskImage).not.toBe('none');
    size(row, 500, 500);
    scrollTo(row, 0);
    expect(row.style.maskImage).toBe('none');
  });

  it("kind 'photo': photo first, pressed, with its Clear", () => {
    const row = mount('photo');
    const first = row.querySelector('[data-search-chip]');
    expect(first?.getAttribute('data-search-chip')).toBe('photo');
    expect(first?.getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-chip-clear]')).not.toBeNull();
  });

  it('a scroll after unmount does not throw', () => {
    const row = mount();
    act(() => root?.unmount());
    root = null;
    expect(() => row.dispatchEvent(new Event('scroll'))).not.toThrow();
  });
});
