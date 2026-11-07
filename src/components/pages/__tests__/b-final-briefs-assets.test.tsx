// Layout B-final, Briefs + Assets: the screens render the shared parts. Asset
// items and brief cards are ui/ListCard (picture; line 1 title + time; line 2
// preview + one grey tag; no ⋮, the tick on the picture while selecting),
// both grids fill the laptop width through the parts' named auto-fill
// columns, and a card keeps its lines and slots across states.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AssetList, AssetListCard } from '@/components/pages/assets/AssetListCard';
import { BriefCard } from '@/components/pages/BriefCard';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { StatusDot } from '@/components/ui/StatusDot';
import { LIST_CARD_GRID, type ListCardSelect } from '@/components/ui/ListCard';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import type { BriefWithThumbnail } from '@srtdio/briefs';

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
      {...props}
    />,
  );
}

/** The card's line wrappers and text slots, in markup order: the footprint every state keeps. */
function slots(html: string): string[] {
  return [...html.matchAll(/data-list-card-(line="\d"|title=""|preview=""|time=""|tag="")/g)].map(
    (m) => m[1]!,
  );
}

function selectState(active: boolean, chosen: boolean): ListCardSelect {
  return { active, chosen, onEnter: () => {}, onToggle: () => {} };
}

describe('Assets item is ui/ListCard', () => {
  it('renders the part: the picture first, then the name and time, then the facts and the tab tag', () => {
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
    // Line 1: the name, then the time on the right; line 2: the facts, then the tag.
    expect(time).toBeGreaterThan(name);
    expect(meta).toBeGreaterThan(time);
    expect(tag).toBeGreaterThan(meta);
    // formatAdded on the device zone: uploaded the same day reads its clock time.
    expect(out).toMatch(/data-asset-uploaded=""[^>]*>\d{1,2}:\d{2} (AM|PM)</);
    expect(out).not.toContain('data-tile');
  });

  it('has no ⋮: the old menu rows live on the select bar', () => {
    const out = tile();
    expect(out).not.toContain('data-card-menu');
    expect(out).not.toContain('data-list-card-more');
    expect(out).not.toContain('More actions');
  });

  it('select mode ticks the picture; no corner overlay, no menu', () => {
    const ticked = tile({ select: selectState(true, true) });
    expect(ticked).toMatch(/data-list-card-picture="[^"]*"[^]*data-list-card-tick="on"/);
    expect(ticked).not.toContain('data-card-menu');
    expect(ticked).not.toContain('data-card-select');
    // The chosen row is the flat panel-2 fill on the row root, no lit height.
    expect(ticked).toMatch(/data-list-card=""[^>]*class="[^"]*\bbg-panel-2\b/);
    expect(ticked).not.toContain('lit-selected');
  });

  it('keeps its footprint across states: the same lines and slots', () => {
    const states = [
      tile(),
      tile({ select: selectState(false, false) }),
      tile({ select: selectState(true, false) }),
      tile({ select: selectState(true, true) }),
      tile({ item: asset({ sizeBytes: null, pageCount: 4 }) }),
    ];
    const first = slots(states[0]!);
    expect(first).toEqual(['line="1"', 'title=""', 'time=""', 'line="2"', 'preview=""', 'tag=""']);
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
  // Two months before the default due day (1 Jul), so it reads "1 Jul".
  const BRIEF_NOW = new Date('2026-05-01T12:00:00Z');
  function card(overrides: Partial<BriefWithThumbnail> = {}, now: Date = BRIEF_NOW): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard
          brief={brief(overrides)}
          cache={cache}
          presignEnabled={false}
          href="/b/1"
          timeZone="UTC"
          now={now}
        />
      </MemoryRouter>,
    );
  }

  it('fills the slots: line 1 title and due words, line 2 the brief text then the status tag', () => {
    const out = card();
    expect(out).toMatch(/^<div data-brief-card=""[^>]*data-list-card=""/);
    expect(out).toMatch(
      /data-list-card-line="1"[^]*data-list-card-title=""[^]*Spring launch[^]*>1 Jul<[^]*data-list-card-line="2"/,
    );
    expect(out).toMatch(
      /data-list-card-line="2"[^]*data-list-card-preview=""[^>]*>Tease the spring drop.<[^]*data-brief-status="open"/,
    );
    expect(out).not.toContain('data-list-card-line="3"');
    expect(out).not.toContain('Target');
    expect(out).not.toContain('Due ');
    // No select mode on Briefs: no tick, no menu.
    expect(out).not.toContain('data-list-card-tick');
    expect(out).not.toContain('data-card-menu');
    // The cover link is the card's one link, at its corners.
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    expect(out).toMatch(/<a [^>]*class="[^"]*absolute inset-0/);
  });

  it('a closed brief is the muted row (title in fg-3), never dimmed', () => {
    const out = card({ status: 'closed' });
    expect(out).toMatch(/data-list-card-title=""[^>]*class="[^"]*\btext-fg-3\b/);
    expect(card()).not.toMatch(/data-list-card-title=""[^>]*class="[^"]*\btext-fg-3\b/);
    expect(out).not.toContain('lit-card-muted');
    expect(out).not.toContain('opacity');
  });

  it('the time reads words only: Today, Wed, 8 Oct, else "2d late" in the bad tone', () => {
    expect(card({}, new Date('2026-07-01T09:00:00Z'))).toMatch(
      /data-brief-due="[^"]*"[^>]*>Today</,
    );
    expect(card({}, new Date('2026-06-28T09:00:00Z'))).toContain('>Wed<');
    expect(card({ target_date: '2026-10-08' })).toContain('>8 Oct<');
    const late = card({}, new Date('2026-07-03T09:00:00Z'));
    expect(late).toMatch(/data-list-card-time=""[^>]*class="[^"]*text-bad[^"]*">2d late</);
    for (const out of [late, card()]) {
      expect(out).not.toContain('Due ');
      expect(out).not.toContain('Overdue');
    }
    // A closed brief is never late.
    const closed = card({ status: 'closed' }, new Date('2026-07-03T09:00:00Z'));
    expect(closed).toContain('>1 Jul<');
    expect(closed).not.toContain('late<');
    expect(closed).not.toContain('text-bad');
  });

  it('the Open / Closed tag is the one grey tag', () => {
    for (const status of ['open', 'closed'] as const) {
      const out = card({ status });
      expect(out.match(/data-list-card-tag=""/g)).toHaveLength(1);
      expect(out).toContain('bg-panel-2 text-fg-2');
      expect(out).not.toContain('bg-accent-soft');
    }
  });

  it('the Briefs list is LIST_CARD_GRID: one column on phone, auto-fill (360 min) on laptop', () => {
    expect(LIST_CARD_GRID).toContain('grid-cols-1');
    expect(LIST_CARD_GRID).toContain('md:grid-cols-list-cards');
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
