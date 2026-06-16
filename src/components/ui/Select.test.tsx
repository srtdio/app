import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  computeMenuPlacement,
  selectOptionRows,
  SelectMenu,
  type SelectOption,
} from '@/components/ui/Select';

const options: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
];

function rowProps(row: ReactElement): { onClick: () => void; 'aria-selected': boolean } {
  return row.props as { onClick: () => void; 'aria-selected': boolean };
}

describe('computeMenuPlacement', () => {
  it('opens downward when there is room below the button', () => {
    expect(computeMenuPlacement(100, 800)).toBe('down');
  });

  it('opens upward when the button sits near the viewport bottom', () => {
    expect(computeMenuPlacement(780, 800)).toBe('up');
  });
});

describe('selectOptionRows', () => {
  it('renders one row per option, keyed and ordered by value', () => {
    const rows = selectOptionRows(options, 'a', () => {});
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.key)).toEqual(['a', 'b', 'c']);
  });

  it('ticks only the selected row', () => {
    const rows = selectOptionRows(options, 'b', () => {});
    expect(rows.map((row) => rowProps(row)['aria-selected'])).toEqual([false, true, false]);
  });

  it('fires onPick with the value when a row is clicked', () => {
    const onPick = vi.fn();
    const rows = selectOptionRows(options, 'a', onPick);
    rowProps(rows[2] as ReactElement).onClick();
    expect(onPick).toHaveBeenCalledWith('c');
  });
});

describe('SelectMenu', () => {
  function menu(onChange: () => void = () => {}, onClose: () => void = () => {}): ReactElement {
    return SelectMenu({ options, value: 'a', placement: 'down', onChange, onClose }) as ReactElement;
  }
  function parts(el: ReactElement): { backdrop: ReactElement; panel: ReactElement } {
    const children = (el.props as { children: ReactElement[] }).children;
    return { backdrop: children[0] as ReactElement, panel: children[1] as ReactElement };
  }

  it('closes on an outside (backdrop) click', () => {
    const onClose = vi.fn();
    const { backdrop } = parts(menu(() => {}, onClose));
    (backdrop.props as { onClick: () => void }).onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape but ignores other keys', () => {
    const onClose = vi.fn();
    const { panel } = parts(menu(() => {}, onClose));
    const onKeyDown = (panel.props as { onKeyDown: (e: { key: string }) => void }).onKeyDown;
    onKeyDown({ key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    onKeyDown({ key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('selecting a row emits the value and closes', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const { panel } = parts(menu(onChange, onClose));
    const rows = (panel.props as { children: ReactElement[] }).children;
    rowProps(rows[1] as ReactElement).onClick();
    expect(onChange).toHaveBeenCalledWith('b');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
