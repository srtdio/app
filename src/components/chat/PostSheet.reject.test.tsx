// @vitest-environment jsdom
// The stateful chat post sheet in a live DOM (phone): its decisions are Post
// detail's own (pcs/use-post-decisions). The approver's Reject sits in the
// sheet's bottom bar, asks for an optional reason, moves the post through the
// stage RPC and posts the reason as a comment; the creator's Park and "Approve
// on their behalf" live in the ⋯ menu with Open post and Copy link; "Send for
// review again" with open comments asks first and never blocks.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastShow: vi.fn(),
  rpcStageTransition: vi.fn(),
  postsStageTransition: vi.fn(),
  runCreateCommentBatch: vi.fn(),
  createComment: vi.fn(),
  runPostReadyNotify: vi.fn(),
  openCount: 0,
  laptop: false,
  workspaceKey: 'GBL' as string | null,
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => {
  // The open-comment count read: a head count that resolves { count }.
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is']) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => void) =>
    resolve({ count: mocks.openCount, error: null });
  return { supabase: { auth: { getSession: vi.fn() }, from: () => chain } };
});
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'ws-1',
    workspaceName: 'Zomato',
    workspaceKey: mocks.workspaceKey,
    workspaces: [{ id: 'ws-1', timezone: 'UTC' }],
  }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => mocks.laptop }));
vi.mock('@/components/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toast')>()),
  useToast: () => ({ show: mocks.toastShow, dismiss: vi.fn() }),
}));
vi.mock('../../../packages/posts/src/reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/posts/src/reads')>()),
  getPostGallery: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  stageTransition: mocks.rpcStageTransition,
}));
vi.mock('@srtdio/posts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/posts')>()),
  stageTransition: mocks.postsStageTransition,
}));
vi.mock('@srtdio/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/comments')>()),
  createComment: mocks.createComment,
}));
vi.mock('@/components/comments/Comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/comments/Comments')>()),
  runCreateCommentBatch: mocks.runCreateCommentBatch,
}));
vi.mock('@/components/pages/pcs/PostReadyNotice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/pages/pcs/PostReadyNotice')>()),
  runPostReadyNotify: mocks.runPostReadyNotify,
}));
vi.mock('@/components/pages/pcs/use-approvers', () => ({
  useWorkspaceApprovers: () => [{ userId: 'u7', name: 'Asha' }],
}));
vi.mock('@/components/pages/pcs/ConversationPicker', () => ({ ConversationPicker: () => null }));

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
  mocks.openCount = 0;
  mocks.laptop = false;
  for (const fn of [
    mocks.navigate,
    mocks.toastShow,
    mocks.rpcStageTransition,
    mocks.postsStageTransition,
    mocks.runCreateCommentBatch,
    mocks.createComment,
    mocks.runPostReadyNotify,
  ]) {
    fn.mockReset();
  }
  mocks.rpcStageTransition.mockResolvedValue({ ok: true, data: 'p1' });
  mocks.postsStageTransition.mockResolvedValue({ ok: true, data: 'p1' });
  mocks.runCreateCommentBatch.mockResolvedValue({ ok: true, data: [{ id: 'c1', seq: 1 }] });
  mocks.createComment.mockResolvedValue({ ok: true, data: 'c1' });
  mocks.runPostReadyNotify.mockResolvedValue({ ok: true, data: undefined });
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

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(side: ViewerSide, v: PostView): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PostSheet
        open
        onClose={vi.fn()}
        view={v}
        side={side}
        timeZone="UTC"
        cache={cache}
        deps={presignDeps}
        presignEnabled={false}
      />,
    );
  });
  await settle();
}

const q = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

async function press(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
  });
  await settle();
}

function buttonNamed(label: string, scope: Document | Element = document): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function dialogTitled(title: string): Element | undefined {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(
    (d) => d.getAttribute('aria-label') === title || d.querySelector('h2')?.textContent === title,
  );
}

