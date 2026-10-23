// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';

// Post flow B regressions on the post screen, part 3a: 30 (approver row:
// Comment, Reject, Approve, one row per breakpoint), 31 (no primary Approve for
// creators; "Approve on their behalf" in the ⋯ sheet), 33 (the creator's one
// main button, never blocked by open comments, and the single open count), 37 (approved lock and banner), 40 (reject
// confirm copy), 41 (plain-words errors, once, where tapped). Heavy children
// (gallery, comments, action sheet) are stubbed and their props captured.

type CountsFn = (c: { open: number; resolved: number }) => void;
type MoveRowLike = { key: string; label: string; onPick: () => void };

const h = vi.hoisted(() => ({
  stage: 'review' as string,
  role: 'agency' as string | null,
  desktop: true,
  counts: { open: 0, resolved: 0 },
  approvedBy: null as string | null,
  approvedAt: null as string | null,
  galleryProps: null as null | { tools?: { canEdit: boolean } },
  actionSheetProps: null as null | { moveRows?: MoveRowLike[] },
  commentsProps: null as null | { onCountsChange?: CountsFn },
  detailsSheetProps: null as null | { lockedFields?: boolean },
  transitionResult: { ok: true, data: undefined } as unknown,
}));

const { stageTransition, runPostReadyNotify, postCaptionUpdate } = vi.hoisted(() => ({
  stageTransition: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => h.transitionResult),
  runPostReadyNotify: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: undefined,
  })),
  postCaptionUpdate: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    data: undefined,
  })),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({
    workspaceId: 'w1',
    workspaceKey: 'GBL',
    workspaces: [{ id: 'w1', timezone: 'Asia/Kolkata' }],
    workspaceName: 'Kite and Co',
  }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'u1' } } }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => h.desktop }));
vi.mock('@/lib/search/jump', () => ({ useSearchJump: () => ({ words: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({
    options: [
      { userId: 'u2', displayName: 'Riya Menon', avatarUrl: null },
      { userId: 'u3', displayName: 'Meera Shah', avatarUrl: null },
    ],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/lib/buckets', () => ({
  listBuckets: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assets')>();
  return {
    ...actual,
    fetchMemberRole: async () => h.role,
    listAssets: async () => ({ ok: true, data: [] }),
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        order: async () => ({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('@srtdio/posts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/posts')>();
  return {
    ...actual,
    getPost: async () => ({
      ok: true,
      data: {
        post: {
          id: 'p1',
          workspace_id: 'w1',
          number: 101,
          title: 'Monsoon drop: linen in rain',
          caption: 'Linen that breathes.',
          stage: h.stage,
          platform: 'instagram',
          format: 'carousel',
          target_date: null,
          owner_user_id: 'u2',
          legacy_author_name: null,
          bucket_id: null,
          brief_id: null,
          origin: 'direct',
          approved_by: h.approvedBy,
          approved_at: h.approvedAt,
          updated_at: '2026-10-23T08:00:00.000Z',
          stage_entered_at: '2026-10-23T08:00:00.000Z',
        },
        versions: [],
        annotations: [],
      },
    }),
    getPostGallery: async () => ({ ok: true, data: [] }),
    postCaptionUpdate,
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return { ...actual, stageTransition };
});
vi.mock('@/components/pages/pcs/PostReadyNotice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostReadyNotice')>();
  return { ...actual, runPostReadyNotify };
});
vi.mock('@/components/pages/pcs/PostGallery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/PostGallery')>();
  return {
    ...actual,
    PostGallery: (props: { tools?: { canEdit: boolean } }) => {
      h.galleryProps = props;
      return <div data-gallery-stub="">gallery</div>;
    },
  };
});
vi.mock('@/components/comments/Comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/comments/Comments')>();
  const { useEffect } = await import('react');
  return {
    ...actual,
    Comments: (props: { onCountsChange?: CountsFn }) => {
      h.commentsProps = props;
      const { onCountsChange } = props;
      useEffect(() => {
        onCountsChange?.(h.counts);
      }, [onCountsChange]);
      return (
        <div data-comments-composer="">
          <textarea aria-label="Write a comment" />
        </div>
      );
    },
  };
});
vi.mock('@/components/pages/pcs/CheckpointStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/pages/pcs/CheckpointStrip')>();
  return { ...actual, CheckpointStrip: () => null };
});
vi.mock('@/components/pages/pcs/PostActionSheet', () => ({
  PostActionSheet: (props: { moveRows?: MoveRowLike[] }) => {
    h.actionSheetProps = props;
    return null;
  },
}));
vi.mock('@/components/pages/pcs/PostDetailsSheet', () => ({
  PostDetailsSheet: (props: { lockedFields?: boolean }) => {
    h.detailsSheetProps = props;
    return null;
  },
}));
vi.mock('@/components/pages/pcs/VersionHistorySheet', () => ({ VersionHistorySheet: () => null }));
vi.mock('@/components/pages/assets/AssetUploadSheet', () => ({ AssetUploadSheet: () => null }));
vi.mock('@/components/preview/PlatformPreviewPanel', () => ({
  PlatformPreviewPanel: () => null,
  PreviewChip: () => null,
}));

import {
  APPROVE_ON_BEHALF_LABEL,
  APPROVED_LOCKED_COPY,
  PostDetailPage,
  SENT_AGAIN_TOAST,
  UNKNOWN_ERROR_COPY,
  approvedByLine,
  postActionErrorCopy,
  rejectConfirmBody,
  sendAgainErrorCopy,
  sendAnywayTitle,
} from '@/components/pages/PostDetailPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(withToasts = false): Promise<void> {
  const page = (
    <MemoryRouter initialEntries={['/posts/p1']}>
      <PostDetailPage postId="p1" />
    </MemoryRouter>
  );
  await act(async () => {
    root?.render(
      withToasts ? (
        <ToastProvider>
          {page}
          <ToastViewport />
        </ToastProvider>
      ) : (
        page
      ),
    );
  });
  await settle();
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
  });
  await settle();
}

