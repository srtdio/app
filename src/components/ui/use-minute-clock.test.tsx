// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMinuteClock } from '@/components/ui/use-minute-clock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): ReactElement {
  return <span data-probe="">{useMinuteClock()}</span>;
}

const read = (): number => Number(renderToStaticMarkup(<Probe />).replace(/<[^>]*>/g, ''));

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useMinuteClock', () => {
  it('a read a minute or more off the device clock catches up (no stale first paint)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    expect(read()).toBe(Date.parse('2026-11-05T10:00:00.000Z'));
    vi.setSystemTime(new Date('2026-11-05T10:30:00.000Z'));
    expect(read()).toBe(Date.parse('2026-11-05T10:30:00.000Z'));
  });

  it('within a minute the snapshot holds one value (stable for useSyncExternalStore)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
    const first = read();
    vi.setSystemTime(new Date('2026-11-05T12:00:30.000Z'));
    expect(read()).toBe(first);
  });

  it('50 mounted cards share ONE interval (no timer per card), cleared when the last unmounts', () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(new Date('2026-11-05T09:00:00.000Z'));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const cards = (n: number): ReactElement => (
      <>
        {Array.from({ length: n }, (_, i) => (
          <Probe key={i} />
        ))}
      </>
    );
    act(() => {
      root!.render(cards(50));
    });

    const probes = host.querySelectorAll('[data-probe]');
    expect(probes).toHaveLength(50);
    // Exactly one minute interval for all 50, and no per-card timeout.
    const minuteIntervals = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(minuteIntervals).toHaveLength(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(0);
    // Every card reads the same instant.
    expect(new Set(Array.from(probes, (p) => p.textContent)).size).toBe(1);

    // One tick moves all 50 together.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const after = new Set(Array.from(host.querySelectorAll('[data-probe]'), (p) => p.textContent));
    expect(after.size).toBe(1);
    expect(Number([...after][0])).toBe(Date.parse('2026-11-05T09:01:00.000Z'));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Unmounting some keeps the one interval running.
    act(() => {
      root!.render(cards(1));
    });
    expect(host.querySelectorAll('[data-probe]')).toHaveLength(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    // The last one out clears it.
    act(() => root!.unmount());
    root = null;
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy.mock.calls[0]?.[0]).toBe(setIntervalSpy.mock.results[0]?.value);
  });
});
