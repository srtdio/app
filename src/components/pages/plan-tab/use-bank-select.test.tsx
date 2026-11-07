// @vitest-environment jsdom
// The Bank's select mode (useBankSelect): the chip row's Select starts it with
// nothing ticked, a card tap then ticks; a second Select tap, Cancel (clear)
// or a finished action (leaveThen) leaves; a long-press still enters with the
// card ticked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBankSelect, type BankSelection } from './use-bank-select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let current: BankSelection | null = null;

function Probe(): null {
  current = useBankSelect();
  return null;
}

function sel(): BankSelection {
  if (current === null) throw new Error('not rendered');
  return current;
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  current = null;
});

describe('useBankSelect', () => {
  it('Select starts select mode with nothing ticked; a card tap ticks it', () => {
    expect(sel().active).toBe(false);
    act(() => sel().toggleMode());
    expect(sel().active).toBe(true);
    expect(sel().count).toBe(0);
    expect(sel().selectFor('a').active).toBe(true);
    act(() => sel().selectFor('a').onToggle());
    expect(sel().count).toBe(1);
    expect(sel().selectFor('a').chosen).toBe(true);
  });

  it('a second Select tap leaves, ticks and all', () => {
    act(() => sel().toggleMode());
    act(() => sel().selectFor('a').onToggle());
    act(() => sel().toggleMode());
    expect(sel().active).toBe(false);
    expect(sel().count).toBe(0);
  });

  it('unticking the last card keeps a Select-started mode on (the bar reads 0 selected)', () => {
    act(() => sel().toggleMode());
    act(() => sel().selectFor('a').onToggle());
    act(() => sel().selectFor('a').onToggle());
    expect(sel().active).toBe(true);
    expect(sel().count).toBe(0);
  });

  it('a long-press still enters with the card ticked; clear and leaveThen leave', () => {
    act(() => sel().selectFor('b').onEnter());
    expect(sel().active).toBe(true);
    expect(sel().count).toBe(1);
    act(() => sel().clear());
    expect(sel().active).toBe(false);
    act(() => sel().toggleMode());
    const then = vi.fn();
    act(() => sel().leaveThen(then));
    expect(then).toHaveBeenCalledTimes(1);
    expect(sel().active).toBe(false);
  });
});
