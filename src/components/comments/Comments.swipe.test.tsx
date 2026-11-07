// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { UndoableAction } from '@/lib/use-undoable-action';

// Swipe (CLAUDE.md): on touch every post comment and reply row swipes both
// ways through the one core. Right = the row's Reply (its composer opens, own
// and others' alike). Left = Delete through the same UndoStrip path as the ⋯
// menu, only on a row whose ⋯ offers Delete; on anyone else's row the left
// swipe only rubber-bands and nothing opens. A mouse never swipes.

type ListResult = CommentResult<CommentRow[]>;

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const { queue, actions, deleteSpy } = vi.hoisted(() => ({
  queue: [] as ListResult[],
  actions: [] as UndoableAction[],
  deleteSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async () => queue.shift() ?? { ok: true, data: [] }),
    deleteComment: vi.fn(async (...args: unknown[]) => {
      deleteSpy(...args);
      return { ok: true, data: 'deleted' };
    }),
  };
});
vi.mock('@/lib/use-undoable-action', () => ({
  useUndoableAction: () => ({
    run: (action: UndoableAction) => actions.push(action),
    flush: () => undefined,
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        in: async () => ({ data: [], error: null }),
        order: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/people-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people-names')>();
  return { ...actual, resolvePeople: async () => true };
});
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useHoverPointer: () => false,
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({
    canAttach: false,
    presignEnabled: false,
    presignCache: null,
    uploadFile: async () => ({ ok: false, message: 'off' }),
  }),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useMentionCandidates: () => ({ candidates: [] }),
}));

import { Comments, commentDomId } from '@/components/comments/Comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, body: string, overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: ME,
    body,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'post-1',
    entity_type: 'post',
    id,
    ledger_batch_id: null,
    ledger_seq: null,
    legacy_author_name: null,
    legacy_author_email: null,
    mentions: null,
    parent_comment_id: null,
    resolution_note: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    sent_back_at: null,
    sent_back_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
    workspace_id: 'ws-1',
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  act(() => {
    root?.render(<Comments workspaceId="ws-1" entityType="post" entityId="post-1" />);
  });
  await settle();
}

