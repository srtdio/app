// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isPaletteShortcut, isTextEntry, usesCmdKey } from '@/lib/search/palette-keys';

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('search shortcut', () => {
  it('Cmd+K on Apple platforms, Ctrl+K elsewhere', () => {
    expect(usesCmdKey('MacIntel')).toBe(true);
    expect(usesCmdKey('iPhone')).toBe(true);
    expect(usesCmdKey('Win32')).toBe(false);
    expect(usesCmdKey('Linux x86_64')).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: 'K' }), false)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('never with Alt or Shift, or another key', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: 'j' }), false)).toBe(false);
  });

  it('is ignored while typing in another text field', () => {
    const text = document.createElement('input');
    const area = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(editable)).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(document.body)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
