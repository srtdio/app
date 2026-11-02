// @vitest-environment jsdom
// Reply privately on plan item comments: shown only on someone else's recorded
// comment whose name is known and who is still a member (never mine, a pending
// one, an unknown name or a former member); a tap writes the plan_comment quote
// on the DM's draft in beforeOpen and opens the DM through useOpenPersonDm.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ME = '11111111-1111-4111-8111-111111111111';
const ASHA = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  members: null as unknown,
  openDm: vi.fn(),
  setPrivateReplyDraft: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  peekWorkspaceMembers: () => h.members,
}));
vi.mock('@/components/ui/use-open-person-dm', () => ({
  useOpenPersonDm: () => h.openDm,
}));
vi.mock('@/lib/chat/drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/drafts')>()),
  setPrivateReplyDraft: h.setPrivateReplyDraft,
}));

import {
  PlanItemThread,
  showPlanReplyPrivately,
  type ShownComment,
} from '@/components/chat/PlanItemThread';
import { REPLY_PRIVATELY } from '@/lib/chat/private-reply';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { planId: 'plan-1', itemId: 'item-1', whereLabel: 'Reel idea' };

function shown(extra: Partial<ShownComment> = {}): ShownComment {
  return {
    id: 'c-1',
    authorUserId: ASHA,
    authorName: 'Asha Rao',
    mine: false,
    body: 'Swap the hero shot',
    visibility: 'everyone',
    createdAt: '2026-11-02T10:00:00.000Z',
    pending: false,
    authorKnown: true,
    ...extra,
  };
}

describe('showPlanReplyPrivately', () => {
  it("shows on another member's recorded comment with a known name", () => {
    expect(showPlanReplyPrivately(shown(), ME, false)).toBe(true);
  });

  it('hides on mine, pending, an unknown name, a former member or no author', () => {
    expect(showPlanReplyPrivately(shown({ mine: true }), ME, false)).toBe(false);
    expect(showPlanReplyPrivately(shown({ authorUserId: ME }), ME, false)).toBe(false);
    expect(showPlanReplyPrivately(shown({ pending: true }), ME, false)).toBe(false);
    expect(showPlanReplyPrivately(shown({ authorKnown: false }), ME, false)).toBe(false);
    const unmarked = shown();
    delete unmarked.authorKnown;
    expect(showPlanReplyPrivately(unmarked, ME, false)).toBe(false);
    expect(showPlanReplyPrivately(shown(), ME, true)).toBe(false);
    expect(showPlanReplyPrivately(shown({ authorUserId: null }), ME, false)).toBe(false);
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  h.members = {
    loading: false,
    error: null,
    rows: [
      { user_id: ME, active: true, removed_at: null, role: 'agency' },
      { user_id: ASHA, active: true, removed_at: null, role: 'agency' },
      { user_id: GONE, active: false, removed_at: '2026-10-01T00:00:00.000Z', role: 'agency' },
    ],
    profiles: new Map(),
    options: [],
  };
  h.openDm.mockReset();
  h.setPrivateReplyDraft.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(comments: ShownComment[], withTarget = true): void {
  act(() => {
    root?.render(
      <MemoryRouter>
        <PlanItemThread
          comments={comments}
          workspaceId="ws"
          me={ME}
          {...(withTarget ? { replyPrivately: TARGET } : {})}
        />
      </MemoryRouter>,
    );
  });
}

function replyPrivately(id: string): HTMLButtonElement | null {
  return (
    host?.querySelector<HTMLButtonElement>(
      `[data-plan-comment-id="${id}"] [data-row-action="reply-privately"]`,
    ) ?? null
  );
}

describe('Reply privately in the plan thread', () => {
  it('shows under an active member comment only; never mine or a former member', () => {
    mount([
      shown({ id: 'other' }),
      shown({ id: 'mine', mine: true, authorUserId: ME, authorName: 'You' }),
      shown({ id: 'gone', authorUserId: GONE, authorName: 'Gus Gone' }),
      shown({ id: 'unnamed', authorKnown: false, authorName: 'Member' }),
    ]);
    const button = replyPrivately('other');
    expect(button?.textContent).toBe(REPLY_PRIVATELY);
    expect(button?.className).toContain('h-11');
    expect(button?.className).toContain('min-w-[44px]');
    expect(replyPrivately('mine')).toBeNull();
    expect(replyPrivately('gone')).toBeNull();
    expect(replyPrivately('unnamed')).toBeNull();
  });

  it('a thread without a target never offers it', () => {
    mount([shown({ id: 'other' })], false);
    expect(replyPrivately('other')).toBeNull();
  });

  it('a tap opens the DM and writes the plan_comment quote in beforeOpen', () => {
    mount([shown({ id: 'pc-1' })]);
    act(() => replyPrivately('pc-1')?.click());

    expect(h.openDm).toHaveBeenCalledTimes(1);
    const [userId, options] = h.openDm.mock.calls[0] as [
      string,
      { beforeOpen?: (channelId: string) => void },
    ];
    expect(userId).toBe(ASHA);
    expect(h.setPrivateReplyDraft).not.toHaveBeenCalled();

    options.beforeOpen?.('dm-9');
    expect(h.setPrivateReplyDraft).toHaveBeenCalledWith('dm-9', {
      kind: 'plan_comment',
      sourceId: 'pc-1',
      authorUserId: ASHA,
      authorName: 'Asha Rao',
      excerpt: 'Swap the hero shot',
      whereLabel: 'Reel idea',
      link: { kind: 'plan_comment', planId: 'plan-1', itemId: 'item-1', commentId: 'pc-1' },
    });
  });
});
