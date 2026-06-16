import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  dayCells,
  formatDisplay,
  monthGrid,
  parseISO,
  shiftMonth,
  toISO,
} from '@/components/ui/DatePicker';

describe('date helpers', () => {
  it('round-trips an ISO string (0-based month internally)', () => {
    expect(toISO(2026, 5, 16)).toBe('2026-06-16');
    expect(parseISO('2026-06-16')).toEqual({ year: 2026, monthIndex: 5, day: 16 });
  });

  it('rejects a malformed ISO string', () => {
    expect(parseISO('nope')).toBeNull();
    expect(parseISO('2026-13-01')).toBeNull();
    expect(parseISO('2026-06-40')).toBeNull();
  });

  it('shifts months across year boundaries', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 });
  });

  it('builds a leading-padded month grid', () => {
    const lead = new Date(2026, 5, 1).getDay();
    const grid = monthGrid(2026, 5);
    expect(grid.slice(0, lead).every((cell) => cell === null)).toBe(true);
    expect(grid[lead]).toBe(1);
    expect(grid.filter((cell) => cell !== null)).toHaveLength(30);
  });

  it('formats a display label', () => {
    expect(formatDisplay('2026-06-16')).toBe('June 16, 2026');
  });
});

describe('dayCells', () => {
  function gridButtons(cells: ReactElement[]): ReactElement[] {
    return cells.filter((cell) => (cell.props as { role?: string }).role === 'gridcell');
  }

  it('emits an ISO value when a day is picked', () => {
    const onPick = vi.fn();
    const cells = gridButtons(dayCells(2026, 5, '', '', onPick));
    const day16 = cells.find((cell) => (cell.props as { children: number }).children === 16);
    (day16!.props as { onClick: () => void }).onClick();
    expect(onPick).toHaveBeenCalledWith('2026-06-16');
  });

  it('marks the selected day', () => {
    const cells = gridButtons(dayCells(2026, 5, '2026-06-10', '', () => {}));
    const day10 = cells.find((cell) => (cell.props as { children: number }).children === 10);
    expect((day10!.props as { 'aria-selected': boolean })['aria-selected']).toBe(true);
  });
});
