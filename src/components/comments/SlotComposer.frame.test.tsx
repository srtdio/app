// @vitest-environment jsdom
// The checkpoint composer on ui/Composer (ComposerFrame): one comment composer
// layout everywhere. Field, emoji, clip and the round Send on ONE 44 row; a
// later slot keeps the same columns (its remove X in the send column); sending
// keeps every row (the spinner sits in the send slot).
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

function rows(): HTMLElement[] {
  return Array.from(host?.querySelectorAll<HTMLElement>('[data-composer-row]') ?? []);
}

/** A row's controls in order: 'field', or each button's name. */
function order(row: HTMLElement): string[] {
  return Array.from(row.children).map((el) =>
    el.hasAttribute('data-composer-field')
      ? 'field'
      : el.hasAttribute('data-slot-number')
        ? 'number'
        : (el.getAttribute('aria-label') ?? el.textContent ?? ''),
  );
}

function type(area: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SlotComposer on ui/Composer', () => {
  it('renders inside [data-composer]: field, emoji, clip, Send on one row', () => {
    act(() =>
      root?.render(
        <SlotComposer
          onSubmit={async () => ({ ok: true })}
          canAttach
          uploadFile={async () => ({ ok: true, reused: false, versionId: 'v1' })}
        />,
      ),
    );
    expect(host?.querySelector('[data-composer]')).not.toBeNull();
    const [row] = rows();
    expect(row).toBeDefined();
    expect(order(row as HTMLElement)).toEqual([
      'field',
      'Emoji',
      'Attach a file to checkpoint 1',
      'Send',
    ]);
    expect(row?.querySelector('[data-composer-field] textarea')).not.toBeNull();
    const send = button('Send');
    expect(send?.className).toContain('rounded-full');
    expect(send?.className).toContain('bg-accent');
    for (const label of ['Emoji', 'Attach a file to checkpoint 1']) {
      expect(button(label)?.className).toContain('rounded-full');
      expect(button(label)?.className).not.toContain('bg-accent');
    }
  });

  it("keeps its hints and the field look is the frame's", () => {
    act(() =>
      root?.render(<SlotComposer onSubmit={async () => ({ ok: true })} canAttach={false} />),
    );
    const area = host?.querySelector('textarea');
    expect(area?.getAttribute('placeholder')).toBe('Add a checkpoint');
    const field = host?.querySelector('[data-composer-field]');
    expect(field?.className).toContain('border-field');
    expect(field?.className).toContain('[&_textarea]:border-0');
  });

  it('a later slot keeps the columns: number, field, emoji, then its remove X in the send column', () => {
    act(() =>
      root?.render(<SlotComposer onSubmit={async () => ({ ok: true })} canAttach={false} />),
    );
    act(() => button('+ Another')?.click());
    const [first, second] = rows();
    expect(order(first as HTMLElement)).toEqual(['number', 'field', 'Emoji', 'Send']);
    expect(order(second as HTMLElement)).toEqual([
      'number',
      'field',
      'Emoji',
      'Remove checkpoint 2',
    ]);
    // "+ Another" sits under the rows, never inside one.
    const another = button('+ Another');
    expect(rows().some((r) => r.contains(another ?? null))).toBe(false);
  });

  it('sending keeps every row; the spinner sits in the round Send', async () => {
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

    await act(async () => {
      button('Send')?.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(host?.querySelector('[data-composer]')?.getAttribute('data-composer-state')).toBe(
      'sending',
    );
    const send = button('Send');
    expect(send?.getAttribute('aria-busy')).toBe('true');
    expect(send?.querySelector('[data-busy-arc]')).not.toBeNull();
    expect(host?.querySelector('[data-composer-field] textarea')).not.toBeNull();

    await act(async () => {
      resolve({ ok: true });
    });
    expect(rows()).toHaveLength(1);
    expect(host?.querySelector('[data-composer]')?.getAttribute('data-composer-state')).toBe(
      'idle',
    );
  });
});
