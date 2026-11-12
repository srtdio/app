// @vitest-environment jsdom
// ui/Textarea fit(): the 'auto' measure must never move the page. The scroll
// of the window and of the scrolled ancestor is the same before and after a
// fit on a long text; the height still fits; an unchanged height writes no
// new value.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Textarea } from '@/components/ui/Textarea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let contentHeight = 1200;
let winY = 0;

beforeEach(() => {
  contentHeight = 1200;
  winY = 400;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => winY });
  Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 });
  vi.spyOn(window, 'scrollTo').mockImplementation(((x: number, y: number) => {
    void x;
    winY = y;
  }) as typeof window.scrollTo);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
});

function view(value: string): ReactElement {
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto', height: '300px' }}>
      <Textarea autoGrow aria-label="Caption" value={value} onChange={() => undefined} />
    </div>
  );
}

/** Watch the box's height writes; 'auto' collapses the page (scroll clamps). */
function watch(el: HTMLTextAreaElement, scroller: HTMLElement): string[] {
  const writes: string[] = [];
  let h = el.style.height;
  Object.defineProperty(el.style, 'height', {
    configurable: true,
    get: () => h,
    set: (v: string) => {
      writes.push(v);
      h = v;
      if (v === 'auto') {
        scroller.scrollTop = 0;
        winY = 0;
      }
    },
  });
  return writes;
}

describe('Textarea fit holds the scroll', () => {
  it('keeps window and ancestor scroll identical and still fits the content', () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(view(long)));
    const el = host.querySelector('textarea') as HTMLTextAreaElement;
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLElement;
    expect(el.style.height).toBe('1200px');
    scroller.scrollTop = 900;
    const writes = watch(el, scroller);
    contentHeight = 1224;
    act(() => root?.render(view(`${long}\nmore`)));
    expect(scroller.scrollTop).toBe(900);
    expect(winY).toBe(400);
    expect(el.style.height).toBe('1224px');
    expect(writes).toEqual(['auto', '1224px']);
  });

  it('writes no new height when the measure is unchanged', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(view('abc')));
    const el = host.querySelector('textarea') as HTMLTextAreaElement;
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLElement;
    scroller.scrollTop = 50;
    const writes = watch(el, scroller);
    act(() => root?.render(view('abcd')));
    expect(el.style.height).toBe('1200px');
    // Only the measure and the same value back: no new height.
    expect(writes.filter((w) => w !== 'auto' && w !== '1200px')).toEqual([]);
    expect(scroller.scrollTop).toBe(50);
    expect(winY).toBe(400);
  });

  it('compact keeps its own sizing (44..128 classes, no 96 floor)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root?.render(<Textarea compact aria-label="Message" value="hi" onChange={() => undefined} />),
    );
    const el = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(el.className).toContain('min-h-11');
    expect(el.className).toContain('max-h-32');
    expect(el.style.minHeight).toBe('');
  });
});
