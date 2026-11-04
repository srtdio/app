import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  dayCells,
  formatDisplay,
  gridKeyTarget,
  monthGrid,
  parseISO,
  popoverPlacement,
  rovingDay,
  shiftDay,
  shiftMonth,
  toISO,
  weekRows,
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

describe('popoverPlacement', () => {
  const phone = { width: 390, height: 844 };

  it('opens below a trigger with room under it, at least 336px wide (seven 44px days)', () => {
    const at = popoverPlacement({ top: 200, bottom: 244, left: 200, width: 170 }, phone);
    expect(at.top).toBe(250);
    expect(at.width).toBe(336);
    expect(at.left + at.width).toBeLessThanOrEqual(390 - 8);
  });

  it('opens above a trigger near the bottom of the screen', () => {
    const at = popoverPlacement({ top: 700, bottom: 744, left: 16, width: 358 }, phone);
    expect(at.top).toBeUndefined();
    expect(at.bottom).toBe(844 - 700 + 6);
    expect(at.width).toBe(358);
  });
});

describe('calendar grid keyboard and names', () => {
  it('each day is named by its spoken date (time.ts), e.g. 14 November', () => {
    const cells = dayCells(2026, 10, '', '', () => {}).filter(
      (cell) => (cell.props as { role?: string }).role === 'gridcell',
    );
    const day14 = cells.find((cell) => (cell.props as { children: number }).children === 14);
    expect((day14!.props as { 'aria-label': string })['aria-label']).toContain('14 November');
  });

  it('only the roving day takes Tab', () => {
    const cells = dayCells(2026, 10, '', '', () => {}, undefined, '2026-11-14').filter(
      (cell) => (cell.props as { role?: string }).role === 'gridcell',
    );
    const stops = cells.filter((cell) => (cell.props as { tabIndex: number }).tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect((stops[0]!.props as { children: number }).children).toBe(14);
  });

  it('arrow keys move by a day or a week, across months; Home/End to the week ends', () => {
    expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01');
    expect(gridKeyTarget('2026-11-14', 'ArrowRight')).toBe('2026-11-15');
    expect(gridKeyTarget('2026-11-01', 'ArrowLeft')).toBe('2026-10-31');
    expect(gridKeyTarget('2026-11-14', 'ArrowDown')).toBe('2026-11-21');
    expect(gridKeyTarget('2026-11-03', 'ArrowUp')).toBe('2026-10-27');
    // 14 Nov 2026 is a Saturday: the week runs Sunday 8 to Saturday 14.
    expect(gridKeyTarget('2026-11-14', 'Home')).toBe('2026-11-08');
    expect(gridKeyTarget('2026-11-08', 'End')).toBe('2026-11-14');
    expect(gridKeyTarget('2026-11-14', 'Enter')).toBeNull();
  });

  it('the roving day: focus, else selected, else today, else the 1st; never before min', () => {
    expect(rovingDay(2026, 10, '2026-11-20', '2026-11-05', '2026-11-04')).toBe('2026-11-20');
    expect(rovingDay(2026, 10, '', '2026-11-05', '2026-11-04')).toBe('2026-11-05');
    expect(rovingDay(2026, 10, '', '', '2026-11-04')).toBe('2026-11-04');
    expect(rovingDay(2026, 11, '', '', '2026-11-04')).toBe('2026-12-01');
    expect(rovingDay(2026, 10, '', '2026-11-01', '2026-11-04', '2026-11-04')).toBe('2026-11-04');
  });

  it('week rows split the cells by seven', () => {
    const rows = weekRows(monthGrid(2026, 10));
    expect(rows.every((row) => row.length <= 7)).toBe(true);
    expect(rows.flat()).toHaveLength(monthGrid(2026, 10).length);
  });
});
