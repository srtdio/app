// @vitest-environment jsdom
// Reply privately on plan item comments: shown only on someone else's recorded
// comment whose name is known and who is still a member (never mine, a pending
// one, an unknown name or a former member); a tap opens the person card's
// inline message for the author with the plan_comment quote as its source.
// The author's photo and name carry the same source.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ME = '11111111-1111-4111-8111-111111111111';
const ASHA = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  members: null as unknown,
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  peekWorkspaceMembers: () => h.members,
}));

import {
  PlanItemThread,
  showPlanReplyPrivately,
  type ShownComment,
} from '@/components/chat/PlanItemThread';
import { REPLY_PRIVATELY } from '@/lib/chat/private-reply';
import { closePersonCard, personCardSnapshot } from '@/lib/person-card';

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
  closePersonCard();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  closePersonCard();
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

  const QUOTE = {
    kind: 'plan_comment',
    sourceId: 'pc-1',
    authorUserId: ASHA,
    authorName: 'Asha Rao',
    excerpt: 'Swap the hero shot',
    whereLabel: 'Reel idea',
    link: { kind: 'plan_comment', planId: 'plan-1', itemId: 'item-1', commentId: 'pc-1' },
  };

  it('a tap opens the inline message card with the plan_comment source', () => {
    mount([shown({ id: 'pc-1' })]);
    const button = replyPrivately('pc-1');
    act(() => button?.click());
    const request = personCardSnapshot();
    expect(request?.userId).toBe(ASHA);
    expect(request?.view).toBe('card');
    expect(request?.trigger).toBe(button);
    expect(request?.source).toEqual(QUOTE);
  });

  it("the author's photo or name opens the card with the same source", () => {
    mount([shown({ id: 'pc-1' })]);
    const trigger = host?.querySelector<HTMLElement>(
      `[data-plan-comment-id="pc-1"] [data-person-trigger="${ASHA}"]`,
    );
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    expect(personCardSnapshot()?.source).toEqual(QUOTE);
  });

  it('a former member opens the card with no source', () => {
    mount([shown({ id: 'gone', authorUserId: GONE, authorName: 'Gus Gone' })]);
    const trigger = host?.querySelector<HTMLElement>(`[data-person-trigger="${GONE}"]`);
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    expect(personCardSnapshot()?.source ?? null).toBeNull();
  });
});
