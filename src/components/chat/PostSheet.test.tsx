import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PostCardRow, GalleryItem } from '../../../packages/posts/src/reads';
import {
  PostSheetDetails,
  PostSheetExtras,
  PostSheetMedia,
  STRIP_BOX,
  knownStage,
  postSheetMenuItems,
  sideRole,
  talkAboutLabel,
  type PostSheetExtrasProps,
  type SheetGallery,
} from '@/components/chat/PostSheet';
import { agencyWaitingHint } from '@/components/chat/post-sheet';
import { postDecisionLabels } from '@/components/pages/pcs/use-post-decisions';
import { orderActionItems } from '@/components/ui/ActionMenu';
import { IconPause } from '@/components/ui/icons';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { PresignCache } from '@/lib/asset-presign';
import type { Stage } from '@srtdio/posts';

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
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const STAGES: Stage[] = ['draft', 'review', 'approved', 'parked', 'rejected'];

// PR B: the chat sheet's decisions are Post detail's. One table, read for both
// sides on every stage: the row (bottom bar on phone, header right on laptop)
// and the creator's ⋯ menu moves.
const PARITY: Record<'client' | 'agency', Record<Stage, { row: string[]; menu: string[] }>> = {
  client: {
    draft: { row: [], menu: [] },
    review: { row: ['Reject', 'Approve'], menu: [] },
    approved: { row: ['Reject'], menu: [] },
    parked: { row: [], menu: [] },
    rejected: { row: [], menu: [] },
  },
  agency: {
    draft: { row: ['Send for review'], menu: ['Park'] },
    review: {
      row: ['Send for review again'],
      menu: ['Approve on their behalf', 'Reject', 'Park'],
    },
    approved: { row: [], menu: ['Park', 'Reject'] },
    parked: { row: ['Send for review'], menu: [] },
    rejected: { row: ['Send for review'], menu: [] },
  },
};

describe('PostSheet decisions match PostDetailPage (PR B parity)', () => {
  for (const side of ['client', 'agency'] as const) {
    for (const stage of STAGES) {
      it(`${side === 'client' ? 'approver' : 'creator'} on ${stage}`, () => {
        // The sheet reads the viewer's side; the page reads the member role.
        // Both go through the same rules.
        expect(postDecisionLabels(stage, sideRole(side))).toEqual(PARITY[side][stage]);
        for (const role of side === 'client' ? ['client'] : ['owner', 'admin', 'agency']) {
          expect(postDecisionLabels(stage, role)).toEqual(PARITY[side][stage]);
        }
      });
    }
  }

  it('an unresolved side is offered nothing', () => {
    for (const stage of STAGES) {
      expect(postDecisionLabels(stage, sideRole('unknown'))).toEqual({ row: [], menu: [] });
    }
  });

  it('both surfaces build their decisions from the one hook and render the pcs decision bar', () => {
    const sheet = read('./PostSheet.tsx');
    const page = read('../pages/PostDetailPage.tsx');
    for (const src of [sheet, page]) {
      expect(src).toContain('usePostDecisions({');
      expect(src).toContain('<PostDecisionBar');
      expect(src).toContain('<PostDecisionRow');
      expect(src).toContain('{decisions.confirms}');
      expect(src).toContain('useIsLaptop()');
    }
    // The sheet maps the viewer's side to a role the same table reads; the page
    // passes the member role straight through.
    expect(sheet).toContain('role: sideRole(side),');
    expect(sheet).toContain('moves: decisions.moveRows,');
    expect(page).toContain('moveRows={decisions.moveRows}');
    // The sheet owns no stage write of its own.
    expect(sheet).not.toContain('stageTransition(');
    expect(sheet).not.toContain('runStageChange');
  });

  it('a card stage outside the stage machine offers nothing', () => {
    expect(knownStage('review')).toBe('review');
    expect(knownStage('archived')).toBeNull();
    expect(knownStage('toString')).toBeNull();
  });
});

describe('the sheet ⋯ menu', () => {
  it('Open post first, Copy link second, then the creator moves', () => {
    const items = postSheetMenuItems({
      onOpenPost: vi.fn(),
      onCopyLink: vi.fn(),
      moves: [{ key: 'parked', icon: IconPause, label: 'Park', onPick: vi.fn() }],
    });
    expect(orderActionItems(items).map((i) => i.label)).toEqual(['Open post', 'Copy link', 'Park']);
  });
});