/** The ⋯ menu's row labels (phone: a Sheet titled "Post actions"). */
async function openMenu(): Promise<string[]> {
  await press(q('[aria-label="More actions"]'));
  const menu = dialogTitled('Post actions');
  return [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(
    (b) => b.querySelector('.font-medium')?.textContent ?? '',
  );
}

function type(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function barLabels(): string[] {
  return [...(q('[data-decision-bar]')?.querySelectorAll('button') ?? [])].map(
    (b) => b.textContent?.trim() ?? '',
  );
}

describe('the ⋯ menu', () => {
  it('Open post first, then Copy link; Open post goes to the pretty /p/key-n link', async () => {
    await render('client', view(row()));
    expect(await openMenu()).toEqual(['Open post', 'Copy link']);
    await press(buttonNamed('Open post', dialogTitled('Post actions')));
    expect(mocks.navigate).toHaveBeenCalledWith('/p/gbl-142');
  });

  it('falls back to /posts/:id while the workspace key is unknown', async () => {
    mocks.workspaceKey = null;
    await render('agency', view(row({ stage: 'approved' })));
    await openMenu();
    await press(buttonNamed('Open post', dialogTitled('Post actions')));
    expect(mocks.navigate).toHaveBeenCalledWith('/posts/p1');
  });

  it("the creator's moves sit after Copy link, exactly as on Post detail", async () => {
    await render('agency', view(row()));
    expect(await openMenu()).toEqual([
      'Open post',
      'Copy link',
      'Approve on their behalf',
      'Reject',
      'Park',
    ]);
  });
});

describe('approver Reject (phone: the bottom bar)', () => {
  it('Reject then Approve in the bar, Reject with the bad ink and no red fill', async () => {
    await render('client', view(row()));
    expect(barLabels()).toEqual(['Reject', 'Approve']);
    const reject = buttonNamed('Reject', q('[data-decision-bar]')!);
    expect(reject?.className).toContain('text-bad');
    expect(reject?.className).not.toContain('bg-bad-solid');
  });

  it('asks first with the creator, the optional reason, Cancel and Reject', async () => {
    await render('client', view(row(), { creatorName: 'Priya Shah' }));
    await press(buttonNamed('Reject', q('[data-decision-bar]')!));
    const confirm = dialogTitled('Reject this post?');
    expect(confirm).toBeDefined();
    expect(confirm?.querySelector('[data-stage-confirm-body]')?.textContent).toBe(
      'Priya gets it back to rework.',
    );
    expect(confirm?.querySelector('textarea')?.getAttribute('aria-label')).toBe(
      'Reason (optional)',
    );
    expect(buttonNamed('Cancel', confirm!)).toBeDefined();
    expect(mocks.rpcStageTransition).not.toHaveBeenCalled();
  });

  it('confirm moves review to rejected, then posts the reason as a checkpoint', async () => {
    await render('client', view(row()));
    await press(buttonNamed('Reject', q('[data-decision-bar]')!));
    const field = dialogTitled('Reject this post?')?.querySelector('textarea');
    if (field) type(field, '  Wrong logo  ');
    await press(q('[data-stage-confirm]'));
    expect(mocks.rpcStageTransition).toHaveBeenCalledTimes(1);
    expect(mocks.rpcStageTransition).toHaveBeenCalledWith(expect.anything(), {
      p_post_id: 'p1',
      p_to_stage: 'rejected',
      p_trace_id: 'trace-1',
    });
    expect(mocks.runCreateCommentBatch).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-1',
      postId: 'p1',
      points: [{ body: 'Wrong logo' }],
      traceId: 'trace-1',
    });
  });

  it('an approved post can be rejected; no reason means no comment', async () => {
    await render('client', view(row({ stage: 'approved' })));
    expect(barLabels()).toEqual(['Reject']);
    await press(buttonNamed('Reject', q('[data-decision-bar]')!));
    await press(q('[data-stage-confirm]'));
    expect(mocks.rpcStageTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ p_to_stage: 'rejected' }),
    );
    expect(mocks.runCreateCommentBatch).not.toHaveBeenCalled();
  });

  it('a refused move shows plain words once, in the bar, never the server text', async () => {
    mocks.rpcStageTransition.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'raw server text' },
    });
    await render('client', view(row()));
    await press(buttonNamed('Reject', q('[data-decision-bar]')!));
    await press(q('[data-stage-confirm]'));
    expect(q('[data-decision-error]')?.textContent).toBe("Couldn't move the post. Try again.");
    expect(document.body.textContent).not.toContain('raw server text');
    expect(mocks.runCreateCommentBatch).not.toHaveBeenCalled();
  });
});

describe('creator moves', () => {
  it('Park from the ⋯ menu asks for a reason, then parks', async () => {
    await render('agency', view(row({ stage: 'draft' })));
    expect(barLabels()).toEqual(['Send for review']);
    expect(await openMenu()).toEqual(['Open post', 'Copy link', 'Park']);
    await press(buttonNamed('Park', dialogTitled('Post actions')));
    expect(dialogTitled('Park this post?')).toBeDefined();
    await press(q('[data-stage-confirm]'));
    expect(mocks.rpcStageTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ p_to_stage: 'parked' }),
    );
  });

  it('Approve on their behalf opens the approver picker and approves for the first one', async () => {
    await render('agency', view(row()));
    await openMenu();
    await press(buttonNamed('Approve on their behalf', dialogTitled('Post actions')));
    expect(q('[data-on-behalf-sheet]')).not.toBeNull();
    const cancel = q('[data-on-behalf-cancel]');
    const approve = q('[data-on-behalf-approve]');
    // Cancel is ghost, left of the primary.
    expect(cancel?.compareDocumentPosition(approve!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await press(approve);
    expect(mocks.postsStageTransition).toHaveBeenCalledWith(expect.anything(), {
      postId: 'p1',
      toStage: 'approved',
      traceId: 'trace-1',
      onBehalfOf: 'u7',
    });
  });

  it('Send for review again with open comments asks first, and Send anyway sends', async () => {
    mocks.openCount = 2;
    await render('agency', view(row()));
    expect(barLabels()).toEqual(['Send for review again']);
    await press(buttonNamed('Send for review again', q('[data-decision-bar]')!));
    const warn = dialogTitled('2 comments are still open. Send anyway?');
    expect(warn).toBeDefined();
    expect(mocks.runPostReadyNotify).not.toHaveBeenCalled();
    await press(buttonNamed('Send anyway', warn!));
    expect(mocks.runPostReadyNotify).toHaveBeenCalledOnce();
  });

  it('with no open comments it sends straight away', async () => {
    await render('agency', view(row()));
    await press(buttonNamed('Send for review again', q('[data-decision-bar]')!));
    expect(mocks.runPostReadyNotify).toHaveBeenCalledOnce();
  });
});

describe('laptop: the row sits at the right of the title, beside the ⋯', () => {
  it('no bottom bar; the buttons are in the title row', async () => {
    mocks.laptop = true;
    await render('client', view(row()));
    expect(q('[data-decision-bar]')).toBeNull();
    const aside = q('[data-sheet-title-aside]');
    expect(
      [...(aside?.querySelectorAll('[data-header-decision] button') ?? [])].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(['Reject', 'Approve']);
    expect(aside?.querySelector('[aria-label="More actions"]')).not.toBeNull();
  });
});
