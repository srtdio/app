// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';
import type { MentionCandidate } from '@/lib/workspace-members';
import type { CommentSubmitResult } from '@/components/comments/CommentComposer';

// Clients cannot see a draft post, so its comment @-mention picker does not
// offer them; a Review post and brief comments offer everyone, and chat's
// MentionPicker is untouched. When comment_create still rejects a mention
// (invalid_mention), the composer keeps its draft and the one toast explains.

type ListResult = CommentResult<CommentRow[]>;

const AGENT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const MEMBERS: MentionCandidate[] = [
  { id: AGENT, name: 'Ada Agent', username: 'ada', role: 'agency', avatarUrl: null },
  { id: OWNER, name: 'Omar Owner', username: 'omar', role: 'owner', avatarUrl: null },
  { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
];

interface ComposerProps {
  members: MentionCandidate[];
  onSubmit: (
    body: string,
    options: { attachmentVersionIds: string[] },
  ) => Promise<CommentSubmitResult>;
}

const { composers, toasts, createSpy } = vi.hoisted(() => ({
  composers: [] as ComposerProps[],
  toasts: [] as ToastOptions[],
  createSpy: vi.fn(),
}));

vi.mock('@/components/comments/CommentComposer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/CommentComposer')>();
  return {
    ...actual,
    CommentComposer: (props: ComposerProps) => {
      composers.push(props);
      return <div data-composer="" />;
    },
  };
});
vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: [] })),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return {
    ...actual,
    commentCreate: vi.fn(async (...args: unknown[]) => createSpy(...args)),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      toasts.push(options);
      return `toast-${toasts.length}`;
    },
    dismiss: () => undefined,
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: AGENT } } } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        // createComment's membership pre-check: everyone is an active member.
        in: async () => ({
          data: [{ user_id: AGENT }, { user_id: OWNER }, { user_id: CLIENT }],
          error: null,
        }),
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
  useMentionCandidates: () => ({ candidates: MEMBERS, loading: false, error: null }),
}));

import { Comments, DRAFT_MENTION_TOAST } from '@/components/comments/Comments';
import { commentMentionCandidates } from '@/components/comments/mention-scope';
import { MentionPicker } from '@/components/chat/MentionPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mount(props: { entityType: 'post' | 'brief'; postStage?: string }): Promise<void> {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType={props.entityType}
        entityId="entity-1"
        {...(props.postStage !== undefined ? { postStage: props.postStage } : {})}
      />,
    );
  });
  await settle();
}

function lastComposer(): ComposerProps {
  const props = composers[composers.length - 1];
  if (props === undefined) throw new Error('no composer rendered');
  return props;
}

function offeredIds(): string[] {
  return lastComposer().members.map((m) => m.id);
}

beforeEach(() => {
  composers.length = 0;
  toasts.length = 0;
  createSpy.mockReset();
  createSpy.mockResolvedValue({ ok: true, data: 'new-comment' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('comment mention picker on a draft post', () => {
  it('does not offer clients when the post is a draft', async () => {
    await mount({ entityType: 'post', postStage: 'draft' });
    expect(offeredIds()).toEqual([AGENT, OWNER]);
  });

  it('offers clients once the post is in Review', async () => {
    await mount({ entityType: 'post', postStage: 'review' });
    expect(offeredIds()).toEqual([AGENT, OWNER, CLIENT]);
  });

  it('offers clients on brief comments', async () => {
    await mount({ entityType: 'brief' });
    expect(offeredIds()).toEqual([AGENT, OWNER, CLIENT]);
  });

  it('the scope helper only narrows a draft post', () => {
    expect(
      commentMentionCandidates(MEMBERS, { entityType: 'post', postStage: 'draft' }).map(
        (m) => m.id,
      ),
    ).toEqual([AGENT, OWNER]);
    for (const postStage of ['review', 'approved', 'parked', 'rejected', undefined]) {
      expect(commentMentionCandidates(MEMBERS, { entityType: 'post', postStage })).toEqual(MEMBERS);
    }
    expect(commentMentionCandidates(MEMBERS, { entityType: 'brief', postStage: 'draft' })).toEqual(
      MEMBERS,
    );
  });

  it('leaves chat mentions alone: the chat MentionPicker still lists a client', () => {
    const html = renderToStaticMarkup(
      <MentionPicker
        members={[
          {
            userId: CLIENT,
            displayName: 'Cara Client',
            username: 'cara',
            avatarUrl: null,
            role: 'client',
          },
        ]}
        active={0}
        onPick={() => undefined}
      />,
    );
    expect(html).toContain(`data-mention-option="${CLIENT}"`);
    expect(html).toContain('Cara Client');
  });
});

describe('invalid_mention from comment_create', () => {
  it('keeps the draft and shows the one toast', async () => {
    createSpy.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_mention', message: 'invalid_mention', details: CLIENT },
    });
    await mount({ entityType: 'post', postStage: 'draft' });

    let result: CommentSubmitResult | undefined;
    await act(async () => {
      result = await lastComposer().onSubmit(`over to @[${CLIENT}]`, {
        attachmentVersionIds: ['ver-1'],
      });
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Not ok, so the composer keeps the text and the attachments; nothing inline.
    expect(result).toEqual({ ok: false, notified: true });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe("Clients can't see drafts. Tag them once it's in Review.");
    expect(DRAFT_MENTION_TOAST).toBe("Clients can't see drafts. Tag them once it's in Review.");
  });

  it('invalid_mention on a post that is not a draft keeps the generic inline copy, no toast', async () => {
    createSpy.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_mention', message: 'invalid_mention', details: CLIENT },
    });
    await mount({ entityType: 'post', postStage: 'review' });

    let result: CommentSubmitResult | undefined;
    await act(async () => {
      result = await lastComposer().onSubmit(`over to @[${CLIENT}]`, {
        attachmentVersionIds: [],
      });
    });

    expect(result?.ok).toBe(false);
    expect(result !== undefined && 'error' in result).toBe(true);
    if (result !== undefined && 'error' in result) {
      expect(result.error).not.toBe(DRAFT_MENTION_TOAST);
    }
    expect(toasts).toHaveLength(0);
  });

  it('other failures still come back as inline error copy, with no toast', async () => {
    createSpy.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_payload', message: 'invalid_payload' },
    });
    await mount({ entityType: 'post', postStage: 'review' });

    let result: CommentSubmitResult | undefined;
    await act(async () => {
      result = await lastComposer().onSubmit('hello', { attachmentVersionIds: [] });
    });

    expect(result?.ok).toBe(false);
    expect(result !== undefined && 'error' in result).toBe(true);
    expect(toasts).toHaveLength(0);
  });
});
