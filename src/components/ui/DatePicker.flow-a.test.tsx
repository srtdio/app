// @vitest-environment jsdom
// Post flow A fix 20: 44px day cells, past days greyed and unpickable, and the
// "Clear date" / "Done" actions.
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatePicker, dayCells } from '@/components/ui/DatePicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CellProps = {
  role?: string;
  children: number;
  className: string;
  disabled?: boolean;
  onClick: () => void;
};

function gridButtons(cells: ReactElement[]): ReactElement<CellProps>[] {
  return cells.filter(
    (cell) => (cell.props as { role?: string }).role === 'gridcell',
  ) as ReactElement<CellProps>[];
}

function day(cells: ReactElement<CellProps>[], n: number): ReactElement<CellProps> {
  const found = cells.find((cell) => cell.props.children === n);
  if (found === undefined) throw new Error(`no day ${n}`);
  return found;
}

describe('dayCells (flow A)', () => {
  it('fix 20: day cells are 44x44 and days before minISO are disabled and never picked', () => {
    const onPick = vi.fn();
    const cells = gridButtons(dayCells(2026, 5, '', '2026-06-10', onPick, '2026-06-10'));
    for (const cell of cells) {
      expect(cell.props.className).toContain('h-11');
      expect(cell.props.className).toContain('w-11');
    }
    const past = day(cells, 9);
    expect(past.props.disabled).toBe(true);
    past.props.onClick();
    expect(onPick).not.toHaveBeenCalled();

    const today = day(cells, 10);
    expect(today.props.disabled).toBe(false);
    today.props.onClick();
    expect(onPick).toHaveBeenCalledWith('2026-06-10');
  });

  it('fix 20: without minISO no day is disabled', () => {
    const cells = gridButtons(dayCells(2026, 5, '', '', () => {}));
    expect(cells.every((cell) => cell.props.disabled === false)).toBe(true);
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  );
}

describe('DatePicker actions (flow A)', () => {
  it('fix 20: "Clear date" empties the value and "Done" closes', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root!.render(<DatePicker label="Due date" value="2026-06-16" onChange={onChange} actions />);
    });
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Due date"]')!;
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => buttonByText('Clear date')!.click());
    expect(onChange).toHaveBeenCalledWith('');

    await act(async () => trigger.click());
    expect(buttonByText('Done')).toBeDefined();
    await act(async () => buttonByText('Done')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('fix 20: no actions row unless asked', async () => {
    await act(async () => {
      root!.render(<DatePicker label="Due date" value="2026-06-16" onChange={() => {}} />);
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Due date"]')!.click(),
    );
    expect(buttonByText('Clear date')).toBeUndefined();
    expect(buttonByText('Done')).toBeUndefined();
  });
});
