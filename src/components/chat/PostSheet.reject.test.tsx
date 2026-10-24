// @vitest-environment jsdom
// The stateful chat post sheet in a live DOM: "Open post" goes to the pretty
// /p/<key>-<number> link, and an approver's Reject asks first (with an optional
// reason), moves the post through the same stage call Approve uses, then posts
// the typed reason through the post page's comment write.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastShow: vi.fn(),
  stageTransition: vi.fn(),
  runCreateCommentBatch: vi.fn(),
  workspaceKey: 'GBL' as string | null,
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'ws-1',
    workspaceName: 'Zomato',
    workspaceKey: mocks.workspaceKey,
  }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/components/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toast')>()),
  useToast: () => ({ show: mocks.toastShow, dismiss: vi.fn() }),
}));
vi.mock('../../../packages/posts/src/reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/posts/src/reads')>()),
  getPostGallery: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('../../../packages/posts/src/stage-machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/posts/src/stage-machine')>()),
  stageTransition: mocks.stageTransition,
}));
vi.mock('@/components/comments/Comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/comments/Comments')>()),
  runCreateCommentBatch: mocks.runCreateCommentBatch,
}));

import type { PostCardRow } from '../../../packages/posts/src/reads';
import { PostSheet } from '@/components/chat/PostSheet';
import type { SharedPostView } from '@/components/chat/post-card';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { PresignCache } from '@/lib/asset-presign';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PostView = Extract<SharedPostView, { kind: 'post' }>;

const presignDeps = {
  endpoint: null,
  getAccessToken: async () => null,
  fetcher: async () => new Response(null),
};
const cache = new PresignCache(presignDeps);

let root: Root | null = null;

beforeEach(() => {
  mocks.workspaceKey = 'GBL';
  mocks.navigate.mockReset();
  mocks.toastShow.mockReset();
  mocks.stageTransition.mockReset();
  mocks.runCreateCommentBatch.mockReset();
  mocks.stageTransition.mockResolvedValue({ ok: true, data: 'p1' });
  mocks.runCreateCommentBatch.mockResolvedValue({ ok: true, data: [{ id: 'c1', seq: 1 }] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function row(over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id: 'p1',
    number: 142,
    title: 'Diwali launch',
    platform: 'instagram',
    format: 'carousel',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

function view(post: PostCardRow, over: Partial<PostView> = {}): PostView {
  return { kind: 'post', postId: post.id, post, approverName: null, ...over };
}

const onClose = vi.fn();

async function render(side: ViewerSide, v: PostView): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PostSheet
        open
        onClose={onClose}
        view={v}
        side={side}
        timeZone="UTC"
        cache={cache}
        deps={presignDeps}
        presignEnabled={false}
      />,
    );
  });
}

const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

async function click(selector: string): Promise<void> {
  const el = q(selector);
  expect(el).not.toBeNull();
  await act(async () => {
    el?.click();
  });
}

function type(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Open post', () => {
  it('the agency button reads "Open post" and navigates to the pretty /p/key-n link', async () => {
    await render('agency', view(row({ stage: 'draft' })));
    const button = q('[data-sheet-action="open_pipeline"]');
    expect(button?.textContent).toBe('Open post');
    expect(document.body.textContent).not.toContain('Open in pipeline');
    await click('[data-sheet-action="open_pipeline"]');
    expect(mocks.navigate).toHaveBeenCalledWith('/p/gbl-142');
  });

  it('falls back to /posts/:id while the workspace key is unknown', async () => {
    mocks.workspaceKey = null;
    await render('agency', view(row({ stage: 'approved' })));
    await click('[data-sheet-action="open_pipeline"]');
    expect(mocks.navigate).toHaveBeenCalledWith('/posts/p1');
  });
});

