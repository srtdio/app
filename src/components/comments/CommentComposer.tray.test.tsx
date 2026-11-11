// @vitest-environment jsdom
// The comment composers' "+" (chat's ComposerTray): its tray holds exactly
// Photos, File and Assets in both composers; an Assets pick (chat's
// AssetPicker) becomes a removable chip that sends its library version id
// with the comment or the checkpoint; the checkpoint slots number on from the
// post's existing ledger_seq (the empty next slot a dashed ring).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAsset } from '@/lib/chat/asset-picker';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

const { PDF } = vi.hoisted(() => {
  const pdf: LibraryAsset = {
    assetId: 'asset-1',
    versionId: 'ver-lib-1',
    name: 'Brand guide',
    filename: 'brand-guide.pdf',
    uploadedAt: '2026-11-01T10:00:00Z',
    version: {
      id: 'ver-lib-1',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      duration_ms: null,
      width: null,
      height: null,
      kind: 'document',
    },
  };
  return { PDF: pdf };
});

// Chat's picker reads the library; here its Add hands back one pick.
vi.mock('@/components/chat/AssetPicker', () => ({
  AssetPicker: (props: {
    open: boolean;
    onClose: () => void;
    onConfirm: (picks: LibraryAsset[]) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        data-stub-picker=""
        onClick={() => {
          props.onConfirm([PDF]);
          props.onClose();
        }}
      >
        Add
      </button>
    ) : null,
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
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  );
}

function tileIds(): string[] {
  return Array.from(host?.querySelectorAll('[data-tray] [data-tray-tile]') ?? []).map(
    (el) => el.getAttribute('data-tray-tile') ?? '',
  );
}

/** Focus every writing box (ui/WritingBox shows its row, the "+", only while focused). */
function focusBoxes(): void {
  act(() => {
    host
      ?.querySelectorAll(
        '[data-writing-field] textarea, [data-writing-field] [contenteditable="true"]',
      )
      .forEach((el) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  });
}

function tile(id: string): HTMLButtonElement | null {
  return host?.querySelector<HTMLButtonElement>(`[data-tray] [data-tray-tile="${id}"]`) ?? null;
}

const upload = async (): Promise<{ ok: true; reused: false; versionId: string }> => ({
  ok: true,
  reused: false,
  versionId: 'ver-up-1',
});

function mountComment(
  onSubmit: (
    body: string,
    options: { attachmentVersionIds: string[] },
  ) => Promise<CommentSubmitResult> = async () => ({ ok: true }),
  canAttach = true,
): void {
  act(() => {
    root?.render(
      <CommentComposer
        onSubmit={onSubmit}
        members={[]}
        canAttach={canAttach}
        uploadFile={upload}
        placeholder="Write a comment"
      />,
    );
  });
}

describe('CommentComposer "+" tray', () => {
  it('the "+" opens a tray with exactly Photos, File and Assets; no paper clip', async () => {
    mountComment();
    await settle();
    focusBoxes();
    expect(buttons('Attach a file')).toHaveLength(0);
    const [plus] = buttons('Add attachment');
    expect(plus).toBeDefined();
    act(() => plus?.click());
    expect(tileIds()).toEqual(['photos', 'file', 'assets']);
    const labels = Array.from(host?.querySelectorAll('[data-tray] [data-tray-tile]') ?? []).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['Photos', 'File', 'Assets']);
    // Not a chat tour target.
    expect(plus?.hasAttribute('data-induction')).toBe(false);
    expect(host?.querySelector('[data-tray]')?.hasAttribute('data-induction')).toBe(false);
  });

  it('no "+" where attaching is off', async () => {
    mountComment(undefined, false);
    await settle();
    focusBoxes();
    expect(buttons('Add attachment')).toHaveLength(0);
  });

  it('an Assets pick becomes a removable chip and sends its library version id', async () => {
    const onSubmit = vi.fn<(body: string, options: unknown) => Promise<CommentSubmitResult>>(
      async () => ({ ok: true }),
    );
    mountComment(onSubmit);
    await settle();
    focusBoxes();
    act(() => buttons('Add attachment')[0]?.click());
    act(() => tile('assets')?.click());
    await settle();
    const stub = host?.querySelector<HTMLButtonElement>('[data-stub-picker]');
    expect(stub).not.toBeNull();
    act(() => stub?.click());
    await settle();

    const chip = host?.querySelector('[data-library-chip="ver-lib-1"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Brand guide');
    // ui/PendingChip, ready: "<TYPE> · <size>" and the trailing X removes it.
    expect(chip?.getAttribute('data-pending-chip')).toBe('ready');
    expect(chip?.querySelector('[data-pending-chip-meta]')?.textContent).toBe('PDF · 1 KB');
    expect(buttons('Remove Brand guide')).toHaveLength(1);

    // A pick alone is sendable, like a finished upload.
    await act(async () => {
      buttons('Post')[0]?.click();
    });
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ attachmentVersionIds: ['ver-lib-1'] });
    expect(host?.querySelector('[data-library-chip]')).toBeNull();
  });
});
