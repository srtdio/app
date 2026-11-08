// @vitest-environment jsdom
// The caption and image pin comment sheets on ui/WritingBox (comment mode):
// the field on top (its aria-label kept), focused the row under it: Aa, Emoji
// ... the round Post (RowSend, the arrow-up). No +, no @, no laptop emoji
// popover. Cancel stays in the sheet footer; Post is busy while posting.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

import { CaptionAnnotationComposer } from '@/components/pages/pcs/CaptionAnnotationComposer';
import { PinAnnotationComposer } from '@/components/pages/pcs/PinAnnotationComposer';
import { INDUCTION_KEYS } from '@/lib/induction-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(node: ReactElement): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
    await new Promise((r) => setTimeout(r, 30));
  });
}

const byLabel = (label: string): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

type Kind = 'caption' | 'pin';

function sheet(
  kind: Kind,
  props: { body: string; submitting?: boolean; onSubmit?: (body: string) => void },
): ReactElement {
  const common = {
    open: true,
    body: props.body,
    onBodyChange: () => undefined,
    onCancel: () => undefined,
    onDiscard: () => undefined,
    onSubmit: props.onSubmit ?? (() => undefined),
    submitting: props.submitting ?? false,
  };
  return kind === 'caption' ? (
    <CaptionAnnotationComposer {...common} quote="Diwali boxes" />
  ) : (
    <PinAnnotationComposer {...common} context="Slide 1" />
  );
}

const FIELD: Record<Kind, string> = {
  caption: 'Caption comment body',
  pin: 'Image comment body',
};

describe.each(['caption', 'pin'] as const)('%s comment sheet on ui/WritingBox', (kind) => {
  it('renders the WritingBox in comment mode around the field', async () => {
    await mount(sheet(kind, { body: 'Shorter please' }));
    const box = document.querySelector<HTMLElement>('[data-writing-box]');
    expect(box?.getAttribute('data-mode')).toBe('comment');
    expect(
      box?.querySelector(`[data-writing-field] textarea[aria-label="${FIELD[kind]}"]`),
    ).not.toBeNull();
  });

  it('the row: Aa, Emoji ... Post (RowSend); no +, no @; Cancel in the footer', async () => {
    const onSubmit = vi.fn();
    await mount(sheet(kind, { body: 'Shorter please', onSubmit }));
    const row = document.querySelector('[data-writing-row]');
    const names = Array.from(row?.querySelectorAll('button') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Aa', 'Emoji', 'Post']);
    expect(byLabel('Add attachment')).toBeNull();
    expect(byLabel('Mention')).toBeNull();
    const post = byLabel('Post');
    expect(post?.hasAttribute('data-row-send')).toBe(true);
    if (kind === 'caption') {
      expect(post?.getAttribute('data-induction')).toBe(INDUCTION_KEYS.postCommentPost);
    }
    act(() => post?.click());
    expect(onSubmit).toHaveBeenCalledWith('Shorter please');
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    );
    expect(cancel).toBeDefined();
    expect(row?.contains(cancel ?? null)).toBe(false);
  });

  it('Post is grey and disabled with nothing typed, busy while posting', async () => {
    await mount(sheet(kind, { body: '   ' }));
    expect(byLabel('Post')?.disabled).toBe(true);
    act(() => root?.unmount());
    document.body.innerHTML = '';
    await mount(sheet(kind, { body: 'Shorter please', submitting: true }));
    const post = byLabel('Post');
    expect(post?.getAttribute('aria-busy')).toBe('true');
    expect(post?.disabled).toBe(true);
  });
});
