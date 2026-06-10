import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { sortOptionButtons, type SortOption } from '@/components/ui/SortMenu';

type Value = 'recent' | 'name' | 'size';

const options: SortOption<Value>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
];

// element.props is host-typed; these helpers read the bits the menu sets without
// needing a DOM (the row is a <button> React element, not a rendered node).
function props(row: ReactElement): { onClick: (e?: unknown) => void; 'aria-checked': boolean } {
  return row.props as { onClick: (e?: unknown) => void; 'aria-checked': boolean };
}

describe('sortOptionButtons', () => {
  it('renders one option per choice, keyed by value', () => {
    const rows = sortOptionButtons(options, 'recent', () => {});
    expect(rows).toHaveLength(options.length);
    expect(rows.map((row) => row.key)).toEqual(['recent', 'name', 'size']);
  });

  it('marks only the active option with aria-checked', () => {
    const rows = sortOptionButtons(options, 'name', () => {});
    expect(rows.map((row) => props(row)['aria-checked'])).toEqual([false, true, false]);
  });

  it('fires onChange with the picked value when an option is clicked', () => {
    const onPick = vi.fn();
    const rows = sortOptionButtons(options, 'recent', onPick);
    props(rows[2] as ReactElement).onClick();
    expect(onPick).toHaveBeenCalledWith('size');
  });
});