function text(): string {
  return document.body.textContent ?? '';
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function buttonsIn(selector: string): HTMLButtonElement[] {
  const scope = document.querySelector(selector);
  return scope === null ? [] : [...scope.querySelectorAll('button')];
}

function byText(
  label: string,
  scope: Element | Document = document,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  h.stage = 'review';
  h.role = 'agency';
  h.desktop = true;
  h.counts = { open: 0, resolved: 0 };
  h.approvedBy = null;
  h.approvedAt = null;
  h.galleryProps = null;
  h.actionSheetProps = null;
  h.commentsProps = null;
  h.detailsSheetProps = null;
  h.transitionResult = { ok: true, data: undefined };
  stageTransition.mockClear();
  runPostReadyNotify.mockClear();
  postCaptionUpdate.mockClear();
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('30. approver row: Comment, Reject, Approve', () => {
  it('laptop: the row sits inline in the decision slot (above the caption), and no phone bar', async () => {
    h.role = 'client';
    await render();
    const row = document.querySelector('[data-decision-row]');
    expect(row).not.toBeNull();
    expect(document.querySelector('[data-decision-bar]')).toBeNull();
    expect(buttonsIn('[data-decision-row]').map((b) => b.textContent?.trim())).toEqual([
      'Comment',
      'Reject',
      'Approve',
    ]);
    const caption = document.querySelector('[data-caption-block]');
    expect(row!.compareDocumentPosition(caption!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('phone: the same row in the sticky bar only, and Comment focuses the comment box', async () => {
    h.role = 'client';
    h.desktop = false;
    await render();
    expect(document.querySelector('[data-decision-row]')).toBeNull();
    const bar = document.querySelector('[data-decision-bar]');
    expect(bar).not.toBeNull();
    expect(buttonsIn('[data-decision-bar]').map((b) => b.textContent?.trim())).toEqual([
      'Comment',
      'Reject',
      'Approve',
    ]);
    await click(byText('Comment', bar!));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Write a comment');
  });
});

describe('31. creators never get a primary Approve', () => {
  it('"Approve on their behalf" (never "Approve for {brand}", even with a workspace name) sits in the ⋯ sheet and opens the on-behalf approve confirm', async () => {
    await render();
    expect(buttonsIn('[data-decision-row]').map((b) => b.textContent?.trim())).toEqual([
      'Send for review again',
    ]);
    expect(byText('Approve')).toBeUndefined();
    const rows = h.actionSheetProps?.moveRows ?? [];
    expect(rows.map((r) => r.label)).toEqual(['Approve on their behalf', 'Reject', 'Park']);
    expect(APPROVE_ON_BEHALF_LABEL).toBe('Approve on their behalf');
    expect(rows.some((r) => r.label.startsWith('Approve for'))).toBe(false);

    await act(async () => {
      rows[0]?.onPick();
      await new Promise((r) => setTimeout(r, 30));
    });
    await settle();
    expect(document.querySelector('[data-approve-on-behalf]')?.textContent).toBe(
      'You are approving on behalf of Kite and Co.',
    );
    expect(stageTransition).not.toHaveBeenCalled();
  });
});

describe("33. the creator's one main button and the single open count", () => {
  it('open comments never disable it or add a helper line; the chip reads the same count', async () => {
    h.counts = { open: 2, resolved: 1 };
    await render();
    const main = document.querySelector<HTMLButtonElement>('[data-decision-main]');
    expect(main?.textContent?.trim()).toBe('Send for review again');
    expect(main?.disabled).toBe(false);
    expect(document.querySelector('[data-decision-helper]')).toBeNull();
    expect(text()).not.toContain('Resolve');
    // The chip reads the same count.
    expect(document.querySelector('[data-open-comments-chip]')?.textContent).toContain(
      '2 open comments',
    );
    // The separate bottom notice is gone.
    expect(text()).not.toContain("Tell approvers it's ready");
  });

  it('with open comments a tap asks first: plural title, Cancel sends nothing', async () => {
    h.counts = { open: 2, resolved: 0 };
    await render();
    await click(document.querySelector('[data-decision-main]'));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe(
      '2 comments are still open. Send anyway?',
    );
    expect(byText('Send anyway', dialog!)).toBeDefined();
    await click(byText('Cancel', dialog!));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(runPostReadyNotify).not.toHaveBeenCalled();
  });

  it('singular title; "Send anyway" calls post_ready_notify once and shows the success copy', async () => {
    h.counts = { open: 1, resolved: 0 };
    await render(true);
    await click(document.querySelector('[data-decision-main]'));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.querySelector('h2')?.textContent).toBe('1 comment is still open. Send anyway?');
    expect(runPostReadyNotify).not.toHaveBeenCalled();
    await click(byText('Send anyway', dialog!));
    expect(runPostReadyNotify).toHaveBeenCalledOnce();
    expect(runPostReadyNotify.mock.calls[0]?.[1]).toEqual({ postId: 'p1', traceId: 'trace-1' });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(text()).toContain('Sent for review again.');
    expect(SENT_AGAIN_TOAST).toBe('Sent for review again.');
    expect(sendAnywayTitle(1)).toBe('1 comment is still open. Send anyway?');
    expect(sendAnywayTitle(3)).toBe('3 comments are still open. Send anyway?');
  });

  it('with 0 open it sends straight away, no confirm', async () => {
    h.counts = { open: 0, resolved: 3 };
    await render();
    const live = document.querySelector<HTMLButtonElement>('[data-decision-main]');
    expect(live?.disabled).toBe(false);
    expect(document.querySelector('[data-open-comments-chip]')).toBeNull();
    await click(live);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(runPostReadyNotify).toHaveBeenCalledOnce();
    expect(runPostReadyNotify.mock.calls[0]?.[1]).toEqual({ postId: 'p1', traceId: 'trace-1' });
  });

  it('disabled only while the send is in flight', async () => {
    let finish: (v: unknown) => void = () => {};
    runPostReadyNotify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click(document.querySelector('[data-decision-main]'));
    expect(document.querySelector<HTMLButtonElement>('[data-decision-main]')?.disabled).toBe(true);
    await act(async () => {
      finish({ ok: true, data: undefined });
    });
    await settle();
    expect(document.querySelector<HTMLButtonElement>('[data-decision-main]')?.disabled).toBe(false);
    expect(runPostReadyNotify).toHaveBeenCalledOnce();
  });

  it('a draft offers "Send for review" as the one main button', async () => {
    h.stage = 'draft';
    await render();
    expect(buttonsIn('[data-decision-row]').map((b) => b.textContent?.trim())).toEqual([
      'Send for review',
    ]);
    expect((h.actionSheetProps?.moveRows ?? []).map((r) => r.label)).toEqual(['Park']);
  });

  it('a refused send shows plain words once, in the row', async () => {
    h.counts = { open: 0, resolved: 1 };
    runPostReadyNotify.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'some raw text' },
    });
    await render();
    await click(document.querySelector('[data-decision-main]'));
    expect(count(text(), UNKNOWN_ERROR_COPY)).toBe(1);
    expect(text()).not.toContain('some raw text');
    // Open comments no longer block the proc; a stray checkpoints_open falls to
    // the unknown copy.
    expect(sendAgainErrorCopy('checkpoints_open')).toBe(UNKNOWN_ERROR_COPY);
  });
});

describe('37. approved posts are locked', () => {
  it('no title pencil, no caption Edit, no gallery tools; details keep date and bucket only; the banner says how', async () => {
    h.stage = 'approved';
    h.approvedBy = 'u3';
    h.approvedAt = '2026-10-21T06:00:00.000Z';
    await render();
    expect(document.querySelector('[aria-label="Edit title"]')).toBeNull();
    expect(document.querySelector('[data-caption-edit]')).toBeNull();
    expect(h.galleryProps?.tools?.canEdit).toBe(false);
    expect(h.detailsSheetProps?.lockedFields).toBe(true);
    // Details Edit stays (due date and bucket).
    expect(document.querySelector('[data-post-details]')?.tagName).toBe('BUTTON');
    const banner = document.querySelector('[data-approved-banner]');
    expect(banner?.textContent).toContain('Approved by Meera Shah on 21 Oct.');
    expect(banner?.textContent).toContain(
      "Approved posts can't be edited. To change it, park it first, then send it for review again.",
    );
    // Banner under the title and details.
    const details = document.querySelector('[data-post-details]');
    expect(details!.compareDocumentPosition(banner!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('an approver on an approved post still sees Reject', async () => {
    h.stage = 'approved';
    h.role = 'client';
    await render();
    expect(buttonsIn('[data-decision-row]').map((b) => b.textContent?.trim())).toContain('Reject');
  });

  it('a draft keeps every edit path and shows no banner', async () => {
    h.stage = 'draft';
    await render();
    expect(document.querySelector('[aria-label="Edit title"]')).not.toBeNull();
    expect(document.querySelector('[data-caption-edit]')).not.toBeNull();
    expect(h.galleryProps?.tools?.canEdit).toBe(true);
    expect(h.detailsSheetProps?.lockedFields).toBe(false);
    expect(document.querySelector('[data-approved-banner]')).toBeNull();
  });

  it('maps post_approved_locked to plain words; the banner lead needs both name and time', () => {
    expect(postActionErrorCopy({ code: 'unknown', message: 'post_approved_locked' })).toBe(
      APPROVED_LOCKED_COPY,
    );
    expect(APPROVED_LOCKED_COPY).toBe("Approved posts can't be edited.");
    expect(postActionErrorCopy({ code: 'unknown', message: 'P0001 boom' })).toBe(
      "Couldn't do that. Try again.",
    );
    expect(postActionErrorCopy(new Error('Failed to fetch'))).toBe(UNKNOWN_ERROR_COPY);
    expect(approvedByLine(null, '2026-10-21T06:00:00.000Z', 'UTC')).toBeNull();
    expect(approvedByLine('Meera Shah', null, 'UTC')).toBeNull();
  });

  it('the caption save maps the lock through the same copy', () => {
    const src = readFileSync(
      fileURLToPath(import.meta.url).replace(
        /PostDetailPage\.flowb3?\.test\.tsx$/,
        'PostDetailPage.tsx',
      ),
      'utf8',
    );
    expect(src).toContain('setCaptionError(postActionErrorCopy(result.error));');
    expect(src).toContain('push(postActionErrorCopy(result.error));');
  });
});

describe('40. reject confirm copy', () => {
  it('title, who gets it back, "Reason (optional)", "Goes to the comments.", Cancel and Reject', async () => {
    h.role = 'client';
    await render();
    await click(byText('Reject', document.querySelector('[data-decision-row]')!));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Reject this post?'),
    );
    expect(dialog).toBeDefined();
    expect(dialog?.querySelector('[data-stage-confirm-body]')?.textContent).toBe(
      'Riya gets it back to rework. You can send a reason.',
    );
    expect(dialog?.querySelector('textarea')?.getAttribute('aria-label')).toBe('Reason (optional)');
    expect(dialog?.querySelector('[data-stage-confirm-helper]')?.textContent).toBe(
      'Goes to the comments.',
    );
    expect(byText('Cancel', dialog!)).toBeDefined();
    expect(byText('Reject', dialog!)).toBeDefined();
    expect(rejectConfirmBody(null)).toBe(
      'The creator gets it back to rework. You can send a reason.',
    );
  });
});

describe('41. a failed approve shows once, inside the approve confirm', () => {
  it('unknown error reads "Couldn\'t do that. Try again." once, never the raw text', async () => {
    h.role = 'client';
    h.transitionResult = { ok: false, error: { code: 'unknown', message: 'pg raw boom' } };
    await render();
    await click(byText('Approve', document.querySelector('[data-decision-row]')!));
    await click(document.querySelector('[data-approve-confirm-button]'));
    expect(stageTransition).toHaveBeenCalledOnce();
    expect(count(text(), UNKNOWN_ERROR_COPY)).toBe(1);
    expect(document.querySelector('[data-approve-error]')?.textContent).toBe(UNKNOWN_ERROR_COPY);
    expect(document.querySelector('[data-decision-error]')).toBeNull();
    expect(text()).not.toContain('pg raw boom');
  });
});
