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
// confirm copy), 41 (plain-words errors, once, where tapped), and the spec B
// pass: the approved lock rows, banner and Move to Parked (B4), the client line
// (B5), the reject reason said once (B6) and the on-behalf sheet (D). Heavy
// children (gallery, comments, action sheet) are stubbed and their props
// captured.

type CountsFn = (c: { open: number; resolved: number }) => void;
type MoveRowLike = { key: string; label: string; sub?: string; onPick: () => void };

const h = vi.hoisted(() => ({
  stage: 'review' as string,
  role: 'agency' as string | null,
  desktop: true,
  wide: false,
  counts: { open: 0, resolved: 0 },
  approvedBy: null as string | null,
  approvedAt: null as string | null,
  galleryProps: null as null | { tools?: { canEdit: boolean; locked?: boolean } },
  actionSheetProps: null as null | { moveRows?: MoveRowLike[] },
  commentsProps: null as null | { onCountsChange?: CountsFn },
  detailsSheetProps: null as null | { lockedFields?: boolean },
  transitionResult: { ok: true, data: undefined } as unknown,
}));

// The on-behalf approve goes through @srtdio/posts' stageTransition (it carries onBehalfOf).
const { postsStageTransition } = vi.hoisted(() => ({
  postsStageTransition: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => h.transitionResult,
  ),
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
vi.mock('@/lib/use-media-query', () => ({
  useMediaQuery: (query: string) => (query === '(min-width: 1024px)' ? h.wide : h.desktop),
}));
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
    stageTransition: postsStageTransition,
  };
});
vi.mock('@/components/pages/pcs/use-approvers', () => ({
  useWorkspaceApprovers: () => [
    { userId: 'u7', name: 'Asha Rao' },
    { userId: 'u8', name: 'Dev Kapoor' },
  ],
}));
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
  APPROVED_LOCK_LINE,
  CLIENT_REVIEW_NOTE,
  MOVE_TO_PARKED_LABEL,
  PostDetailPage,
  REJECT_REASON_LABEL,
  SENT_AGAIN_TOAST,
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

const SEND_FAILED = "Couldn't send the post for review. Try again.";
const APPROVE_FAILED = "Couldn't approve the post. Try again.";

const scrollIntoView = vi.fn();

