// @vitest-environment jsdom
// The comment composer on ui/Composer (ComposerFrame): field, emoji, clip and
// the round Send on one 44 row; sending keeps the row (the spinner sits in the
// send slot); the field look is the frame's, never the editor's own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

import { CommentComposer, type CommentSubmitResult } from '@/components/comments/CommentComposer';

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

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host?.querySelector<T>(sel) ?? null;
}

function byLabel(label: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function mount(
  onSubmit: (
    body: string,
    options: { attachmentVersionIds: string[] },
  ) => Promise<CommentSubmitResult> = async () => ({ ok: true }),
  extra: { submitLabel?: string; placeholder?: string; submitAnchor?: string } = {},
): void {
  act(() => {
    root?.render(
      <CommentComposer
        onSubmit={onSubmit}
        members={[]}
        canAttach
        uploadFile={async () => ({ ok: true, reused: false, versionId: 'ver-1' })}
        initialBody="Looks good"
        placeholder={extra.placeholder ?? 'Write a comment'}
        {...(extra.submitLabel !== undefined ? { submitLabel: extra.submitLabel } : {})}
        {...(extra.submitAnchor !== undefined ? { submitAnchor: extra.submitAnchor } : {})}
      />,
    );
  });
}

describe('CommentComposer on ui/Composer', () => {
  it('renders inside [data-composer]: field, emoji, clip, then the round Send on one row', async () => {
    mount();
    await settle();
    const frame = q('[data-composer]');
    expect(frame).not.toBeNull();
    const rows = host?.querySelectorAll('[data-composer-row]') ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    const field = row.querySelector('[data-composer-field]');
    expect(field?.querySelector('[contenteditable="true"]')).not.toBeNull();

    // The side slot (data-composer-side) is a wrapper; its buttons keep their place in the row.
    const cells = Array.from(row.children).flatMap((el) =>
      el.hasAttribute('data-composer-side') ? Array.from(el.children) : [el],
    );
    const order = cells.map((el) =>
      el.hasAttribute('data-composer-field')
        ? 'field'
        : (el.querySelector('button')?.getAttribute('aria-label') ??
          el.getAttribute('aria-label') ??
          ''),
    );
    expect(order).toEqual(['field', 'Emoji', 'Attach a file', 'Post']);

    const send = byLabel('Post');
    expect(send?.className).toContain('rounded-full');
    expect(send?.className).toContain('bg-accent');
    // Side buttons share one treatment: bare 44 circles.
    for (const label of ['Emoji', 'Attach a file']) {
      const side = byLabel(label);
      expect(side?.className).toContain('rounded-full');
      expect(side?.className).toContain('h-11');
      expect(side?.className).not.toContain('bg-accent');
    }
  });

  it("the field look is the frame's: the editor draws no line, well or focus line", async () => {
    mount();
    await settle();
    const editor = q('[contenteditable="true"]');
    expect(editor?.className).not.toContain('border-field');
    expect(editor?.className).not.toContain('lit-well');
    expect(editor?.className).not.toContain('focus:lit-focus');
    const field = q('[data-composer-field]');
    expect(field?.className).toContain('border-field');
    expect(field?.className).toContain('lit-well');
    expect(field?.className).toContain('focus-within:lit-focus');
  });

  it('keeps its hint and the guide anchor on Send', async () => {
    mount(undefined, { placeholder: 'Write a reply', submitLabel: 'Reply', submitAnchor: 'x-key' });
    await settle();
    expect(q('[contenteditable="true"]')?.getAttribute('data-placeholder')).toBe('Write a reply');
    expect(byLabel('Reply')?.getAttribute('data-induction')).toBe('x-key');
  });

  it('sending keeps the row: the spinner sits in the send slot, the field stays', async () => {
    let resolve: (r: CommentSubmitResult) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<CommentSubmitResult>((r) => {
          resolve = r;
        }),
    );
    mount(onSubmit);
    await settle();
    const before = q('[data-composer-row]');

    await act(async () => {
      byLabel('Post')?.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(q('[data-composer]')?.getAttribute('data-composer-state')).toBe('sending');
    expect(q('[data-composer-row]')).toBe(before);
    expect(q('[data-composer-field] [contenteditable="true"]')).not.toBeNull();
    const send = byLabel('Post');
    expect(send?.getAttribute('aria-busy')).toBe('true');
    expect(send?.querySelector('[data-busy-arc]')).not.toBeNull();
    expect(send?.className).toContain('rounded-full');

    await act(async () => {
      resolve({ ok: true });
    });
    await settle();
    expect(q('[data-composer]')?.getAttribute('data-composer-state')).toBe('idle');
    expect(q('[data-composer-row]')).not.toBeNull();
  });

  it('chips and errors sit under the row, never inside it', async () => {
    mount(async () => ({ ok: false, error: "Couldn't post the comment. Try again." }));
    await settle();
    await act(async () => {
      byLabel('Post')?.click();
    });
    await settle();
    const alert = q('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(q('[data-composer-row]')?.contains(alert)).toBe(false);
  });
});
