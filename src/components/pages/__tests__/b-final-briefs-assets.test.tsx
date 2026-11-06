// Layout B-final, Briefs + Assets: the screens render the shared parts. Asset
// tiles are ui/Tile (caption below the picture, the ⋯ on the name line with the
// trailing rule, overlays only at corners), brief cards are ui/Card (the cover
// link, the footer status and due), both grids fill the laptop width through
// the parts' named auto-fill columns, and a tile keeps its height across states.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AssetCard } from '@/components/pages/assets/AssetCard';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { BriefCard } from '@/components/pages/BriefCard';
import { Card, CARD_GRID } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { StatusDot } from '@/components/ui/StatusDot';
import { TILE_GRID } from '@/components/ui/Tile';
import { TRAILING_PULL } from '@/components/ui/layout';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import type { BriefWithThumbnail } from '@srtdio/briefs';

// Phone layout for the ⋯ menus (ui/ActionMenu); no matchMedia here.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

function asset(overrides: Partial<AssetListItem> = {}): AssetListItem {
  return {
    id: 'a1',
    filename: 'report.pdf',
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-01-01T00:00:00Z',
    currentVersionId: 'av1',
    kind: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    externalUrl: null,
    r2Key: null,
    versionNumber: 1,
    attachmentCount: 0,
    ...overrides,
  };
}

function brief(overrides: Partial<BriefWithThumbnail> = {}): BriefWithThumbnail {
  return {
    id: 'b1',
    workspace_id: 'w1',
    number: 1,
    title: 'Spring launch',
    objective: 'Tease the spring drop.',
    legacy_author_name: null,
    status: 'open',
    target_date: '2026-07-01',
    reference_links: null,
    mentions: null,
    format_requested: null,
    brand_requirements: null,
    closed_at: null,
    closed_by: null,
    created_by: 'u1',
    created_via: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
    ...overrides,
  };
}

function tile(props: Partial<Parameters<typeof AssetCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <AssetCard
      item={asset()}
      cache={cache}
      presignEnabled={false}
      onOpen={() => {}}
      onStartSelect={() => {}}
      {...props}
    />,
  );
}

/** The caption's lines (title + meta) inside the tap surface, in markup order: their classes. */
function captionLines(html: string): string[] {
  const start = html.indexOf('data-tile-press=""');
  const surface = html.slice(start, html.indexOf('</button>', start));
  return [...surface.matchAll(/class="([^"]*\btext-md\b[^"]*|font-mono text-sm[^"]*)"/g)].map(
    (m) => m[1]!,
  );
}

describe('Assets tile is ui/Tile', () => {
  it('renders the part: the picture first, the name and meta below it', () => {
    const out = tile();
    expect(out).toContain('data-tile=""');
    expect(out).toContain('data-tile-press=""');
    const picture = out.indexOf('data-file-tile="pdf"');
    const name = out.indexOf('data-asset-name=""');
    const meta = out.indexOf('data-asset-meta=""');
    expect(picture).toBeGreaterThan(-1);
    expect(name).toBeGreaterThan(picture);
    expect(meta).toBeGreaterThan(name);
    // The caption sits in the tile, not in FileTile's own card footer.
    expect(out).not.toContain('data-file-name');
  });

  it('the ⋯ sits on the name line and takes the trailing rule (ends on the tile edge)', () => {
    const out = tile();
    expect(out).toMatch(/data-tile-more=""[^]*?data-card-menu=""/);
    const trigger = /<button[^>]*data-card-menu=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(trigger).toContain(TRAILING_PULL);
    // Never in a picture corner.
    expect(out).not.toMatch(/data-tile-corner="[^"]*"[^>]*>(?:(?!data-tile-corner)[^])*?data-card-menu/);
  });

  it('overlays only at corners; the select box is a corner action outside the tap surface', () => {
    const out = tile();
    expect(out).toMatch(/data-tile-action="tl"[^>]*>\s*<button[^>]*data-card-select=""/);
    // The tap surface closes before the select box opens (buttons never nest).
    const pressStart = out.indexOf('data-tile-press=""');
    const pressEnd = out.indexOf('</button>', pressStart);
    expect(out.indexOf('data-card-select=""')).toBeGreaterThan(pressEnd);
    const ticked = tile({ selectMode: true, selected: true, onToggleSelect: () => {} });
    expect(ticked).toMatch(/data-tile-corner="tl"[^>]*>[^]*?data-card-tick=""/);
  });

  it('keeps its height across states: the same picture box and caption lines', () => {
    const states = [
      tile(),
      tile({ selectMode: true, selected: false, onToggleSelect: () => {} }),
      tile({ selectMode: true, selected: true, onToggleSelect: () => {} }),
      tile({ item: asset({ sizeBytes: null, pageCount: 4 }) }),
    ];
    const first = captionLines(states[0]!);
    expect(first).toHaveLength(2);
    for (const out of states) {
      expect(out).toContain('aspect-[4/3]');
      expect(captionLines(out)).toEqual(first);
    }
  });

  it('the grid fills the laptop width with the named auto-fill columns', () => {
    expect(TILE_GRID).toContain('md:grid-cols-tiles');
    const out = renderToStaticMarkup(
      <AssetGrid items={[asset()]} presignEnabled={false} cache={cache} onOpen={() => {}} />,
    );
    expect(out).toContain('md:grid-cols-tiles');
    expect(out).not.toContain('grid-cols-[');
  });
});

describe('Brief card is ui/Card', () => {
  function card(overrides: Partial<BriefWithThumbnail> = {}): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief(overrides)} cache={cache} presignEnabled={false} href="/b/1" />
      </MemoryRouter>,
    );
  }

  it('fills the slots: header title, body objective, footer status and Due', () => {
    const out = card();
    expect(out).toMatch(/^<div data-brief-card=""[^>]*data-card=""/);
    expect(out).toMatch(/data-card-header=""[^]*data-card-title=""[^]*Spring launch/);
    expect(out).toMatch(/data-card-footer=""[^]*data-brief-status="open"[^]*Due 1 Jul/);
    expect(out).not.toContain('Target');
    // The cover link is the card's one link, at its corners.
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    expect(out).toMatch(/<a [^>]*class="[^"]*absolute inset-0/);
  });

  it('a closed brief is the muted card, never dimmed', () => {
    const out = card({ status: 'closed' });
    expect(out).toContain('lit-card-muted');
    expect(out).not.toContain('opacity');
  });

  it('the card grid fills the laptop width with the named auto-fill columns', () => {
    expect(CARD_GRID).toContain('md:grid-cols-cards');
  });
});

describe('Card trailing control and the status dot', () => {
  it('a bare remove X in the Card more slot takes the trailing rule', () => {
    const out = renderToStaticMarkup(
      <Card
        title="photo.png"
        more={
          <IconButton label="Remove photo.png" onClick={() => {}}>
            x
          </IconButton>
        }
      />,
    );
    expect(out).toMatch(/data-card-more="" class="[^"]*\[&amp;&gt;button\]:-mr-3/);
  });

  it('a brief status dot reads accent when open and fg-3 when closed', () => {
    expect(renderToStaticMarkup(<StatusDot stage="open" />)).toContain('bg-accent');
    expect(renderToStaticMarkup(<StatusDot stage="closed" />)).toContain('bg-fg-3');
    expect(renderToStaticMarkup(<StatusDot stage="review" />)).toContain('bg-stage-review');
  });
});
