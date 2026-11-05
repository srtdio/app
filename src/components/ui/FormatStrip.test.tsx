// @vitest-environment jsdom
// The format strip: toggle wraps, a second tap unwraps, the text goes through
// execCommand('insertText') (native Undo), the selection stays on the words,
// and pressing a button never takes focus from the box.
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyToTextarea,
  FormatStrip,
  shortcutStyle,
  STRIP_BUTTONS,
} from '@/components/ui/FormatStrip';
import { Textarea } from '@/components/ui/Textarea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

function textarea(value: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  el.focus();
  return el;
}

describe('STRIP_BUTTONS', () => {
  it('four buttons, labels exactly Bold Italic Strike Underline, no mono', () => {
    expect(STRIP_BUTTONS.map((b) => b.label)).toEqual(['Bold', 'Italic', 'Strike', 'Underline']);
    expect(STRIP_BUTTONS.map((b) => b.style)).not.toContain('mono');
  });

  it('each label is drawn in its own style', () => {
    expect(STRIP_BUTTONS.map((b) => b.className)).toEqual([
      'font-semibold',
      'italic',
      'line-through',
      'underline',
    ]);
  });
});

describe('shortcutStyle', () => {
  const k = (key: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) =>
    shortcutStyle({
      key,
      metaKey: mods.meta === true,
      ctrlKey: mods.ctrl === true,
      shiftKey: mods.shift === true,
      altKey: mods.alt === true,
    });

  it('Cmd/Ctrl+B I U, Cmd/Ctrl+Shift+X strike, +Shift+C mono', () => {
    expect(k('b', { meta: true })).toBe('bold');
    expect(k('i', { ctrl: true })).toBe('italic');
    expect(k('u', { meta: true })).toBe('underline');
    expect(k('X', { meta: true, shift: true })).toBe('strike');
    expect(k('C', { ctrl: true, shift: true })).toBe('mono');
  });

  it('nothing without the modifier, or with Alt', () => {
    expect(k('b')).toBeNull();
    expect(k('b', { meta: true, alt: true })).toBeNull();
    expect(k('c', { meta: true })).toBeNull();
  });
});

describe('applyToTextarea', () => {
  it('wraps the selection and keeps it on the same words', () => {
    const el = textarea('ship today');
    el.setSelectionRange(5, 10);
    applyToTextarea(el, 'bold');
    expect(el.value).toBe('ship *today*');
    expect([el.selectionStart, el.selectionEnd]).toEqual([6, 11]);
  });

  it('a second tap on wrapped words unwraps them', () => {
    const el = textarea('ship today');
    el.setSelectionRange(5, 10);
    applyToTextarea(el, 'italic');
    applyToTextarea(el, 'italic');
    expect(el.value).toBe('ship today');
    expect([el.selectionStart, el.selectionEnd]).toEqual([5, 10]);
  });

  it('goes through execCommand insertText so native Undo works', () => {
    const el = textarea('ship today');
    el.setSelectionRange(5, 10);
    const doc = document as unknown as { execCommand: unknown };
    const original = doc.execCommand;
    const exec = vi.fn(() => true);
    doc.execCommand = exec;
    try {
      applyToTextarea(el, 'strike');
      expect(exec).toHaveBeenCalledWith('insertText', false, '~today~');
    } finally {
      doc.execCommand = original;
    }
  });

  it('does nothing with no selection', () => {
    const el = textarea('ship today');
    el.setSelectionRange(3, 3);
    expect(applyToTextarea(el, 'bold')).toBe(false);
    expect(el.value).toBe('ship today');
  });
});

describe('FormatStrip', () => {
  function Harness(): ReactElement {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [v, setV] = useState('ship today');
    return (
      <>
        <textarea ref={ref} value={v} onChange={(e) => setV(e.target.value)} />
        <FormatStrip field={ref} open />
      </>
    );
  }

  it('renders the four buttons in a toolbar', () => {
    mount(<Harness />);
    const strip = document.querySelector('[data-format-strip]');
    expect(strip?.getAttribute('role')).toBe('toolbar');
    expect(Array.from(strip?.querySelectorAll('button') ?? []).map((b) => b.textContent)).toEqual([
      'Bold',
      'Italic',
      'Strike',
      'Underline',
    ]);
  });

  it('pointerdown on a button is prevented: the box keeps focus', () => {
    mount(<Harness />);
    const box = document.querySelector('textarea');
    box?.focus();
    const button = document.querySelector('[data-format="bold"]');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    button?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(box);
  });

  it('tapping Bold wraps the selected words', () => {
    mount(<Harness />);
    const box = document.querySelector('textarea') as HTMLTextAreaElement;
    box.focus();
    box.setSelectionRange(5, 10);
    act(() => {
      (document.querySelector('[data-format="bold"]') as HTMLButtonElement).click();
    });
    expect(box.value).toBe('ship *today*');
  });

  it('closed: renders nothing', () => {
    function Closed(): ReactElement {
      const ref = useRef<HTMLTextAreaElement | null>(null);
      return (
        <>
          <textarea ref={ref} />
          <FormatStrip field={ref} open={false} />
        </>
      );
    }
    mount(<Closed />);
    expect(document.querySelector('[data-format-strip]')).toBeNull();
  });
});

describe('Textarea formatting', () => {
  it('off by default: no wrapper, no mirror, no strip (exactly as before)', () => {
    mount(<Textarea value="*a*" onChange={() => {}} />);
    expect(document.querySelector('[data-format-mirror]')).toBeNull();
    expect(document.querySelector('textarea')?.parentElement?.className ?? '').not.toContain(
      'relative',
    );
  });

  it('on: a hidden mirror styles the words and fades the markers', () => {
    mount(<Textarea formatting value="say *hi*" onChange={() => {}} />);
    const mirror = document.querySelector('[data-format-mirror]');
    expect(mirror?.getAttribute('aria-hidden')).toBe('true');
    const spans = Array.from(mirror?.querySelectorAll('span') ?? []);
    expect(spans.map((s) => s.textContent)).toEqual(['*', 'hi', '*']);
    expect(spans[0]?.className).toContain('text-fg-3');
    expect(spans[1]?.className).toContain('-webkit-text-stroke');
    // The box keeps the caret; its own glyphs are transparent.
    expect(document.querySelector('textarea')?.className).toContain('caret-fg');
  });

  it('on: Cmd+B wraps the selection', () => {
    function Box(): ReactElement {
      const [v, setV] = useState('ship today');
      return <Textarea formatting value={v} onChange={(e) => setV(e.target.value)} />;
    }
    mount(<Box />);
    const box = document.querySelector('textarea') as HTMLTextAreaElement;
    box.focus();
    box.setSelectionRange(5, 10);
    act(() => {
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(box.value).toBe('ship *today*');
  });
});
