// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactElement } from 'react';
import {
  SelectBar,
  selectCountLabel,
  useListSelection,
  visibleSelectActions,
  type ListSelection,
  type SelectBarAction,
} from '@/components/ui/SelectBar';
import { ListCard } from '@/components/ui/ListCard';
import { LONG_PRESS_MS } from '@/components/ui/useLongPress';
import { IconBriefs, IconLink, IconTrash } from '@/components/ui/icons';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {};
const ACTIONS: (SelectBarAction & { single?: boolean })[] = [
  { id: 'open', label: 'Open', icon: IconBriefs, onSelect: noop, single: true },
  { id: 'copy', label: 'Copy link', icon: IconLink, onSelect: noop, single: true },
  { id: 'delete', label: 'Delete', icon: IconTrash, onSelect: noop, tone: 'bad' },
];

describe('SelectBar', () => {
  it('"N selected"', () => {
    expect(selectCountLabel(1)).toBe('1 selected');
    expect(selectCountLabel(3)).toBe('3 selected');
  });

  it('single-item actions show only when exactly one is selected', () => {
    expect(visibleSelectActions(ACTIONS, 1).map((a) => a.id)).toEqual(['open', 'copy', 'delete']);
    expect(visibleSelectActions(ACTIONS, 2).map((a) => a.id)).toEqual(['delete']);
  });

  it('Cancel, the count, then one 44 IconButton per action; Delete in bad ink, last', () => {
    const html = renderToStaticMarkup(
      <SelectBar count={2} onCancel={noop} actions={ACTIONS} label="Selected posts" />,
    );
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Selected posts"');
    expect(html).toMatch(/data-select-bar-cancel=""[^>]*>Cancel</);
    expect(html).toMatch(/data-select-bar-count=""[^>]*>2 selected</);
    const ids = [...html.matchAll(/data-select-bar-action="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['open', 'copy', 'delete']);
    expect(html).toMatch(/aria-label="Delete"[^>]*class="[^"]*text-bad/);
    expect(html).toContain('lit-dock');
    expect(html).not.toMatch(/shadow-|dark:|#[0-9a-f]{3,6}\b/);
  });

  it('phone: the bar wraps, the count is never cut, the actions are one trailing group; from 768 one line', () => {
    const html = renderToStaticMarkup(
      <SelectBar count={1} onCancel={noop} actions={ACTIONS} label="Selected posts" />,
    );
    expect(html).toMatch(/data-select-bar=""[^>]*class="[^"]*max-md:flex-wrap/);
    expect(html).toMatch(/class="(?:[^"]* )?shrink-0[ "][^>]*data-select-bar-cancel=""/);
    expect(html).toMatch(/data-select-bar-count=""[^>]*class="[^"]*max-md:min-w-max/);
    // The group is no box from 768 (contents), so the laptop bar is unchanged.
    expect(html).toMatch(
      /data-select-bar-actions=""[^>]*class="[^"]*max-md:ml-auto max-md:flex-wrap md:contents/,
    );
    const group = html.slice(html.indexOf('data-select-bar-actions'));
    expect([...group.matchAll(/data-select-bar-action="/g)]).toHaveLength(3);
  });
});

describe('useListSelection + ListCard select', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
  });

  function mount(onOpen: () => void): { current: ListSelection | null } {
    const ref: { current: ListSelection | null } = { current: null };
    function List(): ReactElement {
      const selection = useListSelection();
      ref.current = selection;
      return (
        <div>
          {['a', 'b'].map((id) => (
            <ListCard
              key={id}
              data-card={id}
              picture={{ kind: 'icon', icon: IconBriefs }}
              title={id}
              onPress={onOpen}
              select={selection.selectFor(id)}
            />
          ))}
        </div>
      );
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<List />));
    return ref;
  }

  const card = (id: string): HTMLElement =>
    host?.querySelector<HTMLElement>(`[data-card="${id}"]`) as HTMLElement;
  const press = (id: string): HTMLButtonElement =>
    card(id).querySelector<HTMLButtonElement>('[data-list-card-press]') as HTMLButtonElement;

  it('right-click enters select mode with that card ticked; a tap then toggles, never opens', () => {
    const onOpen = vi.fn();
    const sel = mount(onOpen);
    act(() => {
      card('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect([...(sel.current?.ids ?? [])]).toEqual(['a']);
    expect(card('a').querySelector('[data-list-card-tick="on"]')).not.toBeNull();
    expect(card('b').querySelector('[data-list-card-tick="off"]')).not.toBeNull();
    act(() => press('b').click());
    expect([...(sel.current?.ids ?? [])].sort()).toEqual(['a', 'b']);
    expect(onOpen).not.toHaveBeenCalled();
    // Unticking the last card leaves select mode.
    act(() => press('a').click());
    act(() => press('b').click());
    expect(sel.current?.active).toBe(false);
    act(() => press('a').click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('Shift-click and Cmd-click enter and toggle; a plain click opens', () => {
    const onOpen = vi.fn();
    const sel = mount(onOpen);
    act(() => {
      press('a').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(sel.current?.count).toBe(1);
    act(() => {
      press('b').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    });
    expect(sel.current?.count).toBe(2);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Esc leaves select mode', () => {
    const sel = mount(noop);
    act(() => sel.current?.enter('a'));
    expect(sel.current?.active).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(sel.current?.active).toBe(false);
  });

  it('a touch hold enters; a move (scroll) before the hold cancels it', () => {
    vi.useFakeTimers();
    const sel = mount(noop);
    const down = (x: number, y: number): PointerEvent =>
      Object.assign(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }), {
        pointerType: 'touch',
      }) as unknown as PointerEvent;
    const move = (x: number, y: number): PointerEvent =>
      Object.assign(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }), {
        pointerType: 'touch',
      }) as unknown as PointerEvent;
    act(() => {
      card('a').dispatchEvent(down(10, 10));
      card('a').dispatchEvent(move(10, 40));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(sel.current?.active).toBe(false);
    act(() => {
      card('b').dispatchEvent(down(10, 10));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect([...(sel.current?.ids ?? [])]).toEqual(['b']);
  });
});