beforeEach(() => {
  h.stage = 'review';
  h.role = 'agency';
  h.desktop = true;
  h.wide = false;
  h.counts = { open: 0, resolved: 0 };
  h.approvedBy = null;
  h.approvedAt = null;
  h.galleryProps = null;
  h.actionSheetProps = null;
  h.commentsProps = null;
  h.detailsSheetProps = null;
  h.transitionResult = { ok: true, data: undefined };
  stageTransition.mockClear();
  postsStageTransition.mockClear();
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

  it('B5: the client line above Approve / Reject reads "Review and approve one post at a time."', async () => {
    h.role = 'client';
    await render();
    expect(CLIENT_REVIEW_NOTE).toBe('Review and approve one post at a time.');
    const row = document.querySelector('[data-decision-row]');
    expect(row?.textContent).toContain('Review and approve one post at a time.');
    expect(text()).not.toContain('Approval is deliberate');
    // Once on the page.
    expect(count(text(), CLIENT_REVIEW_NOTE)).toBe(1);
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
    // Spec D: the one on-behalf sheet, not the old confirm line.
    const sheet = document.querySelector('[data-on-behalf-sheet]')?.closest('[role="dialog"]');
    expect(sheet?.getAttribute('aria-label')).toBe('Approve on their behalf?');
    expect(document.querySelector('[data-approve-on-behalf]')).toBeNull();
    expect(text()).not.toContain('You are approving on behalf of');
    // No post title in the sheet.
    expect(sheet?.textContent).not.toContain('Monsoon drop: linen in rain');
    expect(stageTransition).not.toHaveBeenCalled();
    expect(postsStageTransition).not.toHaveBeenCalled();
  });

  it('D: confirming the on-behalf sheet approves once with onBehalfOf (the first approver preselected)', async () => {
    await render();
    const rows = h.actionSheetProps?.moveRows ?? [];
    await act(async () => {
      rows.find((r) => r.key === 'approved')?.onPick();
      await new Promise((r) => setTimeout(r, 30));
    });
    await settle();
    await click(document.querySelector('[data-on-behalf-approve]'));
    expect(postsStageTransition).toHaveBeenCalledOnce();
    expect(postsStageTransition.mock.calls[0]?.[1]).toEqual({
      postId: 'p1',
      toStage: 'approved',
      traceId: 'trace-1',
      onBehalfOf: 'u7',
    });
    expect(stageTransition).not.toHaveBeenCalled();
  });

  it('D: a refused on-behalf approve keeps the sheet open with the error once', async () => {
    h.transitionResult = { ok: false, error: { code: 'unknown', message: 'pg raw boom' } };
    await render();
    await act(async () => {
      h.actionSheetProps?.moveRows?.find((r) => r.key === 'approved')?.onPick();
      await new Promise((r) => setTimeout(r, 30));
    });
    await settle();
    await click(document.querySelector('[data-on-behalf-approve]'));
    expect(document.querySelector('[data-on-behalf-sheet]')).not.toBeNull();
    expect(document.querySelector('[data-on-behalf-error]')?.textContent).toBe(APPROVE_FAILED);
    expect(count(text(), APPROVE_FAILED)).toBe(1);
    expect(text()).not.toContain('pg raw boom');
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
      '2 open checkpoints',
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
    expect(text()).toContain('Sent for review again');
    expect(SENT_AGAIN_TOAST).toBe('Sent for review again');
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
    expect(count(text(), SEND_FAILED)).toBe(1);
    expect(text()).not.toContain('some raw text');
    // Open comments no longer block the proc; a stray checkpoints_open falls to
    // the retry copy.
    expect(sendAgainErrorCopy('checkpoints_open')).toBe(SEND_FAILED);
  });
});

describe('A3. the title is the edit target', () => {
  it('has no pencil tile; tapping the title opens the editor at the same 44px floor', async () => {
    h.stage = 'draft';
    await render();
    const h1 = document.querySelector('h1');
    expect(h1?.querySelector('svg')).toBeNull();
    const title = h1?.querySelector<HTMLButtonElement>('[data-title-edit]');
    expect(title?.className).toContain('min-h-[44px]');
    expect(title?.className).toContain('focus-visible:ring-2');
    expect(title?.className).toContain('leading-tight');
    await click(title ?? null);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Post title"]');
    expect(input).not.toBeNull();
    expect(input?.className).toContain('min-h-[44px]');
    expect(input?.className).toContain('leading-tight');
  });

  it('approvers get a plain title, no edit target', async () => {
    h.role = 'client';
    await render();
    expect(document.querySelector('[data-title-edit]')).toBeNull();
  });
});

describe('D2. laptop: the stage action sits in the header bar', () => {
  it('at lg the main button is beside the ⋮, not in the content', async () => {
    h.wide = true;
    await render();
    const header = document.querySelector('[data-header-decision]');
    expect(header?.querySelector('[data-decision-main]')?.textContent?.trim()).toBe(
      'Send for review again',
    );
    expect(document.querySelectorAll('[data-decision-main]').length).toBe(1);
    const more = document.querySelector('[aria-label="Post actions"]');
    expect(header?.nextElementSibling).toBe(more);
  });

  it('below lg it stays in the content row', async () => {
    await render();
    expect(document.querySelector('[data-header-decision]')).toBeNull();
    expect(document.querySelector('[data-decision-main]')).not.toBeNull();
  });
});

