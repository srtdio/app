import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PostCardRow, GalleryItem } from '../../../packages/posts/src/reads';
import {
  ACTION_GOOD,
  PostSheetActions,
  PostSheetDetails,
  PostSheetMedia,
  STRIP_BOX,
  sheetRef,
  type PostSheetActionsProps,
  type SheetGallery,
} from '@/components/chat/PostSheet';
import { sheetActions } from '@/components/chat/post-sheet';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { PresignCache } from '@/lib/asset-presign';

function row(over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id: 'p1',
    number: 12,
    title: 'Diwali carousel with a long full title that the card would clamp',
    platform: 'instagram',
    format: 'carousel',
    stage: 'review',
    target_date: '2026-10-02',
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

function actions(
  side: ViewerSide,
  post: PostCardRow,
  over: Partial<PostSheetActionsProps> = {},
): string {
  return renderToStaticMarkup(
    <PostSheetActions
      set={sheetActions(side, post, 'UTC')}
      mode={{ kind: 'actions' }}
      refLabel="GBL-12"
      approverName={null}
      mediaCount={post.mediaCount}
      targetDate="Oct 2"
      busy={false}
      error={null}
      onAction={vi.fn()}
      onConfirm={vi.fn()}
      onBack={vi.fn()}
      {...over}
    />,
  );
}

/** The action ids in render order. */
function actionIds(html: string): string[] {
  return [...html.matchAll(/data-sheet-action="([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

describe('PostSheetActions by side and stage', () => {
  it('client in review: approve (good), comment, open full post, and the hint', () => {
    const html = actions('client', row({ stage: 'review' }));
    expect(actionIds(html)).toEqual(['approve', 'comment', 'open_post']);
    expect(html).toContain('Approve GBL-12');
    expect(html).toContain('Comment on this post');
    expect(html).toContain('Open full post');
    expect(html).toContain('One post at a time. Comments keep it in review.');
    expect(html).toContain('bg-good');
    expect(ACTION_GOOD).toContain('h-12');
  });

  it('client on an approved post: open only, plus the disabled approved pill', () => {
    const html = actions('client', row({ stage: 'approved' }), { approverName: 'Asha' });
    expect(actionIds(html)).toEqual(['open_post']);
    expect(html).toContain('Approved by Asha');
    expect(html).toMatch(/data-approved-pill=""[^>]*disabled|disabled=""[^>]*data-approved-pill/);
  });

  it('client on a parked post: open only, no pill', () => {
    const html = actions('client', row({ stage: 'parked' }));
    expect(actionIds(html)).toEqual(['open_post']);
    expect(html).not.toContain('data-approved-pill');
  });

  it('agency in draft: send for review (primary) then open in pipeline', () => {
    const html = actions('agency', row({ stage: 'draft' }));
    expect(actionIds(html)).toEqual(['send_review', 'open_pipeline']);
    expect(html).toContain('bg-accent');
  });

  it('agency in review: approve (good), open in pipeline and the waiting hint', () => {
    const html = actions('agency', row({ stage: 'review' }));
    expect(actionIds(html)).toEqual(['approve', 'open_pipeline']);
    expect(html).toContain('Approve GBL-12');
    expect(html).toContain('Waiting on the client since Sep 20');
    expect(html).toContain('bg-good');
  });

  it('agency gets no Approve outside review, and never Reject or Park', () => {
    for (const stage of ['draft', 'approved', 'parked', 'rejected']) {
      const html = actions('agency', row({ stage }));
      expect(actionIds(html)).not.toContain('approve');
    }
    for (const side of ['agency', 'client'] as const) {
      const html = actions(side, row({ stage: 'review' }));
      expect(html).not.toContain('Reject');
      expect(html).not.toContain('Park');
    }
  });

  it('agency approve confirm names slides and date, plus the on-behalf line', () => {
    const html = actions('agency', row({ stage: 'review', mediaCount: 5 }), {
      mode: { kind: 'confirm', confirm: 'approve' },
      mediaCount: 5,
      onBehalf: true,
    });
    expect(html).toContain('Approve GBL-12, all 5 slides, for Oct 2?');
    expect(html).toContain('You are approving on behalf of client.');
  });

  it('client approve confirm has no on-behalf line', () => {
    const html = actions('client', row({ stage: 'review' }), {
      mode: { kind: 'confirm', confirm: 'approve' },
      onBehalf: false,
    });
    expect(html).not.toContain('on behalf of client');
  });

  it('approved pill suffixes an agency-side approver, not a client or unknown one', () => {
    const agency = actions('client', row({ stage: 'approved' }), {
      approverName: 'Chitra',
      approverRole: 'agency',
    });
    expect(agency).toContain('Approved by Chitra on behalf of client');
    const client = actions('client', row({ stage: 'approved' }), {
      approverName: 'Asha',
      approverRole: 'client',
    });
    expect(client).toContain('Approved by Asha<');
    const old = actions('client', row({ stage: 'approved' }), { approverName: 'Asha' });
    expect(old).not.toContain('on behalf of client');
  });

  it('every action button is 48px tall and the area pads for the safe area', () => {
    const html = actions('client', row({ stage: 'review' }));
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(3);
    for (const b of buttons) expect(b).toContain('h-12');
    expect(html).toContain('pb-[env(safe-area-inset-bottom)]');
  });
});

describe('PostSheetActions confirm and error', () => {
  it('approve confirm swaps the actions for the question, Back and the confirm button', () => {
    const html = actions('client', row({ stage: 'review', mediaCount: 5 }), {
      mode: { kind: 'confirm', confirm: 'approve' },
      mediaCount: 5,
    });
    expect(html).toContain('data-sheet-confirm="approve"');
    expect(html).toContain('Approve GBL-12, all 5 slides, for Oct 2?');
    expect(html).toContain('This is logged as your approval and the agency is notified.');
    expect(html).toContain('>Back<');
    expect(html).toContain('>Approve GBL-12<');
    expect(actionIds(html)).toEqual([]);
    expect(html).not.toContain('Comment on this post');
  });

  it('send-for-review confirm has its own copy', () => {
    const html = actions('agency', row({ stage: 'draft' }), {
      mode: { kind: 'confirm', confirm: 'send_review' },
    });
    expect(html).toContain('data-sheet-confirm="send_review"');
    expect(html).toContain('Send GBL-12 to the client for review?');
  });

  it('shows the mapped error copy in the confirm block', () => {
    const html = actions('client', row(), {
      mode: { kind: 'confirm', confirm: 'approve' },
      error: 'You do not have permission to make this change.',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('You do not have permission to make this change.');
  });

  it('busy disables both confirm buttons', () => {
    const html = actions('client', row(), {
      mode: { kind: 'confirm', confirm: 'approve' },
      busy: true,
    });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(b).toContain('disabled');
  });

  it('comment mode leaves only Back (the composer owns send)', () => {
    const html = actions('client', row(), { mode: { kind: 'comment' } });
    expect(actionIds(html)).toEqual([]);
    expect(html).toContain('>Back<');
  });
});

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: async () => null,
  fetcher: async () => new Response(null),
});

function item(i: number, over: Partial<GalleryItem> = {}): GalleryItem {
  return {
    assetAttachmentId: `a${i}`,
    assetVersionId: `v${i}`,
    assetId: `as${i}`,
    position: i,
    filename: `f${i}.jpg`,
    mimeType: 'image/jpeg',
    kind: 'image',
    width: 1080,
    height: 1350,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
    ...over,
  };
}

function media(gallery: SheetGallery, mediaCount: number, format = 'carousel'): string {
  return renderToStaticMarkup(
    <PostSheetMedia
      gallery={gallery}
      mediaCount={mediaCount}
      format={format}
      active={0}
      cache={cache}
      presignEnabled={false}
      onScroll={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
}

describe('PostSheetMedia', () => {
  it('no media: no box at all, while loading or once empty', () => {
    expect(media({ status: 'loading' }, 0)).toBe('');
    expect(media({ status: 'ready', items: [] }, 0)).toBe('');
  });

  it('loading with media: a skeleton the same box as the strip', () => {
    const html = media({ status: 'loading' }, 3);
    expect(html).toContain('data-strip-skeleton');
    expect(html).toContain('aspect-[4/5]');
    expect(STRIP_BOX).toContain('aspect-[4/5]');
  });

  it('several slides: one per width with the counter and dots', () => {
    const html = media({ status: 'ready', items: [item(0), item(1), item(2)] }, 3);
    expect(html.match(/data-strip-slide/g)?.length).toBe(3);
    expect(html).toContain('snap-x snap-mandatory');
    expect(html).toContain('1 / 3');
    expect(html).toContain('data-strip-dots');
    expect(html).toContain('aria-label="Open slide 1"');
  });

  it('a single slide shows neither counter nor dots', () => {
    const html = media({ status: 'ready', items: [item(0)] }, 1);
    expect(html).not.toContain('data-strip-counter');
    expect(html).not.toContain('data-strip-dots');
  });

  it('video slides carry a play badge; a video post shows Reel · m:ss', () => {
    const video = item(0, { kind: 'video', mimeType: 'video/mp4', durationMs: 42_000 });
    const html = media({ status: 'ready', items: [video] }, 1, 'video');
    expect(html).toContain('data-play-badge');
    expect(html).toContain('Reel · 0:42');
  });
});

describe('PostSheetDetails', () => {
  const view = (over: Partial<PostCardRow> = {}, approverName: string | null = null) => ({
    kind: 'post' as const,
    postId: 'p1',
    post: row(over),
    approverName,
  });

  it('the full title, the stage tag and the rows', () => {
    const html = renderToStaticMarkup(
      <PostSheetDetails view={view({ mediaCount: 4 })} timeZone="UTC" />,
    );
    expect(html).toContain('Diwali carousel with a long full title that the card would clamp');
    expect(html).not.toContain('line-clamp');
    expect(html).toContain('>Stage<');
    expect(html).toContain('>Review<');
    expect(html).toContain('Target date');
    expect(html).toContain('Oct 2');
    expect(html).toMatch(/· 4 slides/);
  });

  it('approved by a named approver', () => {
    const html = renderToStaticMarkup(
      <PostSheetDetails
        view={view(
          { stage: 'approved', approved_by: 'u1', approved_at: '2026-10-01T09:05:00Z' },
          'Asha',
        )}
        timeZone="UTC"
      />,
    );
    expect(html).toContain('data-sheet-row="approved"');
    expect(html).toContain('Asha · Oct 1');
  });
});

describe('sheetRef', () => {
  it('KEY-N once the key resolves, a plain fallback before', () => {
    expect(sheetRef('GBL', 12)).toMatch(/^GBL-?12$/);
    expect(sheetRef(null, 12)).toBe('Post 12');
  });
});
