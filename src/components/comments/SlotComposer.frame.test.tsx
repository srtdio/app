// @vitest-environment jsdom
// The checkpoint composer on ui/WritingBox (comment mode): each slot is one
// box. The number and the field sit on the text line; at rest the round Send
// (RowSend) sits beside them; focused or holding text, the row under the text:
// + , Aa, emoji ... Send (no @: checkpoints carry no mentions; no mic). A later
// slot holds its remove bin in the send slot; sending keeps every box (the
// spinner sits in the send).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

import { SlotComposer } from '@/components/comments/SlotComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
}

function boxes(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('[data-writing-box]') ?? []);
}

/** A box's row controls in order: each button's name ('send:<name>' for RowSend). */
function rowOrder(box: HTMLElement): string[] {
  const row = box.querySelector('[data-writing-row]');
  if (row === null) return [];
  return Array.from(row.querySelectorAll<HTMLButtonElement>('button')).map((b) =>
    b.hasAttribute('data-row-send')
      ? `send:${b.getAttribute('aria-label') ?? ''}`
      : (b.getAttribute('aria-label') ?? ''),
  );
}

function focusIn(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

function type(area: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SlotComposer on ui/WritingBox', () => {
  it('renders one WritingBox per slot in comment mode', () => {
    act(() =>
      root?.render(<SlotComposer onSubmit={async () => ({ ok: true })} canAttach={false} />),
    );
    act(() => button('+ Another')?.click());
    expect(boxes()).toHaveLength(2);
    for (const box of boxes()) expect(box.getAttribute('data-mode')).toBe('comment');
  });

  it('at rest: the number and the field on the text line, Send beside them', () => {
    act(() =>
      root?.render(
        <SlotComposer
          onSubmit={async () => ({ ok: true })}
          canAttach
          uploadFile={async () => ({ ok: true, reused: false, versionId: 'v1' })}
        />,
      ),
    );
    const [box] = boxes();
    expect(box?.dataset.shape).toBe('line');
    const field = box?.querySelector('[data-writing-field]');
    expect(field?.querySelector('[data-slot-number="1"]')).not.toBeNull();
    expect(field?.querySelector('textarea')?.getAttribute('aria-label')).toBe('Checkpoint 1');
    expect(button('Aa')).toBeUndefined();
    // The + stays beside the field at rest (the slot attaches today).
    expect(button('Add attachment')).toBeDefined();
    const send = button('Send');
    expect(send?.hasAttribute('data-row-send')).toBe(true);
    expect(send?.disabled).toBe(true);
  });

  it('focused: + Aa Emoji ... Send; no @, no laptop emoji popover, no paper clip', () => {
    act(() =>
      root?.render(
        <SlotComposer
          onSubmit={async () => ({ ok: true })}
          canAttach
          uploadFile={async () => ({ ok: true, reused: false, versionId: 'v1' })}
        />,
      ),
    );
    focusIn(host?.querySelector('textarea'));
    const [box] = boxes();
    expect(box?.dataset.shape).toBe('card');
    expect(rowOrder(box as HTMLElement)).toEqual(['Add attachment', 'Aa', 'Emoji', 'send:Send']);
    expect(button('Mention')).toBeUndefined();
    expect(button('Attach a file to checkpoint 1')).toBeUndefined();
  });

  it("keeps its hints and the field look is the box's", () => {
    act(() =>
      root?.render(<SlotComposer onSubmit={async () => ({ ok: true })} canAttach={false} />),
    );
    const area = host?.querySelector('textarea');
    expect(area?.getAttribute('placeholder')).toBe('Add a checkpoint');
    const frame = host?.querySelector('[data-writing-frame]');
    expect(frame?.className).toContain('[&_textarea]:border-0');
  });

  it('a later slot holds its remove bin in the send slot; "+ Another" sits under the boxes', () => {
    act(() =>
      root?.render(<SlotComposer onSubmit={async () => ({ ok: true })} canAttach={false} />),
    );
    act(() => button('+ Another')?.click());
    const areas = host?.querySelectorAll('textarea');
    focusIn(areas?.[0]);
    focusIn(areas?.[1]);
    const [first, second] = boxes();
    expect(rowOrder(first as HTMLElement)).toEqual(['Aa', 'Emoji', 'send:Send']);
    expect(rowOrder(second as HTMLElement)).toEqual(['Aa', 'Emoji', 'Remove checkpoint 2']);
    const another = button('+ Another');
    expect(boxes().some((b) => b.contains(another ?? null))).toBe(false);
  });

  it('sending keeps every box; the spinner sits in the round Send', async () => {
    let resolve: (r: { ok: true }) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<{ ok: true }>((r) => {
          resolve = r;
        }),
    );
    act(() => root?.render(<SlotComposer onSubmit={onSubmit} canAttach={false} />));
    const area = host?.querySelector('textarea');
    if (area == null) throw new Error('no slot');
    type(area, 'Swap the cover photo');
    expect(button('Send')?.disabled).toBe(false);

    await act(async () => {
      button('Send')?.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]?.getAttribute('data-composer-state')).toBe('sending');
    const send = button('Send');
    expect(send?.getAttribute('aria-busy')).toBe('true');
    expect(send?.querySelector('[data-upload-arc]')).not.toBeNull();
    expect(host?.querySelector('[data-writing-field] textarea')).not.toBeNull();

    await act(async () => {
      resolve({ ok: true });
    });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]?.getAttribute('data-composer-state')).toBe('idle');
  });
});
