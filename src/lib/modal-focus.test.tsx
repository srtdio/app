// @vitest-environment jsdom
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  focusableIn,
  initialFocusTarget,
  isTextField,
  modalLayerCount,
  useModalFocus,
} from '@/lib/modal-focus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let setOuterOpen: ((open: boolean) => void) | null = null;
let setInnerOpen: ((open: boolean) => void) | null = null;

function Layer({
  name,
  open,
  initial,
  children,
}: {
  name: string;
  open: boolean;
  initial?: 'last';
  children?: ReactElement | null;
}): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef<HTMLButtonElement>(null);
  useModalFocus(ref, open, initial === 'last' ? { initial: () => lastRef.current } : {});
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      <button type="button" data-first={name}>
        First
      </button>
      <button type="button" data-mid={name}>
        Mid
      </button>
      <button ref={lastRef} type="button" data-last={name}>
        Last
      </button>
      {children}
    </div>
  );
}

function Probe({ initial }: { initial?: 'last' }): ReactElement {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  setOuterOpen = setOuter;
  setInnerOpen = setInner;
  return (
    <Layer name="outer" open={outer} {...(initial !== undefined ? { initial } : {})}>
      <Layer name="inner" open={inner} />
    </Layer>
  );
}

async function mount(initial?: 'last') {
  // The opener lives outside the React tree, so it survives an unmount.
  const opener = document.createElement('button');
  opener.type = 'button';
  opener.setAttribute('data-opener', '');
  opener.textContent = 'Open';
  document.body.appendChild(opener);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Probe {...(initial !== undefined ? { initial } : {})} />);
  });
  opener.focus();
  return { opener };
}

const byAttr = (attr: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[${attr}]`);
  if (el === null) throw new Error(`no ${attr}`);
  return el;
};

async function open(which: 'outer' | 'inner'): Promise<void> {
  await act(async () => {
    (which === 'outer' ? setOuterOpen : setInnerOpen)?.(true);
  });
}

async function close(which: 'outer' | 'inner'): Promise<void> {
  await act(async () => {
    (which === 'outer' ? setOuterOpen : setInnerOpen)?.(false);
  });
}

async function tab(shift = false): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  setOuterOpen = null;
  setInnerOpen = null;
  document.body.innerHTML = '';
});

describe('useModalFocus', () => {
  it('on open, focus moves in: the first control, or the element the layer names', async () => {
    await mount();
    await open('outer');
    expect(document.activeElement).toBe(byAttr('data-first=outer'));
    expect(modalLayerCount()).toBe(1);
    await close('outer');
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    await mount('last');
    await open('outer');
    expect(document.activeElement).toBe(byAttr('data-last=outer'));
  });

  it('Tab wraps inside the layer both ways', async () => {
    await mount();
    await open('outer');
    byAttr('data-last=outer').focus();
    await tab();
    expect(document.activeElement).toBe(byAttr('data-first=outer'));
    await tab(true);
    expect(document.activeElement).toBe(byAttr('data-last=outer'));
    // Mid-list, Tab is left to the browser (not prevented).
    byAttr('data-mid=outer').focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    byAttr('data-mid=outer').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('focus that drifted outside the layer is pulled back in on Tab', async () => {
    const { opener } = await mount();
    await open('outer');
    opener.focus();
    await tab();
    expect(document.activeElement).toBe(byAttr('data-first=outer'));
  });

  it('on close, focus returns to the element focused before the open', async () => {
    const { opener } = await mount();
    await open('outer');
    expect(document.activeElement).not.toBe(opener);
    await close('outer');
    expect(document.activeElement).toBe(opener);
    expect(modalLayerCount()).toBe(0);
  });

  it('on unmount while open, focus still returns (if the opener is in the document)', async () => {
    const { opener } = await mount();
    await open('outer');
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it('nested layers: only the top open layer traps; the one under it takes over again', async () => {
    await mount();
    await open('outer');
    await open('inner');
    expect(modalLayerCount()).toBe(2);
    expect(document.activeElement).toBe(byAttr('data-first=inner'));
    byAttr('data-last=inner').focus();
    await tab();
    expect(document.activeElement).toBe(byAttr('data-first=inner'));
    await close('inner');
    // Back in the outer layer (its first control opened the inner one here).
    expect(byAttr('data-first=outer').contains(document.activeElement)).toBe(true);
    byAttr('data-last=outer').focus();
    await tab();
    expect(document.activeElement).toBe(byAttr('data-first=outer'));
  });
});

describe('initialFocusTarget (touch rule)', () => {
  function panel(): { root: HTMLElement; field: HTMLElement; button: HTMLElement } {
    const root = document.createElement('div');
    root.tabIndex = -1;
    const field = document.createElement('input');
    field.type = 'text';
    const button = document.createElement('button');
    root.appendChild(field);
    root.appendChild(button);
    document.body.appendChild(root);
    return { root, field, button };
  }

  it('on a touch device a text field is never the landing spot; the panel is', () => {
    const { root, field } = panel();
    expect(initialFocusTarget(root, null, false)).toBe(field);
    expect(initialFocusTarget(root, null, true)).toBe(root);
    expect(initialFocusTarget(root, field, true)).toBe(root);
  });

  it('a button is fine on touch; a panel with no controls focuses itself', () => {
    const { root, button } = panel();
    expect(initialFocusTarget(root, button, true)).toBe(button);
    const empty = document.createElement('div');
    expect(initialFocusTarget(empty, null, false)).toBe(empty);
  });

  it('knows which inputs open a keyboard', () => {
    const text = document.createElement('input');
    const check = document.createElement('input');
    check.type = 'checkbox';
    const area = document.createElement('textarea');
    const button = document.createElement('button');
    expect(isTextField(text)).toBe(true);
    expect(isTextField(area)).toBe(true);
    expect(isTextField(check)).toBe(false);
    expect(isTextField(button)).toBe(false);
  });

  it('skips disabled controls and tabindex -1', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<button disabled>x</button><a>no href</a><div tabindex="-1">panel</div><button>ok</button>';
    expect(focusableIn(root).map((el) => el.textContent)).toEqual(['ok']);
  });
});
