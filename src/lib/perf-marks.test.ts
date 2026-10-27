import { afterEach, describe, expect, it, vi } from 'vitest';
import { mark, readMarks } from '@/lib/perf-marks';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mark', () => {
  it('is a no-op when performance is missing', () => {
    vi.stubGlobal('performance', undefined);
    expect(() => mark('boot:path')).not.toThrow();
    expect(readMarks()).toEqual([]);
  });

  it('is a no-op when performance.mark is missing', () => {
    vi.stubGlobal('performance', { getEntriesByType: () => [] });
    expect(() => mark('boot:path')).not.toThrow();
  });

  it('never throws when performance.mark throws', () => {
    vi.stubGlobal('performance', {
      mark: () => {
        throw new Error('nope');
      },
    });
    expect(() => mark('boot:path')).not.toThrow();
  });

  it('calls performance.mark with the name', () => {
    const calls: string[] = [];
    vi.stubGlobal('performance', { mark: (name: string) => calls.push(name) });
    mark('pipeline:mount');
    expect(calls).toEqual(['pipeline:mount']);
  });
});

describe('readMarks', () => {
  it('returns marks sorted by ms, rounded to 1 decimal', () => {
    vi.stubGlobal('performance', {
      getEntriesByType: (type: string) =>
        type === 'mark'
          ? [
              { name: 'b', startTime: 20.26 },
              { name: 'a', startTime: 5.04 },
              { name: 'c', startTime: 12.56 },
            ]
          : [],
    });
    expect(readMarks()).toEqual([
      { name: 'a', ms: 5 },
      { name: 'c', ms: 12.6 },
      { name: 'b', ms: 20.3 },
    ]);
  });

  it('returns an empty list on any error', () => {
    vi.stubGlobal('performance', {
      getEntriesByType: () => {
        throw new Error('nope');
      },
    });
    expect(readMarks()).toEqual([]);
  });
});
