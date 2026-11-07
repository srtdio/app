import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMinuteClock } from '@/components/ui/use-minute-clock';

function Probe(): ReactElement {
  return <span>{useMinuteClock()}</span>;
}

const read = (): number => Number(renderToStaticMarkup(<Probe />).replace(/<[^>]*>/g, ''));

afterEach(() => {
  vi.useRealTimers();
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
});
