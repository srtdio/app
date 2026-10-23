// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Flow B 31 / 38 on the post's ⋯ sheet: the creator's stage moves ("Approve
// for {brand}", Reject, Park) lead the list and hand off to the page after the
// sheet closes; the delete row and its confirm say the same thing.

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/pages/pcs/ConversationPicker', () => ({ ConversationPicker: () => null }));

import {
  DELETE_CONFIRM_BASE,
  PostActionSheet,
  type PostMoveRow,
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

async function render(moveRows: PostMoveRow[], onClose = vi.fn()): Promise<void> {
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
        onDeletePost={async () => {}}
        readPlans={async () => ({ ok: true, data: [] })}
        moveRows={moveRows}
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

describe('31. Approve for {brand} lives in the ⋯ sheet', () => {
  it('leads with the creator moves, closes, then hands off', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    await render(
      [
        { key: 'approved', icon: null, label: 'Approve for Kite and Co', onPick },
        { key: 'rejected', icon: null, label: 'Reject', danger: true, onPick: vi.fn() },
        { key: 'parked', icon: null, label: 'Park', onPick: vi.fn() },
      ],
      onClose,
    );
    expect(rowLabels().slice(0, 4)).toEqual([
      'Approve for Kite and Co',
      'Reject',
      'Park',
      'Send to chat',
    ]);
    await act(async () => {
      rowNamed('Approve for Kite and Co')?.click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledOnce();
  });

  it('shows no move rows when the page passes none (approvers)', async () => {
    await render([]);
    expect(rowLabels()[0]).toBe('Send to chat');
    expect(rowLabels()).not.toContain('Approve for Kite and Co');
  });
});

describe('38. delete says the same thing on the row and in the confirm', () => {
  it('"Moves to Recently deleted. You can restore it there." on both', async () => {
    expect(DELETE_CONFIRM_BASE).toBe('Moves to Recently deleted. You can restore it there.');
    await render([]);
    const row = rowNamed('Delete post');
    expect(row?.textContent).toContain(DELETE_CONFIRM_BASE);
    expect(document.body.textContent).not.toContain('cannot be undone');
    await act(async () => {
      row?.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.querySelector('[data-post-delete-text]')?.textContent).toBe(
      DELETE_CONFIRM_BASE,
    );
  });
});
