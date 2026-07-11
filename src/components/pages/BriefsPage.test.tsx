import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import {
  briefsHeader,
  briefCardList,
  briefSections,
  briefsCountLine,
  deriveBriefGroups,
} from '@/components/pages/BriefsPage';
import { BriefCard } from '@/components/pages/BriefCard';
import { dispatchSorted } from '@/lib/events';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { Chip } from '@/components/ui/Chip';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefFilter } from '@/lib/brief-list';
import type { BriefWithThumbnail } from '@srtdio/briefs';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds search/sort/primaryAction in props, so it
// is expanded by calling its render once (mirroring SectionHeader's own tests)
// while leaving stateful children (SortMenu) as unexpanded elements.
function expandSectionHeader(el: ReactElement): ReactElement {
  return (el.type as unknown as (props: unknown) => ReactElement)(el.props);
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  if (node.type === SectionHeader) {
    collect(expandSectionHeader(node), found);
    return;
  }
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function header(onFilterChange: (filter: BriefFilter) => void = () => {}): ReactElement {
  return briefsHeader({
    search: '',
    onSearchChange: () => {},
    filter: 'all',
    onFilterChange,
  });
}

describe('briefsHeader', () => {
  it('uses the shared SectionHeader with no sort control', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
  });

  it('dispatches sorted:create-brief from the "+" action', () => {
    const button = findAll(
      header(),
      (el) => (el.props as { 'aria-label'?: string })['aria-label'] === 'Create brief',
    );
    expect(button).toHaveLength(1);
    (button[0]!.props as { onClick: () => void }).onClick();
    expect(dispatchSorted).toHaveBeenCalledWith('sorted:create-brief');
  });

  it('renders the All / Open / Closed filter chips and wires them', () => {
    const onFilterChange = vi.fn();
    const chips = findAll(header(onFilterChange), (el) => el.type === Chip);
    const labels = chips.map((c) => (c.props as { label: string }).label);
    expect(labels).toEqual(['All', 'Open', 'Closed']);
    (chips[1]!.props as { onClick: () => void }).onClick();
    expect(onFilterChange).toHaveBeenCalledWith('open');
  });
});

function makeBrief(id: string, overrides: Partial<BriefWithThumbnail> = {}): BriefWithThumbnail {
  return {
    id,
    workspace_id: 'w1',
    number: 1,
    title: `Brief ${id}`,
    objective: 'objective',
    legacy_author_name: null,
    status: 'open',
    target_date: null,
    reference_links: null,
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

interface BriefCardElementProps {
  brief: BriefWithThumbnail;
  cache: PresignCache;
  presignEnabled: boolean;
  closing: boolean;
  closeError: string | null;
  onOpen: () => void;
}

describe('briefCardList presign wiring', () => {
  // A sentinel cache instance: the test only asserts referential identity, so it
  // never needs real presign behaviour.
  const cache = {
    peek: () => null,
    resolve: async () => ({ url: '', expiresAt: 0 }),
  } as unknown as PresignCache;

  it('builds one card per brief and threads the SAME cache instance into every card', () => {
    const briefs = [makeBrief('a'), makeBrief('b'), makeBrief('c')];
    const cards = briefCardList({
      briefs,
      cache,
      presignEnabled: true,
      closingId: null,
      closeError: null,
      onClose: () => {},
      onOpen: () => {},
    });
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.type).toBe(BriefCard);
      const props = card.props as BriefCardElementProps;
      // The page builds exactly ONE PresignCache and shares it: every card gets the
      // identical instance, never a per-card cache.
      expect(props.cache).toBe(cache);
      expect(props.presignEnabled).toBe(true);
    }
  });

  it('threads presignEnabled=false through unchanged', () => {
    const cards = briefCardList({
      briefs: [makeBrief('a')],
      cache,
      presignEnabled: false,
      closingId: null,
      closeError: null,
      onClose: () => {},
      onOpen: () => {},
    });
    expect((cards[0]!.props as BriefCardElementProps).presignEnabled).toBe(false);
  });

  it('wires per-brief closing, close error and open from the brief id', () => {
    const onOpen = vi.fn();
    const cards = briefCardList({
      briefs: [makeBrief('a'), makeBrief('b')],
      cache,
      presignEnabled: true,
      closingId: 'b',
      closeError: { id: 'b', message: 'nope' },
      onClose: () => {},
      onOpen,
    });
    const [first, second] = cards.map((c) => c.props as BriefCardElementProps);
    expect(first!.closing).toBe(false);
    expect(first!.closeError).toBeNull();
    expect(second!.closing).toBe(true);
    expect(second!.closeError).toBe('nope');
    second!.onOpen();
    expect(onOpen).toHaveBeenCalledWith('b');
  });
});

