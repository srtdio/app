// @vitest-environment jsdom
// A press on the compact + (in a writing box) and on the recording row's keys
// must not move focus: focusing them reshapes the box (pill to card) between
// press and release, so the click would land off the button. Each key calls
// preventDefault on pointerdown and still fires its click.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerTray } from '@/components/chat/ComposerTray';
import { RecordingRow } from '@/components/chat/VoiceDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

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

/** Dispatch a cancelable pointerdown on `el`; true when preventDefault was called. */
function pressPrevented(el: Element): boolean {
  const Pointer = (window.PointerEvent ?? window.MouseEvent) as typeof MouseEvent;
  const event = new Pointer('pointerdown', { bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function button(label: string): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (el === null) throw new Error(`missing ${label}`);
  return el;
}

describe('keys that keep focus where it is', () => {
  it('the compact + prevents the pointerdown and still opens on click', () => {
    act(() => root?.render(<ComposerTray compact layout="touch" onPick={() => undefined} />));
    const plus = button('Add attachment');
    expect(pressPrevented(plus)).toBe(true);
    act(() => plus.click());
    expect(button('Close attachments').getAttribute('aria-expanded')).toBe('true');
  });

  it('the + outside a writing box leaves the pointerdown alone', () => {
    act(() => root?.render(<ComposerTray layout="touch" onPick={() => undefined} />));
    expect(pressPrevented(button('Add attachment'))).toBe(false);
  });

  it('the recording row keys prevent the pointerdown and still fire their clicks', () => {
    const onCancel = vi.fn();
    const onKeep = vi.fn();
    act(() =>
      root?.render(<RecordingRow elapsed="0:03" bars={4} onCancel={onCancel} onKeep={onKeep} />),
    );
    const cancel = button('Cancel recording');
    const keep = button('Stop and keep voice note');
    expect(pressPrevented(cancel)).toBe(true);
    expect(pressPrevented(keep)).toBe(true);
    act(() => cancel.click());
    act(() => keep.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledTimes(1);
  });
});