/** The swipeable row of a comment (its own row, not a reply's under it). */
function rowOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[id="${commentDomId(id)}"] [data-comment-row]`);
  if (el === null) throw new Error(`no row ${id}`);
  return el;
}

/** One pointer event (jsdom has no PointerEvent: a MouseEvent carrying its fields). */
function pointer(el: Element, type: string, x: number, t: number, pointerType: string): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 40 });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  Object.defineProperty(e, 'pointerId', { value: 7 });
  Object.defineProperty(e, 'timeStamp', { value: t });
  el.dispatchEvent(e);
}

/** A finger (or a mouse) drags a row by dx px (left when negative) and lets go. */
async function swipe(id: string, dx: number, pointerType = 'touch'): Promise<void> {
  const el = rowOf(id);
  await act(async () => {
    pointer(el, 'pointerdown', 300, 0, pointerType);
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      pointer(el, 'pointermove', 300 + (dx * i) / steps, i * 16, pointerType);
    }
    pointer(el, 'pointerup', 300 + dx, steps * 16 + 16, pointerType);
    await Promise.resolve();
  });
  await settle();
}

const composerUnder = (id: string): Element | null =>
  document.querySelector(`[id="${commentDomId(id)}"] [data-reply-composer]`);

beforeEach(() => {
  queue.length = 0;
  actions.length = 0;
  deleteSpy.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Comments swipe', () => {
  it('own comment, swipe left: the same delete as the ⋯ menu (hidden, UndoStrip)', async () => {
    queue.push({ ok: true, data: [row('c-1', 'my own words')] });
    await mount();
    expect(
      rowOf('c-1').parentElement?.querySelector('[data-comment-swipe-icon="delete"]'),
    ).toBeTruthy();

    await swipe('c-1', -120);

    expect(host?.textContent).not.toContain('my own words');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.label).toBe('Comment deleted');
    // The UndoStrip window is still open: nothing sent yet.
    expect(deleteSpy).not.toHaveBeenCalled();
    act(() => actions[0]?.revert?.());
    expect(host?.textContent).toContain('my own words');
  });

  it("someone else's comment, swipe left: nothing opens, nothing is deleted", async () => {
    queue.push({ ok: true, data: [row('c-2', 'their words', { author_user_id: OTHER })] });
    await mount();
    // No bin behind a row that cannot be deleted (rubber band only).
    expect(
      rowOf('c-2').parentElement?.querySelector('[data-comment-swipe-icon="delete"]'),
    ).toBeNull();

    await swipe('c-2', -120);

    expect(actions).toHaveLength(0);
    expect(host?.textContent).toContain('their words');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(composerUnder('c-2')).toBeNull();
  });

  it('swipe right opens the Reply composer on own and others’ comments', async () => {
    queue.push({
      ok: true,
      data: [
        row('c-own', 'mine', { created_at: '2026-01-02T00:00:00.000Z' }),
        row('c-other', 'theirs', { author_user_id: OTHER }),
      ],
    });
    await mount();
    expect(composerUnder('c-own')).toBeNull();
    expect(composerUnder('c-other')).toBeNull();

    await swipe('c-own', 120);
    expect(composerUnder('c-own')).toBeTruthy();
    await swipe('c-other', 120);
    expect(composerUnder('c-other')).toBeTruthy();
    // The row's Reply now reads Cancel, exactly as after a tap on Reply.
    const replyWord = document.querySelector(
      `[id="${commentDomId('c-other')}"] [data-comment-row="root"] [data-row-action="reply"]`,
    );
    expect(replyWord?.textContent).toBe('Cancel');
    expect(actions).toHaveLength(0);
  });

  it('swipe right on a reply opens the thread composer (Reply on a reply)', async () => {
    queue.push({
      ok: true,
      data: [
        row('r-1', 'a reply', {
          author_user_id: OTHER,
          parent_comment_id: 'c-root',
          created_at: '2026-01-02T00:00:00.000Z',
        }),
        row('c-root', 'the root'),
      ],
    });
    await mount();
    expect(composerUnder('c-root')).toBeNull();

    await swipe('r-1', 120);

    expect(composerUnder('c-root')).toBeTruthy();
  });

  it('a short swipe, a vertical drag or a mouse drag does nothing', async () => {
    queue.push({ ok: true, data: [row('c-1', 'stays put')] });
    await mount();

    await swipe('c-1', -20);
    // Mostly vertical: the list's scroll, never the swipe.
    const el = rowOf('c-1');
    await act(async () => {
      pointer(el, 'pointerdown', 300, 0, 'touch');
      const down = new MouseEvent('pointermove', { bubbles: true, clientX: 290, clientY: 140 });
      Object.defineProperty(down, 'pointerType', { value: 'touch' });
      Object.defineProperty(down, 'pointerId', { value: 7 });
      el.dispatchEvent(down);
      pointer(el, 'pointerup', 200, 200, 'touch');
      await Promise.resolve();
    });
    await swipe('c-1', -120, 'mouse');
    await swipe('c-1', 120, 'mouse');

    expect(actions).toHaveLength(0);
    expect(composerUnder('c-1')).toBeNull();
    expect(host?.textContent).toContain('stays put');
  });

  it('the replies and the reply composer sit outside the sliding row', async () => {
    queue.push({
      ok: true,
      data: [
        row('r-1', 'a reply', {
          parent_comment_id: 'c-root',
          created_at: '2026-01-02T00:00:00.000Z',
        }),
        row('c-root', 'the root'),
      ],
    });
    await mount();
    await swipe('c-root', 120);
    const slider = rowOf('c-root');
    expect(slider.getAttribute('data-comment-row')).toBe('root');
    expect(slider.querySelector('[data-replies]')).toBeNull();
    expect(slider.querySelector('[data-reply-composer]')).toBeNull();
    expect(slider.className).toContain('touch-pan-y');
    expect(slider.parentElement?.className).toContain('overflow-x-clip');
  });
});
