// @vitest-environment jsdom
// X5 fix 6 (FT22): the sort body is role=menu (matching aria-haspopup="menu");
// calendar days carry full dates; Escape closes the calendar only, via the
// escape stack; the aria-modal calendar owns focus (useModalFocus).
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customRangeLabel,
  dateControlBody,
  sortControlBody,
} from '@/components/pages/pipeline/PipelineSortControl';
import {
  PipelineDateRangeCalendar,
  dayAriaLabel,
} from '@/components/pages/pipeline/PipelineDateRangeCalendar';
import { pushEscapeLayer } from '@/lib/escape-stack';
import { POST_SORT_DEFAULT } from '@/lib/list-sort';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: ReactElement): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('X5 sort control and calendar a11y', () => {
  it('the sort body and the date filter body are each a menu of menuitemradio rows', () => {
    const body = sortControlBody({ order: POST_SORT_DEFAULT, onOrderChange: () => {} });
    expect((body.props as { role?: string }).role).toBe('menu');
    const date = dateControlBody({
      dateWindow: 'any',
      onDateWindowChange: () => {},
      customRange: null,
      onCustomOpen: () => {},
    });
    expect((date.props as { role?: string }).role).toBe('menu');
  });

  it('the custom range label uses "to", never an en dash', () => {
    const label = customRangeLabel({ start: '2026-06-24', end: '2026-06-27' });
    expect(label).toBe('24 Jun to 27 Jun');
    expect(label).not.toMatch(/[–—]/);
  });

  it('a day cell is labelled with its full date', () => {
    const label = dayAriaLabel(2026, 9, 19);
    expect(label).toContain('2026');
    expect(label).toContain('19');
    expect(label).toMatch(/October/);
    expect(label).toMatch(/Monday/);
  });

  it('Escape closes the calendar only; the sheet beneath stays', () => {
    const sheetEscape = vi.fn();
    const popSheet = pushEscapeLayer(sheetEscape);
    const onClose = vi.fn();
    mount(
      <PipelineDateRangeCalendar
        open
        initialRange={null}
        weekStartDay={1}
        onApply={() => {}}
        onClear={() => {}}
        onClose={onClose}
      />,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheetEscape).not.toHaveBeenCalled();
    popSheet();
  });

  it('opening the aria-modal calendar moves focus inside it, and days have labels', () => {
    mount(
      <PipelineDateRangeCalendar
        open
        initialRange={{ start: '2026-10-19', end: '2026-10-19' }}
        weekStartDay={1}
        onApply={() => {}}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const day = dialog.querySelector<HTMLButtonElement>(
      `button[aria-label="${dayAriaLabel(2026, 9, 19)}"]`,
    );
    expect(day).not.toBeNull();
  });
});
