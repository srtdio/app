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

// The workspace calendar the page reads its sections on: Mumbai, Monday weeks.
// Passed explicitly, so nothing below depends on the machine's timezone.
const CAL = { timeZone: 'Asia/Kolkata', weekStartDay: 1 };

// A fixed "now": Wednesday 2026-07-08, 12:00 in the workspace zone. Its week
// opens Monday 2026-07-06.
const NOW = new Date('2026-07-08T12:00:00+05:30');

// A created_at from WORKSPACE wall-clock parts: the offset is written into the
// string, so the instant reads back as that civil day in Asia/Kolkata anywhere.
function created(civil: string, time = '12:00'): string {
  return `${civil}T${time}:00+05:30`;
}

describe('deriveBriefGroups', () => {
  const briefs = [
    makeBrief('week', { created_at: created('2026-07-07') }), // This Week
    makeBrief('last', { created_at: created('2026-07-02') }), // Last Week
    makeBrief('june', { title: 'Launch plan', created_at: created('2026-06-10') }), // June
    makeBrief('may', { created_at: created('2026-05-05') }), // May
    makeBrief('closed', { status: 'closed', created_at: created('2026-07-06') }), // This Week
  ];

  it('renders one section per time bucket with correct labels and counts', () => {
    const groups = deriveBriefGroups(briefs, 'all', '', NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'Last Week', 'June', 'May']);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1, 1]);
    expect(groups.map((g) => g.key)).toEqual(['w0', 'w1', 'm-2026-06', 'm-2026-05']);
  });

  it('re-narrows to BriefWithThumbnail, preserving the same object references', () => {
    const groups = deriveBriefGroups(briefs, 'all', '', NOW, CAL);
    const week = groups[0]!.items.find((b) => b.id === 'week');
    expect(week).toBe(briefs[0]);
  });

  it('lets the status chip change section counts (Closed drops the open This Week brief)', () => {
    const groups = deriveBriefGroups(briefs, 'closed', '', NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This Week']);
    expect(groups[0]!.items.map((b) => b.id)).toEqual(['closed']);
  });

  it('lets search change section counts, dropping now-empty sections', () => {
    const groups = deriveBriefGroups(briefs, 'all', 'launch', NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['June']);
    expect(groups[0]!.items.map((b) => b.id)).toEqual(['june']);
  });

  it('buckets on the WORKSPACE zone, not the browser zone', () => {
    // 19:00Z on Sunday 2026-07-05 is already Monday the 6th in Mumbai, so the
    // same instant opens This Week there and closes Last Week in London.
    const brief = [makeBrief('edge', { created_at: '2026-07-05T19:00:00Z' })];
    expect(deriveBriefGroups(brief, 'all', '', NOW, CAL)[0]!.label).toBe('This Week');
    expect(
      deriveBriefGroups(brief, 'all', '', NOW, { timeZone: 'Europe/London', weekStartDay: 1 })[0]!
        .label,
    ).toBe('Last Week');
  });
});

interface DayShape {
  label: string;
  className: string;
  cards: number;
}

interface SectionShape {
  label: string;
  count: string;
  days: DayShape[];
}

// Walk one <section> from briefSections without rendering. Children are
// [headerDiv, dayNodes]: the header holds an <h3> label and a <span> count, and
// dayNodes is the flat [heading, grid, heading, grid, ...] sequence, one pair per
// civil day, each grid holding that day's BriefCard list.
function readSection(section: ReactElement): SectionShape {
  const [headerDiv, dayNodes] = (section.props as { children: [ReactElement, ReactElement[]] })
    .children;
  const [h3, span] = (headerDiv.props as { children: ReactElement[] }).children;
  const countParts = (span!.props as { children: (string | number)[] }).children;
  const days: DayShape[] = [];
  for (let i = 0; i < dayNodes.length; i += 2) {
    const heading = dayNodes[i]!.props as { children: string; className: string };
    const grid = dayNodes[i + 1]!.props as { children: ReactElement[] };
    days.push({
      label: String(heading.children),
      className: heading.className,
      cards: grid.children.length,
    });
  }
  return {
    label: String((h3!.props as { children: string }).children),
    count: countParts.join(''),
    days,
  };
}