describe('PostSheetExtras', () => {
  function extras(
    side: ViewerSide,
    post: PostCardRow,
    over: Partial<PostSheetExtrasProps> = {},
  ): string {
    return renderToStaticMarkup(
      <PostSheetExtras hint={agencyWaitingHint(side, post, 'UTC')} {...over} />,
    );
  }

  it('the approver in review may comment; nothing moves the post here', () => {
    const html = extras('client', row(), { onComment: vi.fn() });
    expect(html).toContain('Comment on this post');
    expect(html).not.toContain('>Approve<');
    expect(html).not.toContain('>Reject<');
  });

  it("the agency's waiting line in review", () => {
    expect(extras('agency', row())).toContain('Waiting on approvers since 20 Sep');
    expect(extras('agency', row({ stage: 'draft' }))).toBe('');
  });

  it('every button is 44px tall with an 8px radius', () => {
    const html = extras('client', row(), { onComment: vi.fn(), onTalkAbout: vi.fn() });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toContain('h-11');
      expect(b).toContain('rounded-lg');
    }
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

function media(
  gallery: SheetGallery,
  mediaCount: number,
  format = 'carousel',
  platform = 'instagram',
): string {
  return renderToStaticMarkup(
    <PostSheetMedia
      gallery={gallery}
      mediaCount={mediaCount}
      platform={platform}
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

  it('loading with media: a skeleton in the format frame the strip will use', () => {
    const html = media({ status: 'loading' }, 3);
    expect(html).toContain('data-strip-skeleton');
    expect(html).toContain('data-frame-ratio="0.8"');
    expect(html).toContain('animate-pulse');
  });

  it('the strip takes the platform frame from the first slide; text keeps the 4:5 rail', () => {
    const reel = media({ status: 'ready', items: [item(0)] }, 1, 'reel');
    expect(reel).toContain('data-frame-ratio="0.5625"');
    expect(reel).toContain('width:min(100%, calc(60vh * 0.5625))');
    // A stored 1080 x 1350 first slide on an Instagram carousel: 4:5, cropped to fill.
    const carousel = media({ status: 'ready', items: [item(0)] }, 1);
    expect(carousel).toContain('data-frame-ratio="0.8"');
    expect(carousel).toContain('data-frame-fit="cover"');
    const text = media({ status: 'ready', items: [item(0)] }, 1, 'text', 'linkedin');
    expect(text).not.toContain('data-frame-ratio');
    expect(STRIP_BOX).toContain('aspect-[4/5]');
    expect(text).toContain('aspect-[4/5]');
  });

  it('A4: YouTube Shorts draws the slide behind the frame as the blurred bands', () => {
    const shorts = media({ status: 'ready', items: [item(0)] }, 1, 'short', 'youtube_shorts');
    expect(shorts).toContain('data-frame-bands="blur"');
    expect(shorts).toContain('blur-xl');
    expect(shorts).toContain('data-strip-backdrop');
    // Other platforms have no blurred bands, so no backdrop is drawn.
    const reel = media({ status: 'ready', items: [item(0)] }, 1, 'reel');
    expect(reel).not.toContain('data-strip-backdrop');
  });

  it('A3: an X thread with media is framed; without media there is no box at all', () => {
    expect(media({ status: 'ready', items: [item(0)] }, 1, 'thread', 'x')).toContain(
      'data-frame-ratio',
    );
    expect(media({ status: 'ready', items: [] }, 0, 'thread', 'x')).toBe('');
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
      <PostSheetDetails view={view({ mediaCount: 4 })} timeZone="UTC" workspaceZone="UTC" />,
    );
    expect(html).toContain('Diwali carousel with a long full title that the card would clamp');
    expect(html).not.toContain('line-clamp');
    expect(html).toContain('>Stage<');
    expect(html).toContain('>Review<');
    expect(html).toContain('Target date');
    expect(html).toContain('2 Oct');
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
        workspaceZone="UTC"
      />,
    );
    expect(html).toContain('data-sheet-row="approved"');
    expect(html).toContain('Asha · 1 Oct');
  });
});

describe('no KEY-N codes in the sheet', () => {
  const CODE = /\b[A-Z]{2,}-\d+\b/;

  it('talk about names this post, never a code', () => {
    expect(talkAboutLabel()).toBe('Talk about this post');
  });

  it('extras and decision labels render no KEY-N code', () => {
    const htmls = [
      renderToStaticMarkup(
        <PostSheetExtras hint={agencyWaitingHint('agency', row(), 'UTC')} onTalkAbout={vi.fn()} />,
      ),
      ...STAGES.flatMap((stage) =>
        (['client', 'agency'] as const).flatMap((side) => {
          const labels = postDecisionLabels(stage, side);
          return [...labels.row, ...labels.menu];
        }),
      ),
    ];
    for (const html of htmls) expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(CODE);
  });

  it('the talk-about button reads "Talk about this post"', () => {
    const html = renderToStaticMarkup(<PostSheetExtras hint={null} onTalkAbout={vi.fn()} />);
    expect(html).toContain('Talk about this post');
  });
});
