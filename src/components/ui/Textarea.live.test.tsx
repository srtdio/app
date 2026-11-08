// @vitest-environment jsdom
// ui/Textarea with formatting: WYSIWYG. The value in and out stays the saved
// marker text; the box holds paired markers as hidden zero-width code points
// (same offsets), so no star ever shows while typing; the mirror draws the
// styles, combined; a format key with no selection holds the style for the
// next typed word.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Textarea } from '@/components/ui/Textarea';
import { activeActions, applyAction } from '@/components/ui/format-actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const seen: { value: string } = { value: '' };

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Live(props: { initial: string }): ReactElement {
  const [value, setValue] = useState(props.initial);
  seen.value = value;
  return (
    <Textarea
      formatting
      aria-label="Body"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

function mount(initial: string): HTMLTextAreaElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Live initial={initial} />));
  const area = host.querySelector('textarea');
  if (area === null) throw new Error('no textarea');
  return area;
}

const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
/** What the box itself holds (hidden markers included). */
const held = (area: HTMLTextAreaElement): string => String(proto?.get?.call(area) ?? '');

/** The browser typing: the box's own text changes, the caret at the end, an input event. */
function typeRaw(area: HTMLTextAreaElement, next: string, caret = next.length): void {
  act(() => {
    proto?.set?.call(area, next);
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const mirror = (): HTMLElement | null => document.querySelector('[data-format-mirror]');

describe('Textarea WYSIWYG: markers never show', () => {
  it('a saved value shows styled with no star; el.value is still the saved text', () => {
    const area = mount('ship *today*');
    expect(area.value).toBe('ship *today*');
    expect(held(area)).not.toContain('*');
    expect(held(area)).toHaveLength('ship *today*'.length);
    expect(mirror()?.textContent).not.toContain('*');
    const styled = mirror()?.querySelector('span');
    expect(styled?.textContent).toBe('today');
    expect(styled?.className).toContain('[-webkit-text-stroke:0.035em_currentColor]');
  });

  it('typing the closing star hides both stars; the caller gets the saved text', () => {
    const area = mount('');
    typeRaw(area, 'ship *today');
    // An open star is a plain, visible character until it pairs.
    expect(held(area)).toBe('ship *today');
    typeRaw(area, 'ship *today*');
    expect(seen.value).toBe('ship *today*');
    expect(area.value).toBe('ship *today*');
    expect(held(area)).not.toContain('*');
    expect(mirror()?.textContent).not.toContain('*');
    // The caret did not move.
    expect(area.selectionStart).toBe(12);
  });

  it('a letter typed right after a bold word stays bold (the pair holds)', () => {
    const area = mount('*hello*');
    typeRaw(area, `${held(area)}x`);
    expect(seen.value).toBe('*hellox*');
    expect(mirror()?.querySelector('span')?.textContent).toBe('hellox');
  });

  it('combined styles: bold, italic, underline and strike on one word', () => {
    mount('*_+~all~+_* rest');
    const span = mirror()?.querySelector('span');
    expect(span?.textContent).toBe('all');
    const cls = span?.className ?? '';
    expect(cls).toContain('[-webkit-text-stroke:0.035em_currentColor]');
    expect(cls).toContain('italic');
    expect(cls).toContain('[text-decoration-line:underline_line-through]');
    expect(mirror()?.textContent).not.toMatch(/[*_+~]/);
  });

  it('Bold on a selection wraps it in markers that stay hidden', () => {
    const area = mount('ship today');
    act(() => {
      area.focus();
      area.setSelectionRange(5, 10);
    });
    act(() => {
      applyAction(area, 'bold');
    });
    expect(seen.value).toBe('ship *today*');
    expect(held(area)).not.toContain('*');
    // The selection stays on the same word.
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 11]);
    expect(activeActions(area).has('bold')).toBe(true);
  });

  it('Bold with no selection holds the style for the next typed word (no empty stars)', () => {
    const area = mount('go ');
    act(() => {
      area.focus();
      area.setSelectionRange(3, 3);
    });
    act(() => {
      applyAction(area, 'bold');
    });
    // Nothing typed yet: no stars went in, the key reads on.
    expect(seen.value).toBe('go ');
    expect(activeActions(area).has('bold')).toBe(true);
    typeRaw(area, `${held(area)}n`);
    expect(seen.value).toBe('go *n*');
    expect(held(area)).not.toContain('*');
  });
});
