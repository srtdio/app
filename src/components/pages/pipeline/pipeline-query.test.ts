import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dateChipLabel,
  dateFilterActive,
  filtersActive,
  parsePipelineQuery,
  pipelineQueryParams,
  readShown,
  showMoreKey,
  writeShown,
  type PipelineQuery,
} from '@/components/pages/pipeline/pipeline-query';

const INITIAL = 'review';

describe('W4 fix 2: filters live in the URL query', () => {
  it('round-trips stage, search, date window and custom range through the query', () => {
    const query: PipelineQuery = {
      stage: 'approved',
      search: 'launch',
      dateWindow: 'custom',
      customRange: { start: '2026-06-24', end: '2026-06-27' },
    };
    const params = pipelineQueryParams(query, INITIAL);
    expect(params.toString()).toBe(
      'stage=approved&q=launch&date=custom&from=2026-06-24&to=2026-06-27',
    );
    // Back lands on this URL again: parsing it restores the same filters.
    expect(parsePipelineQuery(new URLSearchParams(params.toString()), INITIAL)).toEqual(query);
  });

  it('leaves defaults out, so a clean board has a clean URL', () => {
    const clean = parsePipelineQuery(new URLSearchParams(), INITIAL);
    expect(clean).toEqual({ stage: 'review', search: '', dateWindow: 'any', customRange: null });
    expect(pipelineQueryParams(clean, INITIAL).toString()).toBe('');
  });

  it('ignores a junk window or a malformed range', () => {
    const q = parsePipelineQuery(
      new URLSearchParams('date=forever&from=yesterday&to=2026-06-01'),
      INITIAL,
    );
    expect(q.dateWindow).toBe('any');
    expect(q.customRange).toBeNull();
  });
});

describe('W4 fix 2: Show more depth in sessionStorage keyed by the query', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers the depth per query and falls back to the cap elsewhere', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const key = showMoreKey('stage=all&q=beta');
    writeShown(key, 18);
    expect(readShown(key, 6)).toBe(18);
    expect(readShown(showMoreKey('stage=all'), 6)).toBe(6);
  });

  it('a blocked or missing storage never throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => writeShown('k', 12)).not.toThrow();
    expect(readShown('k', 6)).toBe(6);
  });
});

describe('W4 fixes 4 and 6: filter state', () => {
  it('only search or a real date window count as filtered (the stage chip does not)', () => {
    const base = parsePipelineQuery(new URLSearchParams('stage=parked'), INITIAL);
    expect(filtersActive(base)).toBe(false);
    expect(filtersActive({ ...base, search: 'x' })).toBe(true);
    expect(filtersActive({ ...base, dateWindow: 'week' })).toBe(true);
    // 'custom' with no range picked narrows nothing.
    expect(dateFilterActive({ dateWindow: 'custom', customRange: null })).toBe(false);
  });

  it('labels the date chip from the preset or the custom range', () => {
    expect(dateChipLabel({ dateWindow: 'week', customRange: null })).toBe('This week');
    expect(dateChipLabel({ dateWindow: 'month', customRange: null })).toBe('This month');
    expect(
      dateChipLabel({
        dateWindow: 'custom',
        customRange: { start: '2026-06-24', end: '2026-06-27' },
      }),
    ).toBe('24 Jun to 27 Jun');
  });
});
