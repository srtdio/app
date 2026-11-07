// @vitest-environment jsdom
// Decision E: the chip row's Select toggles select mode with nothing ticked;
// long-press / right-click still enter through the selection itself.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useListSelection, type ListSelection } from '@/components/ui/SelectBar';
import type { ListCardSelect } from '@/components/ui/ListCard';
import {
  armedSelect,
  selectModeOn,
  useSelectMode,
  type SelectMode,
} from '@/components/pages/pipeline/use-select-mode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('pure helpers', () => {
  it('select mode is on when armed or a card is ticked', () => {
    expect(selectModeOn(false, false)).toBe(false);
    expect(selectModeOn(true, false)).toBe(true);
    expect(selectModeOn(false, true)).toBe(true);
  });

  it('armedSelect turns a card active without touching its other fields', () => {
    const base: ListCardSelect = {
      active: false,
      chosen: false,
      onEnter: () => {},
      onToggle: () => {},
    };
    expect(armedSelect(base, false)).toBe(base);
    const on = armedSelect(base, true);
    expect(on.active).toBe(true);
    expect(on.onToggle).toBe(base.onToggle);
    expect(on.chosen).toBe(false);
  });
});

describe('useSelectMode', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const latest: { selection: ListSelection | null; mode: SelectMode | null } = {
    selection: null,
    mode: null,
  };

  function Harness() {
    const selection = useListSelection();
    const mode = useSelectMode(selection);
    latest.selection = selection;
    latest.mode = mode;
    return null;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Harness />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });

  it('the Select tap enters with nothing ticked; a second tap leaves', () => {
    expect(latest.mode!.on).toBe(false);
    act(() => latest.mode!.toggle());
    expect(latest.mode!.on).toBe(true);
    expect(latest.selection!.count).toBe(0);
    expect(latest.mode!.selectFor('p1').active).toBe(true);
    act(() => latest.mode!.toggle());
    expect(latest.mode!.on).toBe(false);
    expect(latest.mode!.selectFor('p1').active).toBe(false);
  });

  it('while armed a card tap ticks it; unticking the last card leaves select mode', () => {
    act(() => latest.mode!.toggle());
    act(() => latest.mode!.selectFor('p1').onToggle());
    expect(latest.selection!.ids.has('p1')).toBe(true);
    expect(latest.mode!.on).toBe(true);
    act(() => latest.mode!.selectFor('p1').onToggle());
    expect(latest.selection!.count).toBe(0);
    expect(latest.mode!.on).toBe(false);
  });

  it('long-press still enters through the selection; Select then leaves and clears', () => {
    act(() => latest.mode!.selectFor('p2').onEnter());
    expect(latest.mode!.on).toBe(true);
    expect(latest.selection!.ids.has('p2')).toBe(true);
    act(() => latest.mode!.toggle());
    expect(latest.mode!.on).toBe(false);
    expect(latest.selection!.count).toBe(0);
  });

  it('Cancel (clear) leaves an armed, empty select mode; so does Esc', () => {
    act(() => latest.mode!.toggle());
    act(() => latest.mode!.clear());
    expect(latest.mode!.on).toBe(false);
    act(() => latest.mode!.toggle());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(latest.mode!.on).toBe(false);
  });
});
