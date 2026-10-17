// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveTick } from './useLiveTick';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({ el }: { el: HTMLElement | undefined }): ReactElement {
  const moving = useLiveTick(el);
  return <output data-moving={String(moving)} />;
}

describe('useLiveTick', () => {
  it('settles even when the settle timer lands 1 ms early (WebKit clock)', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    const fakeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      fakeSetTimeout(fn, Math.max(0, (ms ?? 0) - 1))) as typeof window.setTimeout);
    const el = document.createElement('button');
    document.body.appendChild(el);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Probe el={el} />);
    });
    expect(host.querySelector('output')?.getAttribute('data-moving')).toBe('true');
    // The settle timer lands at 119 ms and its render runs right then, as in a browser.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(host.querySelector('output')?.getAttribute('data-moving')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.querySelector('output')?.getAttribute('data-moving')).toBe('false');
  });

  it('waits through a missing target, then settles on the late-rendered one', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    // WebKit's 1 ms clock: every timer lands 1 ms early.
    const fakeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      fakeSetTimeout(fn, Math.max(0, (ms ?? 0) - 1))) as typeof window.setTimeout);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const moving = (): string | null =>
      host.querySelector('output')?.getAttribute('data-moving') ?? null;
    // No target yet (its box does not exist): nothing to measure, no throw.
    await act(async () => {
      root!.render(<Probe el={undefined} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // The target renders late, already laid out, and holds still.
    const el = document.createElement('button');
    document.body.appendChild(el);
    const rect = { top: 100, left: 20, width: 120, height: 44 };
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
      () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect,
    );
    await act(async () => {
      root!.render(<Probe el={el} />);
    });
    expect(moving()).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(moving()).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(moving()).toBe('false');
  });
});