describe('approver Reject', () => {
  it('sits next to Approve and Comment in review, with the bad token', async () => {
    await render('client', view(row()));
    const ids = [...document.querySelectorAll('[data-sheet-action]')].map((el) =>
      el.getAttribute('data-sheet-action'),
    );
    expect(ids).toEqual(['approve', 'reject', 'comment', 'open_post']);
    const reject = q('[data-sheet-action="reject"]');
    expect(reject?.textContent).toBe('Reject');
    expect(reject?.className).toContain('text-bad');
    expect(reject?.className).toContain('h-11');
    expect(reject?.className).toContain('rounded-lg');
    expect(reject?.className).not.toContain('bg-bad-solid');
  });

  it('the agency side gets no Reject', async () => {
    await render('agency', view(row()));
    expect(q('[data-sheet-action="reject"]')).toBeNull();
  });

  it('asks first with the creator, the reason field, Cancel and Reject', async () => {
    await render('client', view(row(), { creatorName: 'Priya Shah' }));
    await click('[data-sheet-action="reject"]');
    const confirm = q('[data-sheet-confirm="reject"]');
    expect(confirm).not.toBeNull();
    const text = confirm?.textContent ?? '';
    expect(text).toContain('Reject this post?');
    expect(text).toContain('Priya gets it back to rework. You can send a reason.');
    expect(text).toContain('Reason (optional)');
    expect(text).toContain('Goes to the comments.');
    const buttons = [...(confirm?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Reject']);
    expect(q('[data-sheet-reject-confirm]')?.className).toContain('text-bad');
    expect(q('[data-sheet-reject-confirm]')?.className).not.toContain('bg-bad-solid');
    expect(text).not.toMatch(/client|agency/i);
    expect(mocks.stageTransition).not.toHaveBeenCalled();
  });

  it('with no creator name on hand it reads "The creator"', async () => {
    await render('client', view(row()));
    await click('[data-sheet-action="reject"]');
    expect(q('[data-sheet-confirm="reject"]')?.textContent).toContain(
      'The creator gets it back to rework. You can send a reason.',
    );
  });

  it('confirm moves review to rejected, then posts the reason as a comment', async () => {
    await render('client', view(row()));
    await click('[data-sheet-action="reject"]');
    const field = q<HTMLTextAreaElement>('[data-sheet-reason]');
    expect(field).not.toBeNull();
    if (field !== null) type(field, '  Wrong logo  ');
    await click('[data-sheet-reject-confirm]');
    expect(mocks.stageTransition).toHaveBeenCalledTimes(1);
    expect(mocks.stageTransition).toHaveBeenCalledWith(expect.anything(), {
      postId: 'p1',
      toStage: 'rejected',
      traceId: 'trace-1',
    });
    expect(mocks.runCreateCommentBatch).toHaveBeenCalledTimes(1);
    expect(mocks.runCreateCommentBatch).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-1',
      postId: 'p1',
      points: [{ body: 'Wrong logo' }],
      traceId: 'trace-1',
    });
    expect(mocks.toastShow).toHaveBeenCalledWith({ title: 'Post rejected' });
  });

  it('an approved post can be rejected; no reason means no comment', async () => {
    await render('client', view(row({ stage: 'approved' })));
    await click('[data-sheet-action="reject"]');
    await click('[data-sheet-reject-confirm]');
    expect(mocks.stageTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toStage: 'rejected' }),
    );
    expect(mocks.runCreateCommentBatch).not.toHaveBeenCalled();
  });

  it('a refused move shows the fixed line, never the server text', async () => {
    mocks.stageTransition.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_stage_transition', message: 'raw server text' },
    });
    await render('client', view(row()));
    await click('[data-sheet-action="reject"]');
    await click('[data-sheet-reject-confirm]');
    const alert = q('[data-sheet-error]');
    expect(alert?.textContent).toBe("Couldn't move the post. Try again.");
    expect(document.body.textContent).not.toContain('raw server text');
    expect(mocks.runCreateCommentBatch).not.toHaveBeenCalled();
  });

  it('Cancel goes back to the actions without moving the post', async () => {
    await render('client', view(row()));
    await click('[data-sheet-action="reject"]');
    const cancel = [...document.querySelectorAll('[data-sheet-confirm="reject"] button')].find(
      (b) => b.textContent === 'Cancel',
    );
    await act(async () => {
      (cancel as HTMLButtonElement | undefined)?.click();
    });
    expect(q('[data-sheet-confirm="reject"]')).toBeNull();
    expect(q('[data-sheet-action="reject"]')).not.toBeNull();
    expect(mocks.stageTransition).not.toHaveBeenCalled();
  });
});
