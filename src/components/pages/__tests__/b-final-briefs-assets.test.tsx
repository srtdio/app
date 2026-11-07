// Layout B-final, Briefs + Assets: the screens render the shared parts. Asset
// items are ui/ListCard (picture, name, facts, time + tab tag, the ⋮ with the
// trailing rule; the tick in its place while selecting), brief cards are ui/Card (the cover
// link, the footer status and due), both grids fill the laptop width through
// the parts' named auto-fill columns, and a tile keeps its height across states.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AssetList, AssetListCard } from '@/components/pages/assets/AssetListCard';
import { BriefCard } from '@/components/pages/BriefCard';
import { Card, CARD_GRID } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { StatusDot } from '@/components/ui/StatusDot';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
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

const NOW = new Date('2026-01-01T03:00:00Z');

function tile(props: Partial<Parameters<typeof AssetListCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <AssetListCard
      item={asset()}
      cache={cache}
      presignEnabled={false}
      now={NOW}
      onOpen={() => {}}
      onStartSelect={() => {}}
      {...props}
    />,
  );
}

/** The card's line wrappers and text slots, in markup order: the footprint every state keeps. */
function slots(html: string): string[] {
  return [...html.matchAll(/data-list-card-(line="\d"|title=""|preview=""|time=""|more="")/g)].map(
    (m) => m[1]!,
  );
}

describe('Assets item is ui/ListCard', () => {
  it('renders the part: the picture first, then the name, the facts, the time and the tab tag', () => {
    const out = tile();
    expect(out).toContain('data-list-card=""');
    expect(out).toContain('data-list-card-press=""');
    const picture = out.indexOf('data-list-card-picture=');
    const name = out.indexOf('data-asset-name=""');
    const meta = out.indexOf('data-asset-meta=""');
    const time = out.indexOf('data-asset-uploaded=""');
    const tag = out.indexOf('data-asset-tag=""');
    expect(picture).toBeGreaterThan(-1);
    expect(name).toBeGreaterThan(picture);
    expect(meta).toBeGreaterThan(name);
    expect(time).toBeGreaterThan(meta);
    expect(tag).toBeGreaterThan(time);
    expect(out).toContain('>3 hours ago<');
    expect(out).not.toContain('data-tile');
  });

  it('the ⋮ sits on line 3 and takes the trailing rule (ends on the card edge)', () => {
    const out = tile();
    expect(out).toMatch(/data-list-card-line="3"[^]*data-list-card-more=""[^]*?data-card-menu=""/);
    const trigger = /<button[^>]*data-card-menu=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(trigger).toContain(TRAILING_PULL);
    // The ⋮ is a sibling of the card's tap surface (buttons never nest).
    const pressStart = out.indexOf('data-list-card-press=""');
    const pressEnd = out.indexOf('</button>', pressStart);
    expect(out.indexOf('data-card-menu=""')).toBeGreaterThan(pressEnd);
  });

  it('select mode puts the tick box where the ⋮ sits; no corner overlay', () => {
    const ticked = tile({ selectMode: true, selected: true, onToggleSelect: () => {} });
    expect(ticked).toMatch(/data-list-card-more=""[^>]*>\s*<span[^>]*data-card-tick="on"/);
    expect(ticked).not.toContain('data-card-menu');
    expect(ticked).not.toContain('data-card-select');
    expect(ticked).toContain('lit-selected');
  });

  it('keeps its footprint across states: the same lines and slots', () => {
    const states = [
      tile(),
      tile({ selectMode: true, selected: false, onToggleSelect: () => {} }),
      tile({ selectMode: true, selected: true, onToggleSelect: () => {} }),
      tile({ item: asset({ sizeBytes: null, pageCount: 4 }) }),
    ];
    const first = slots(states[0]!);
    expect(first).toEqual(['line="1"', 'title=""', 'preview=""', 'line="3"', 'time=""', 'more=""']);
    for (const out of states) expect(slots(out)).toEqual(first);
  });

  it('the list is LIST_CARD_GRID: one column on phone, the named auto-fill columns on laptop', () => {
    expect(LIST_CARD_GRID).toContain('md:grid-cols-list-cards');
    const out = renderToStaticMarkup(
      <AssetList items={[asset()]} presignEnabled={false} cache={cache} onOpen={() => {}} />,
    );
    expect(out).toContain('md:grid-cols-list-cards');
    expect(out).not.toContain('grid-cols-tiles');
    expect(out).not.toContain('grid-cols-[');
  });
});

describe('Brief card is ui/ListCard', () => {
  function card(overrides: Partial<BriefWithThumbnail> = {}): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief(overrides)} cache={cache} presignEnabled={false} href="/b/1" />
      </MemoryRouter>,
    );
  }

  it('fills the slots: line 1 title, line 2 objective, line 3 Due and the status tag', () => {
    const out = card();
    expect(out).toMatch(/^<div data-brief-card=""[^>]*data-list-card=""/);
    expect(out).toMatch(/data-list-card-line="1"[^]*data-list-card-title=""[^]*Spring launch/);
    expect(out).toMatch(/data-list-card-line="3"[^]*Due 1 Jul[^]*data-brief-status="open"/);
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