// The day heading is a plain label: token colours only (text-fg-2 flips with the
// theme), never sticky, never interactive, no transition or transform.
const DAY_HEADING_CLASS = 'pt-3 pb-1 text-xs font-medium text-fg-2';

describe('briefSections', () => {
  const cache = {
    peek: () => null,
    resolve: async () => ({ url: '', expiresAt: 0 }),
  } as unknown as PresignCache;

  function sectionsFor(briefs: BriefWithThumbnail[]): ReactElement[] {
    return briefSections({
      groups: deriveBriefGroups(briefs, 'all', '', NOW, CAL),
      timeZone: CAL.timeZone,
      cache,
      presignEnabled: true,
      closingId: null,
      closeError: null,
      onClose: () => {},
      onOpen: () => {},
    });
  }

  it('renders a section per group with label, brief count and one card per brief', () => {
    const sections = sectionsFor([
      makeBrief('a', { created_at: created('2026-07-07') }),
      makeBrief('b', { created_at: created('2026-07-06') }),
      makeBrief('c', { created_at: created('2026-06-10') }),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => readSection(s))).toEqual([
      {
        label: 'This Week',
        count: '2 briefs',
        days: [
          { label: 'Tuesday 7 Jul', className: DAY_HEADING_CLASS, cards: 1 },
          { label: 'Monday 6 Jul', className: DAY_HEADING_CLASS, cards: 1 },
        ],
      },
      {
        label: 'June',
        count: '1 brief',
        days: [{ label: 'Wednesday 10 Jun', className: DAY_HEADING_CLASS, cards: 1 }],
      },
    ]);
    const firstCard = (
      (sections[0]!.props as { children: [ReactElement, ReactElement[]] }).children[1][1]!
        .props as {
        children: ReactElement[];
      }
    ).children[0]!;
    expect(firstCard.type).toBe(BriefCard);
  });

  it('splits one time group across two day headings, newest day first', () => {
    const sections = sectionsFor([
      makeBrief('mon', { created_at: created('2026-07-06', '09:00') }),
      makeBrief('wed-late', { created_at: created('2026-07-08', '18:00') }),
      makeBrief('wed-early', { created_at: created('2026-07-08', '08:00') }),
    ]);
    expect(sections).toHaveLength(1);
    const { days } = readSection(sections[0]!);
    expect(days.map((d) => d.label)).toEqual(['Wednesday 8 Jul', 'Monday 6 Jul']);
    expect(days.map((d) => d.cards)).toEqual([2, 1]);
  });

  it('renders a single day heading when every brief in a group shares a day', () => {
    const sections = sectionsFor([
      makeBrief('a', { created_at: created('2026-07-07', '20:00') }),
      makeBrief('b', { created_at: created('2026-07-07', '06:00') }),
    ]);
    const { days } = readSection(sections[0]!);
    expect(days).toEqual([{ label: 'Tuesday 7 Jul', className: DAY_HEADING_CLASS, cards: 2 }]);
  });

  it('reads the day heading in the workspace zone, not the browser zone', () => {
    const briefs = [makeBrief('edge', { created_at: '2026-07-07T19:00:00Z' })];
    const groups = deriveBriefGroups(briefs, 'all', '', NOW, CAL);
    const shared = {
      groups,
      cache,
      presignEnabled: true,
      closingId: null,
      closeError: null,
      onClose: () => {},
      onOpen: () => {},
    };
    expect(
      readSection(briefSections({ ...shared, timeZone: 'Asia/Kolkata' })[0]!).days[0]!.label,
    ).toBe('Wednesday 8 Jul');
    expect(
      readSection(briefSections({ ...shared, timeZone: 'Europe/London' })[0]!).days[0]!.label,
    ).toBe('Tuesday 7 Jul');
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
