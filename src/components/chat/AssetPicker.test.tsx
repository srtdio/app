import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The grid views are rendered to static markup (node env, no DOM). The presign
// cache is a stub that never resolves, so an image tile stays on its shimmer
// and a file tile shows its fallback: enough to tell the two apart.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'GBL', workspaces: [] }),
}));
vi.mock('@/components/chat/PostCard', () => ({
  PRESIGN_ENABLED: true,
  sharedCardPresignCache: () => ({
    peek: () => null,
    resolve: () => new Promise(() => undefined),
  }),
}));

import { AssetGrid, AssetGridSkeleton, AssetTile } from '@/components/chat/AssetPicker';
import { shapeLibraryRows, type LibraryAsset } from '@/lib/chat/asset-picker';
import {
  draftFileCounts,
  withLibraryArgs,
  withLibraryAttachments,
} from '@/components/chat/Composer';
import { awaitsUpload, toLibraryAttachment, toLocalAttachment } from '@/lib/chat/attachments';
import { scheduleAttachmentArgs } from '@/lib/chat/scheduled';

function asset(n: number, mime: string, filename: string): LibraryAsset {
  const [row] = shapeLibraryRows([
    {
      id: `a${n}`,
      filename,
      display_name: null,
      uploaded_at: '2026-09-20T00:00:00Z',
      current_version_id: `v${n}`,
      current_version: {
        id: `v${n}`,
        kind: mime.startsWith('image/') ? 'image' : 'file',
        mime_type: mime,
        size_bytes: 10,
        width: null,
        height: null,
        duration_ms: null,
      },
    },
  ]);
  if (row === undefined) throw new Error('no row');
  return row;
}

const image = asset(1, 'image/png', 'hero.png');
const pdf = asset(2, 'application/pdf', 'deck.pdf');

function grid(over: Partial<Parameters<typeof AssetGrid>[0]> = {}): string {
  return renderToStaticMarkup(
    <AssetGrid
      rows={[image, pdf]}
      count={2}
      searching={false}
      loadingMore={false}
      selected={[]}
      onToggle={() => undefined}
      onLoadMore={() => undefined}
      {...over}
    />,
  );
}

describe('AssetPicker grid', () => {
  it('an image tile presigns its thumbnail; a PDF shows the file tile and its name', () => {
    const imageHtml = renderToStaticMarkup(
      <AssetTile asset={image} active={false} onToggle={() => undefined} />,
    );
    const pdfHtml = renderToStaticMarkup(
      <AssetTile asset={pdf} active={false} onToggle={() => undefined} />,
    );
    expect(imageHtml).toContain('animate-pulse');
    expect(pdfHtml).not.toContain('animate-pulse');
    expect(pdfHtml).toContain('PDF');
    expect(pdfHtml).toContain('deck.pdf');
  });

  it('tiles are 44px targets with a pressed state and a check when picked', () => {
    const html = grid({ selected: [pdf] });
    expect(html.match(/min-h-\[44px\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html.match(/bg-accent text-accent-fg/g)).toHaveLength(1);
  });

  it('"Load 50 more" with "<shown> of <N>" only while more remain', () => {
    expect(grid({ count: 120 })).toContain('Load 50 more');
    expect(grid({ count: 120 })).toContain('2 of 120');
    expect(grid({ count: 2 })).not.toContain('Load 50 more');
  });

  it('empty library and empty search say so', () => {
    expect(grid({ rows: [], count: 0 })).toContain('No assets');
    expect(grid({ rows: [], count: 0, searching: true })).toContain('No matches');
  });

  it('the loading state is static placeholder tiles (no motion)', () => {
    const html = renderToStaticMarkup(<AssetGridSkeleton />);
    expect(html.match(/data-skeleton-tile/g)).toHaveLength(6);
    expect(html).not.toContain('animate-');
  });

  it('tokens only: no hex colours, no blur', () => {
    const html = grid({ count: 120, selected: [image] });
    // The hash sign is built from its char code (the chat token guard bans the literal).
    expect(html).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`));
    expect(html).not.toContain('blur');
  });
});

describe('composer: library picks ride the normal send and schedule', () => {
  const lib = [
    toLibraryAttachment(
      { id: 'v-img', mime_type: 'image/png', size_bytes: 3, duration_ms: null },
      'Hero.png',
    ),
    toLibraryAttachment(
      { id: 'v-pdf', mime_type: 'application/pdf', size_bytes: 9, duration_ms: null },
      'Deck.pdf',
    ),
  ];

  it('send: picked files first (local, uploaded by the outbox), then library picks as is', () => {
    const local = toLocalAttachment(
      new File(['a'], 'roll.png', { type: 'image/png' }),
      null,
      undefined,
    );
    const draft = withLibraryAttachments({ text: '', attachments: [local] }, lib);
    expect(draft.attachments.map((a) => a.assetId)).toEqual(['', 'v-img', 'v-pdf']);
    expect(draft.attachments.filter(awaitsUpload)).toHaveLength(1);
    const plain = { text: 'x', attachments: [local] };
    expect(withLibraryAttachments(plain, [])).toBe(plain);
  });

  it('schedule: uploaded args then library args, built like the normal send', () => {
    const uploaded = scheduleAttachmentArgs([
      { assetId: 'v-up', name: 'roll.png', mime: 'image/png', size: 1 },
    ]);
    const args = withLibraryArgs(uploaded, lib);
    expect(args.attachmentAssetIds).toEqual(['v-up', 'v-img', 'v-pdf']);
    expect(args.attachmentMeta).toEqual({
      'v-up': { mime: 'image/png', name: 'roll.png', size: 1 },
      'v-img': { mime: 'image/png', name: 'Hero.png', size: 3 },
      'v-pdf': { mime: 'application/pdf', name: 'Deck.pdf', size: 9 },
    });
  });

  it('the schedule preview counts library photos and files', () => {
    const pending = [
      { id: 'p1', file: new File(['a'], 'roll.png', { type: 'image/png' }), previewUrl: null },
    ];
    expect(draftFileCounts(pending, lib)).toEqual({ photos: 2, others: 1 });
  });
});
