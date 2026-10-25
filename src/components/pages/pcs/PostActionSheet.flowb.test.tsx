// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Flow B 31 / 38 on the post's ⋯ menu (ui/ActionMenu; phone here, so a Sheet):
// Copy link leads, then the creator's stage moves (Approve on their behalf,
// Reject, Park) hand off to the page after the menu closes; Delete post and
// Remove image act at once (no confirm, the page's Undo strip is the safety
// net).

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/pages/pcs/ConversationPicker', () => ({ ConversationPicker: () => null }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

import { IconCheck, IconPause, IconX } from '@/components/ui/icons';
import {
  DELETE_CONFIRM_BASE,
  PostActionSheet,
  type PostMoveRow,
  type RemoveImageAction,
} from '@/components/pages/pcs/PostActionSheet';

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

async function render(
  moveRows: PostMoveRow[],
  onOpenChange = vi.fn(),
  onDeletePost: () => Promise<void> = async () => {},
  removeImage?: RemoveImageAction,
): Promise<void> {
  await act(async () => {
    root?.render(
      <PostActionSheet
        open
        onOpenChange={onOpenChange}
        postId="p1"
        workspaceId="w1"
        currentUserId="u1"
        gallery={[]}
        deps={{
          endpoint: null,
          getAccessToken: async () => null,
          fetcher: async () => new Response(),
        }}
        workspaceKey="GBL"
        postNumber={101}
        onToast={() => {}}
        canDelete
        onDeletePost={onDeletePost}
        moveRows={moveRows}
        removeImage={removeImage}
      />,
    );
    await new Promise((r) => setTimeout(r, 30));
  });
}

function rowLabels(): string[] {
  const dialog = document.querySelector('[role="dialog"]');
  return [...(dialog?.querySelectorAll('button') ?? [])]
    .map((b) => b.querySelector('.font-medium')?.textContent ?? '')
    .filter((label) => label !== '');
}

function rowNamed(label: string): HTMLButtonElement | undefined {
  const dialog = document.querySelector('[role="dialog"]');
  return [...(dialog?.querySelectorAll('button') ?? [])].find(
    (b) => b.querySelector('.font-medium')?.textContent === label,
  );
}

describe('31. Approve on their behalf lives in the ⋯ menu', () => {
  it('Copy link first, then the creator moves; a pick closes, then hands off', async () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    await render(
      [
        { key: 'approved', icon: IconCheck, label: 'Approve on their behalf', onPick },
        { key: 'rejected', icon: IconX, label: 'Reject', danger: true, onPick: vi.fn() },
        { key: 'parked', icon: IconPause, label: 'Park', onPick: vi.fn() },
      ],
      onOpenChange,
    );
    expect(rowLabels().slice(0, 5)).toEqual([
      'Copy link',
      'Approve on their behalf',
      'Reject',
      'Park',
      'Send to chat',
    ]);
    expect(rowLabels().at(-1)).toBe('Delete post');
    await act(async () => {
      rowNamed('Approve on their behalf')?.click();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPick).toHaveBeenCalledOnce();
  });

  it('shows no move rows when the page passes none (approvers)', async () => {
    await render([]);
    expect(rowLabels()[0]).toBe('Copy link');
    expect(rowLabels()).not.toContain('Approve on their behalf');
  });
});

describe('B7. Delete post deletes at once, no confirm', () => {
  it('the row keeps its honest line; a tap closes the sheet and hands off once', async () => {
    expect(DELETE_CONFIRM_BASE).toBe('Moves to Recently deleted. You can restore it there.');
    const onOpenChange = vi.fn();
    const onDeletePost = vi.fn(async () => {});
    await render([], onOpenChange, onDeletePost);
    const row = rowNamed('Delete post');
    expect(row?.textContent).toContain(DELETE_CONFIRM_BASE);
    expect(document.body.textContent).not.toContain('cannot be undone');
    await act(async () => {
      row?.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onDeletePost).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // No confirm view: no second "Delete post" dialog, no confirm copy.
    expect(document.querySelector('[data-post-delete-text]')).toBeNull();
    expect(
      [...document.querySelectorAll('[role="dialog"]')].some((d) =>
        d.querySelector('h2')?.textContent?.includes('Delete post'),
      ),
    ).toBe(false);
  });
});

describe('Remove image moved from the picture ⋮ into the header sheet', () => {
  it('absent unless the page passes it', async () => {
    await render([]);
    expect(rowLabels()).not.toContain('Remove image');
  });

  it('names the shown slide; a tap closes and hands off once, no confirm', async () => {
    const onOpenChange = vi.fn();
    const onRemove = vi.fn();
    await render([], onOpenChange, async () => {}, { index: 1, count: 3, saving: false, onRemove });
    expect(rowLabels()).toContain('Remove image');
    const row = rowNamed('Remove image');
    expect(row?.textContent).toContain('Image 2 of 3');
    await act(async () => {
      row?.click();
    });
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('[data-remove-image-confirm]')).toBeNull();
    expect(document.body.textContent).not.toContain('Remove this image?');
  });

  it('does nothing while a gallery write is in flight', async () => {
    const onRemove = vi.fn();
    await render([], vi.fn(), async () => {}, { index: 0, count: 2, saving: true, onRemove });
    const row = rowNamed('Remove image');
    expect(row?.textContent).toContain('Saving…');
    await act(async () => {
      row?.click();
    });
    expect(onRemove).not.toHaveBeenCalled();
  });
});
