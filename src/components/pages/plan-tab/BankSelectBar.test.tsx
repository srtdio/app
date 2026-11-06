// @vitest-environment jsdom
// The Bank's select bar: Cancel, "{n} selected", All / None, Archive and
// Delete (both off with nothing picked).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankSelectBar } from './BankSelectBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const calls = {
  onCancel: vi.fn(),
  onAll: vi.fn(),
  onNone: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
};

function render(count: number): void {
  act(() => root.render(<BankSelectBar count={count} {...calls} />));
}

const q = (sel: string): HTMLButtonElement => {
  const el = host.querySelector<HTMLButtonElement>(sel);
  if (el === null) throw new Error(sel);
  return el;
};

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
  for (const fn of Object.values(calls)) fn.mockClear();
});
afterEach(() => act(() => root.unmount()));

describe('BankSelectBar', () => {
  it('counts the picked ideas and wires every control', () => {
    render(3);
    expect(q('[data-bank-select-count]').textContent).toBe('3 selected');
    act(() => q('[data-bank-select-cancel]').click());
    act(() => q('[data-bank-select-all]').click());
    act(() => q('[data-bank-select-none]').click());
    act(() => q('[data-bank-select-archive]').click());
    act(() => q('[data-bank-select-delete]').click());
    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    expect(calls.onAll).toHaveBeenCalledTimes(1);
    expect(calls.onNone).toHaveBeenCalledTimes(1);
    expect(calls.onArchive).toHaveBeenCalledTimes(1);
    expect(calls.onDelete).toHaveBeenCalledTimes(1);
  });

  it('turns Archive and Delete off with nothing picked', () => {
    render(0);
    expect(q('[data-bank-select-archive]').disabled).toBe(true);
    expect(q('[data-bank-select-delete]').disabled).toBe(true);
  });

  it('names Delete in bad ink and both as icon buttons with labels', () => {
    render(1);
    expect(q('[data-bank-select-delete]').className).toContain('text-bad');
    expect(q('[data-bank-select-delete]').getAttribute('aria-label')).toBe('Delete');
    expect(q('[data-bank-select-archive]').getAttribute('aria-label')).toBe('Archive');
  });
});
