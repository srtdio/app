// @vitest-environment jsdom
// Formatting actions (ui/WritingBox rows and shortcuts): inline toggles wrap
// and unwrap through execCommand('insertText') (native Undo) with the
// selection kept; lists and quotes toggle line prefixes; Return continues them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeActions,
  applyAction,
  applyBlock,
  applyContinue,
  applyToTextarea,
  shortcutAction,
  shortcutStyle,
} from '@/components/ui/format-actions';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function textarea(value: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  el.focus();
  return el;
}

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

describe('shortcutAction', () => {
  const k = (key: string, shift = false, code?: string) =>
    shortcutAction({
      key,
      ...(code !== undefined ? { code } : {}),
      metaKey: true,
      ctrlKey: false,
      shiftKey: shift,
      altKey: false,
    });

  it('Shift+7 / 8 / 9 lists and quote, by key or physical code', () => {
    expect(k('7', true)).toBe('ol');
    expect(k('&', true, 'Digit7')).toBe('ol');
    expect(k('*', true, 'Digit8')).toBe('ul');
    expect(k('(', true, 'Digit9')).toBe('quote');
  });

  it('Cmd/Ctrl+K link', () => {
    expect(k('k')).toBe('link');
  });
});

describe('applyBlock', () => {
  it('toggles a numbered prefix on the caret line and back', () => {
    const el = textarea('a\nb');
    el.setSelectionRange(3, 3);
    applyBlock(el, 'ol');
    expect(el.value).toBe('a\n1. b');
    applyBlock(el, 'ol');
    expect(el.value).toBe('a\nb');
  });

  it('bullets every selected line', () => {
    const el = textarea('x\ny');
    el.setSelectionRange(0, 3);
    applyBlock(el, 'ul');
    expect(el.value).toBe('- x\n- y');
  });
});

describe('applyContinue', () => {
  it('Return continues a list, and an empty item ends it', () => {
    const el = textarea('1. a');
    el.setSelectionRange(4, 4);
    expect(applyContinue(el)).toBe(true);
    expect(el.value).toBe('1. a\n2. ');
    expect(applyContinue(el)).toBe(true);
    expect(el.value).toBe('1. a\n');
  });

  it('a plain line is left to the default newline', () => {
    const el = textarea('hello');
    el.setSelectionRange(5, 5);
    expect(applyContinue(el)).toBe(false);
  });
});

describe('applyAction / activeActions', () => {
  it('Bold with no selection puts the marker pair at the caret', () => {
    const el = textarea('hi ');
    el.setSelectionRange(3, 3);
    applyAction(el, 'bold');
    expect(el.value).toBe('hi **');
    expect(el.selectionStart).toBe(4);
  });

  it('reports the styles and the line kind at the caret', () => {
    const el = textarea('- *bold*');
    el.setSelectionRange(5, 5);
    const on = activeActions(el);
    expect(on.has('bold')).toBe(true);
    expect(on.has('ul')).toBe(true);
  });
});