describe('37. approved posts are locked', () => {
  it('B4: one 14px lock on title, caption, pictures and owner; the meta line does not open the sheet; the banner says how', async () => {
    h.stage = 'approved';
    h.approvedBy = 'u3';
    h.approvedAt = '2026-10-21T06:00:00.000Z';
    await render();
    expect(document.querySelector('[data-title-edit]')).toBeNull();
    expect(document.querySelector('[data-caption-edit]')).toBeNull();
    expect(h.galleryProps?.tools?.canEdit).toBe(false);
    // The lock rows: title, caption, pictures (the gallery tools row) and owner.
    expect(document.querySelector('[data-title-lock]')).not.toBeNull();
    expect(document.querySelector('[data-caption-lock]')).not.toBeNull();
    expect(h.galleryProps?.tools?.locked).toBe(true);
    expect(document.querySelector('[data-detail="owner"] [data-detail-lock]')).not.toBeNull();
    // A5: at most one lock per row, 14px, text-fg-3.
    for (const selector of ['[data-title-lock]', '[data-caption-lock]', '[data-detail-lock]']) {
      const lock = document.querySelector(selector);
      expect(lock?.className).toContain('text-fg-3');
      expect(lock?.querySelectorAll('svg').length).toBe(1);
      expect(lock?.querySelector('svg')?.getAttribute('width')).toBe('14');
    }
    expect(h.detailsSheetProps?.lockedFields).toBe(true);
    // A1: the meta line opens the details sheet for agency roles only while not approved.
    expect(document.querySelector('[data-post-details-edit]')).toBeNull();
    const banner = document.querySelector('[data-approved-banner]');
    expect(APPROVED_LOCK_LINE).toBe('To make changes, move it to Parked.');
    expect(banner?.textContent).toContain('To make changes, move it to Parked.');
    expect(text()).not.toContain("Approved posts can't be edited");
    // Who approved is not repeated in the banner.
    expect(banner?.textContent).not.toContain('Approved by');
    expect(text()).not.toContain('Meera Shah on');
    // Banner under the title and details.
    const details = document.querySelector('[data-post-details]');
    expect(details!.compareDocumentPosition(banner!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('B4: "Move to Parked" in the banner (agency) opens the park confirm', async () => {
    h.stage = 'approved';
    await render();
    const park = document.querySelector<HTMLButtonElement>('[data-approved-park]');
    expect(MOVE_TO_PARKED_LABEL).toBe('Move to Parked');
    expect(park?.textContent?.trim()).toBe('Move to Parked');
    await click(park);
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Park this post?'),
    );
    expect(dialog).toBeDefined();
    expect(stageTransition).not.toHaveBeenCalled();
  });

  it('an approver on an approved post still sees Reject, and no lock rows or Move to Parked', async () => {
    h.stage = 'approved';
    h.role = 'client';
    await render();
    expect(buttonsIn('[data-decision-row]').map((b) => b.textContent?.trim())).toContain('Reject');
    expect(document.querySelector('[data-approved-park]')).toBeNull();
    expect(document.querySelector('[data-title-lock]')).toBeNull();
    expect(document.querySelector('[data-caption-lock]')).toBeNull();
    expect(document.querySelector('[data-approved-banner]')?.textContent).toContain(
      APPROVED_LOCK_LINE,
    );
  });

  it('a draft keeps every edit path and shows no banner', async () => {
    h.stage = 'draft';
    await render();
    expect(document.querySelector('[data-title-edit]')).not.toBeNull();
    expect(document.querySelector('[data-post-details-edit]')?.tagName).toBe('BUTTON');
    expect(document.querySelector('[data-caption-edit]')).not.toBeNull();
    expect(h.galleryProps?.tools?.canEdit).toBe(true);
    expect(h.galleryProps?.tools?.locked).toBe(false);
    expect(h.detailsSheetProps?.lockedFields).toBe(false);
    expect(document.querySelector('[data-approved-banner]')).toBeNull();
    expect(document.querySelector('[data-title-lock]')).toBeNull();
  });

  it('maps post_approved_locked to plain words', () => {
    expect(
      postActionErrorCopy({ code: 'unknown', message: 'post_approved_locked' }, 'save the caption'),
    ).toBe("Couldn't save the caption. Approved posts are locked.");
    expect(postActionErrorCopy({ code: 'unknown', message: 'P0001 boom' })).toBe(
      "Couldn't move the post. Try again.",
    );
    expect(postActionErrorCopy(new Error('Failed to fetch'))).toBe(
      "Couldn't move the post. You're offline.",
    );
  });

  it('the caption save maps the lock through the same copy', () => {
    const src = readFileSync(
      fileURLToPath(import.meta.url).replace(
        /PostDetailPage\.flowb3?\.test\.tsx$/,
        'PostDetailPage.tsx',
      ),
      'utf8',
    );
    expect(src).toContain(
      "setCaptionError(postActionErrorCopy(result.error, 'save the caption'));",
    );
    expect(src).toContain("pushError(postActionErrorCopy(result.error, 'save the details'));");
  });
});

describe('40 / B6. reject confirm copy', () => {
  it('title, who gets it back, "Reason (optional)" once (no helper, no repeat), Cancel and Reject', async () => {
    h.role = 'client';
    await render();
    await click(byText('Reject', document.querySelector('[data-decision-row]')!));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Reject this post?'),
    );
    expect(dialog).toBeDefined();
    expect(dialog?.querySelector('[data-stage-confirm-body]')?.textContent).toBe(
      'Riya gets it back to rework.',
    );
    expect(REJECT_REASON_LABEL).toBe('Reason (optional)');
    expect(dialog?.querySelector('textarea')?.getAttribute('aria-label')).toBe('Reason (optional)');
    expect(dialog?.querySelector('[data-stage-confirm-helper]')).toBeNull();
    // The idea is said once: the label alone.
    const dialogText = dialog?.textContent ?? '';
    expect(count(dialogText, 'Reason (optional)')).toBe(1);
    expect(dialogText.toLowerCase()).not.toContain('goes to the comments');
    expect(dialogText).not.toContain('You can send a reason');
    expect(byText('Cancel', dialog!)).toBeDefined();
    expect(byText('Reject', dialog!)).toBeDefined();
    expect(rejectConfirmBody(null)).toBe('The creator gets it back to rework.');
  });

  it('C2: park asks "Reason (optional)" with a neutral Park button; only Reject is red', async () => {
    h.stage = 'draft';
    await render();
    const park = (h.actionSheetProps?.moveRows ?? []).find((r) => r.key === 'parked');
    await act(async () => {
      park?.onPick();
    });
    await settle();
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.textContent?.includes('Park this post?'),
    );
    expect(dialog?.querySelector('textarea')?.getAttribute('aria-label')).toBe('Reason (optional)');
    const confirm = dialog?.querySelector<HTMLButtonElement>('[data-stage-confirm]');
    expect(confirm?.className ?? '').not.toContain('bg-bad');
  });

  it('B6: the ⋯ sheet Reject row carries no reason subtitle', async () => {
    await render();
    const reject = (h.actionSheetProps?.moveRows ?? []).find((r) => r.key === 'rejected');
    expect(reject).toBeDefined();
    expect(reject?.sub).toBeUndefined();
  });
});

describe('41. a failed approve shows once, inside the approve confirm', () => {
  it('unknown error reads the approve retry line once, never the raw text', async () => {
    h.role = 'client';
    h.transitionResult = { ok: false, error: { code: 'unknown', message: 'pg raw boom' } };
    await render();
    await click(byText('Approve', document.querySelector('[data-decision-row]')!));
    await click(document.querySelector('[data-approve-confirm-button]'));
    expect(stageTransition).toHaveBeenCalledOnce();
    expect(count(text(), APPROVE_FAILED)).toBe(1);
    expect(document.querySelector('[data-approve-error]')?.textContent).toBe(APPROVE_FAILED);
    expect(document.querySelector('[data-decision-error]')).toBeNull();
    expect(text()).not.toContain('pg raw boom');
  });
});