// A fixed "now": Wednesday 2026-07-08 (local). Its week opens Monday 2026-07-06.
const NOW = new Date(2026, 6, 8, 12, 0, 0);

function created(year: number, monthIndex: number, day: number): string {
  return new Date(year, monthIndex, day, 12, 0, 0).toISOString();
}

describe('deriveBriefGroups', () => {
  const briefs = [
    makeBrief('week', { created_at: created(2026, 6, 7) }), // This Week
    makeBrief('last', { created_at: created(2026, 6, 2) }), // Last Week
    makeBrief('june', { title: 'Launch plan', created_at: created(2026, 5, 10) }), // June
    makeBrief('may', { created_at: created(2026, 4, 5) }), // May
    makeBrief('closed', { status: 'closed', created_at: created(2026, 6, 6) }), // This Week
  ];

  it('renders one section per time bucket with correct labels and counts', () => {
    const groups = deriveBriefGroups(briefs, 'all', '', NOW);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'Last Week', 'June', 'May']);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1, 1]);
    expect(groups.map((g) => g.key)).toEqual(['w0', 'w1', 'm-2026-06', 'm-2026-05']);
  });

  it('re-narrows to BriefWithThumbnail, preserving the same object references', () => {
    const groups = deriveBriefGroups(briefs, 'all', '', NOW);
    const week = groups[0]!.items.find((b) => b.id === 'week');
    expect(week).toBe(briefs[0]);
  });

  it('lets the status chip change section counts (Closed drops the open This Week brief)', () => {
    const groups = deriveBriefGroups(briefs, 'closed', '', NOW);
    expect(groups.map((g) => g.label)).toEqual(['This Week']);
    expect(groups[0]!.items.map((b) => b.id)).toEqual(['closed']);
  });

  it('lets search change section counts, dropping now-empty sections', () => {
    const groups = deriveBriefGroups(briefs, 'all', 'launch', NOW);
    expect(groups.map((g) => g.label)).toEqual(['June']);
    expect(groups[0]!.items.map((b) => b.id)).toEqual(['june']);
  });
});

interface SectionShape {
  label: string;
  count: string;
  cards: number;
}

// Walk one <section> from briefSections into its label, count text, and card
// tally without rendering: children are [headerDiv, gridDiv]; the header holds
// an <h3> label and a <span> count, the grid holds the BriefCard list.
function readSection(section: ReactElement): SectionShape {
  const [headerDiv, gridDiv] = (section.props as { children: ReactElement[] }).children;
  const [h3, span] = (headerDiv!.props as { children: ReactElement[] }).children;
  const cards = (gridDiv!.props as { children: ReactElement[] }).children;
  const countParts = (span!.props as { children: (string | number)[] }).children;
  return {
    label: String((h3!.props as { children: string }).children),
    count: countParts.join(''),
    cards: cards.length,
  };
}

describe('briefSections', () => {
  const cache = {
    peek: () => null,
    resolve: async () => ({ url: '', expiresAt: 0 }),
  } as unknown as PresignCache;

  it('renders a section per group with label, brief count and one card per brief', () => {
    const groups = deriveBriefGroups(
      [
        makeBrief('a', { created_at: created(2026, 6, 7) }),
        makeBrief('b', { created_at: created(2026, 6, 6) }),
        makeBrief('c', { created_at: created(2026, 5, 10) }),
      ],
      'all',
      '',
      NOW,
    );
    const sections = briefSections({
      groups,
      cache,
      presignEnabled: true,
      closingId: null,
      closeError: null,
      onClose: () => {},
      onOpen: () => {},
    });
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => readSection(s))).toEqual([
      { label: 'This Week', count: '2 briefs', cards: 2 },
      { label: 'June', count: '1 brief', cards: 1 },
    ]);
    const firstCard = (
      (sections[0]!.props as { children: ReactElement[] }).children[1]!.props as {
        children: ReactElement[];
      }
    ).children[0]!;
    expect(firstCard.type).toBe(BriefCard);
  });
});

describe('briefsCountLine', () => {
  it('formats total and open, using the plural brief unit', () => {
    expect(briefsCountLine(3, 2)).toBe('3 briefs · 2 open');
  });

  it('uses the singular brief unit for a single brief', () => {
    expect(briefsCountLine(1, 1)).toBe('1 brief · 1 open');
  });
});
