// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Flow B 31 / 38 on the post's ⋯ sheet: the creator's stage moves ("Approve
// for {brand}", Reject, Park) lead the list and hand off to the page after the
// sheet closes; Delete post deletes at once (spec B7: no confirm, the page's
// Undo strip is the safety net).

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/pages/pcs/ConversationPicker', () => ({ ConversationPicker: () => null }));

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
  onClose = vi.fn(),
  onDeletePost: () => Promise<void> = async () => {},
  removeImage?: RemoveImageAction,
): Promise<void> {
  await act(async () => {
    root?.render(
      <PostActionSheet
        open
        onClose={onClose}
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

describe('31. Approve on their behalf lives in the ⋯ sheet', () => {
  it('leads with the creator moves, closes, then hands off', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await render(
      [
        { key: 'approved', icon: null, label: 'Approve on their behalf', onPick },
        { key: 'rejected', icon: null, label: 'Reject', danger: true, onPick: vi.fn() },
        { key: 'parked', icon: null, label: 'Park', onPick: vi.fn() },
      ],
      onClose,
    );
    expect(rowLabels().slice(0, 4)).toEqual([
      'Approve on their behalf',
      'Reject',
      'Park',
      'Send to chat',
    ]);
    await act(async () => {
      rowNamed('Approve on their behalf')?.click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledOnce();
  });

  it('shows no move rows when the page passes none (approvers)', async () => {
    await render([]);
    expect(rowLabels()[0]).toBe('Send to chat');
    expect(rowLabels()).not.toContain('Approve on their behalf');
  });
});

describe('B7. Delete post deletes at once, no confirm', () => {
  it('the row keeps its honest line; a tap closes the sheet and hands off once', async () => {
    expect(DELETE_CONFIRM_BASE).toBe('Moves to Recently deleted. You can restore it there.');
    const onClose = vi.fn();
    const onDeletePost = vi.fn(async () => {});
    await render([], onClose, onDeletePost);
    const row = rowNamed('Delete post');
    expect(row?.textContent).toContain(DELETE_CONFIRM_BASE);
    expect(document.body.textContent).not.toContain('cannot be undone');
    await act(async () => {
      row?.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(onDeletePost).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
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

  it('names the shown slide, asks first, and only Remove hands off once', async () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    await render([], onClose, async () => {}, { index: 1, count: 3, saving: false, onRemove });
    expect(rowLabels()).toContain('Remove image');
    const row = rowNamed('Remove image');
    expect(row?.textContent).toContain('Image 2 of 3');
    await act(async () => {
      row?.click();
    });
    expect(onRemove).not.toHaveBeenCalled();
    const confirm = document.querySelector('[data-remove-image-confirm]');
    expect(confirm).not.toBeNull();
    expect(document.body.textContent).toContain('Remove this image?');
    const buttons = [...(confirm?.querySelectorAll('button') ?? [])];
    const cancel = buttons.find((b) => b.textContent === 'Cancel');
    await act(async () => {
      cancel?.click();
    });
    expect(onRemove).not.toHaveBeenCalled();
    expect(rowLabels()).toContain('Remove image');
    await act(async () => {
      rowNamed('Remove image')?.click();
    });
    const remove = [
      ...(document.querySelector('[data-remove-image-confirm]')?.querySelectorAll('button') ?? []),
    ].find((b) => b.textContent === 'Remove');
    await act(async () => {
      remove?.click();
    });
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });
});
