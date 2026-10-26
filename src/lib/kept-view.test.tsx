// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { keptOr, keptViewKey, useKeptScroll, useKeptState, useUntouched } from '@/lib/kept-view';
import { dropWorkspaceReads, peekKept, resetSessionReads } from '@/lib/session-read';
import { SIGNOUT_EVENT } from '@/lib/events';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetSessionReads();
});

function mount(node: ReactNode): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe('keptViewKey', () => {
  it('starts with the user and workspace', () => {
    expect(keptViewKey('u', 'w', 'assets:tab')).toBe('u:w:view:assets:tab');
  });

  it('keptOr falls back without a key or a kept value', () => {
    expect(keptOr(null, 'all')).toBe('all');
    expect(keptOr(keptViewKey('u', 'w', 'x'), 'all')).toBe('all');
  });
});

describe('useKeptState', () => {
  let setChip: (next: string) => void = () => {};
  let shown = '';

  function Chips({ id }: { id: string | null }) {
    const [chip, set] = useKeptState(id, 'all');
    setChip = set;
    shown = chip;
    return null;
  }

  it('restores the chip on remount and clears on signout', () => {
    const key = keptViewKey('u', 'w', 'briefs:chip');
    mount(<Chips id={key} />);
    expect(shown).toBe('all');
    act(() => setChip('open'));
    act(() => root!.unmount());
    mount(<Chips id={key} />);
    expect(shown).toBe('open');
    act(() => root!.unmount());
    window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    mount(<Chips id={key} />);
    expect(shown).toBe('all');
  });

  it('is deleted with the workspace', () => {
    const key = keptViewKey('u', 'w', 'briefs:chip');
    mount(<Chips id={key} />);
    act(() => setChip('open'));
    dropWorkspaceReads('u', 'w');
    expect(peekKept(key)).toBeUndefined();
  });
});

describe('useUntouched', () => {
  let untouched: () => boolean = () => true;

  function Screen() {
    untouched = useUntouched();
    return null;
  }

  it('applies an early result and holds one that lands after a touch', () => {
    mount(<Screen />);
    expect(untouched()).toBe(true);
    window.dispatchEvent(new Event('pointerdown'));
    expect(untouched()).toBe(false);
  });

  it('a scroll by wheel or a key press counts as touched', () => {
    mount(<Screen />);
    window.dispatchEvent(new Event('wheel'));
    expect(untouched()).toBe(false);
    act(() => root!.unmount());
    mount(<Screen />);
    expect(untouched()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(untouched()).toBe(false);
  });
});

describe('useKeptScroll', () => {
  function Screen({ ready, el }: { ready: boolean; el: HTMLElement }) {
    useKeptScroll(keptViewKey('u', 'w', 'assets:scroll'), ready, () => el);
    return null;
  }

  it('keeps the position and puts it back once the rows are ready', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    document.body.appendChild(el);
    mount(<Screen ready el={el} />);
    el.scrollTop = 420;
    el.dispatchEvent(new Event('scroll'));
    act(() => root!.unmount());
    el.scrollTop = 0;
    mount(<Screen ready={false} el={el} />);
    expect(el.scrollTop).toBe(0);
    act(() => root!.render(<Screen ready el={el} />));
    expect(el.scrollTop).toBe(420);
  });
});
