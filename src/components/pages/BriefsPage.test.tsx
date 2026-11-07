import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  briefsHeader,
  briefsTopbarActions,
  briefCardList,
  briefSections,
  briefsEmptyState,
  createdToast,
  deriveBriefGroups,
  deriveSortedBriefs,
} from '@/components/pages/BriefsPage';
import { BriefCard } from '@/components/pages/BriefCard';
import { dispatchSorted } from '@/lib/events';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { Chip } from '@/components/ui/Chip';
import { TopbarPlus } from '@/components/shell/topbar-actions';
import { INDUCTION_KEYS } from '@/lib/induction';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefFilter } from '@/lib/brief-list';
import type { BriefWithThumbnail } from '@srtdio/briefs';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds the chips in props, so it is expanded by
// calling its render once (mirroring SectionHeader's own tests).
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
  return briefsHeader({ filter: 'all', onFilterChange });
}

describe('briefsHeader (decisions A, B: chips only)', () => {
  it('the shared SectionHeader with no search, sort or New brief in the row', () => {
    const tree = header();
    const headers = findAll(tree, (el) => el.type === SectionHeader);
    expect(headers).toHaveLength(1);
    const props = headers[0]!.props as Record<string, unknown>;
    for (const gone of ['search', 'sort', 'primaryAction', 'title']) {
      expect(props).not.toHaveProperty(gone);
    }
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === TopbarPlus)).toHaveLength(0);
    expect(
      findAll(
        tree,
        (el) => (el.props as { 'data-induction'?: string })['data-induction'] === 'briefs-new',
      ),
    ).toHaveLength(0);
  });

  it('renders the All / Open / Closed filter chips and wires them', () => {
    const onFilterChange = vi.fn();
    const chips = findAll(header(onFilterChange), (el) => el.type === Chip);
    const labels = chips.map((c) => (c.props as { label: string }).label);
    expect(labels).toEqual(['All', 'Open', 'Closed']);
    (chips[1]!.props as { onClick: () => void }).onClick();
    expect(onFilterChange).toHaveBeenCalledWith('open');
  });

  it('hands each chip its count (ui/Chip shows it only above 0)', () => {
    const tree = briefsHeader({
      filter: 'all',
      onFilterChange: () => {},
      counts: { all: 3, open: 3, closed: 0 },
    });
    const counts = findAll(tree, (el) => el.type === Chip).map(
      (c) => (c.props as { count?: number }).count,
    );
    expect(counts).toEqual([3, 3, 0]);
  });
});

describe('briefsTopbarActions (decision A: sort and "+" in the top bar)', () => {
  it('agency side: sort is the shared SortMenu over Due date (default) and Newest first', () => {
    const onChange = vi.fn();
    const { sort, primary } = briefsTopbarActions({
      canCreate: false,
      sort: { value: 'due', onChange },
    });
    expect(sort).toBeDefined();
    expect(sort!.type).toBe(SortMenu);
    const props = sort!.props as {
      options: { value: string; label: string }[];
      value: string;
      onChange: (value: string) => void;
    };
    expect(props.options.map((o) => o.label)).toEqual(['Due date', 'Newest first']);
    expect(props.value).toBe('due');
    props.onChange('updated');
    expect(onChange).toHaveBeenCalledWith('updated');
    // The agency side cannot raise a brief: no "+".
    expect(primary).toBeUndefined();
  });

  it('client side (brief.create): "+" labelled New brief with the old induction key; no sort', () => {
    const { sort, primary } = briefsTopbarActions({ canCreate: true });
    expect(sort).toBeUndefined();
    expect(primary).toBeDefined();
    expect(primary!.type).toBe(TopbarPlus);
    const props = primary!.props as { label: string; induction?: string; onClick: () => void };
    expect(props.label).toBe('New brief');
    expect(props.induction).toBe(INDUCTION_KEYS.briefsNew);
    props.onClick();
    expect(dispatchSorted).toHaveBeenCalledWith('sorted:create-brief');
  });

  it('without brief.create there is no "+"', () => {
    expect(briefsTopbarActions({ canCreate: false }).primary).toBeUndefined();
  });

  it('the page publishes them with useTopbarActions, sort only on the agency side', () => {
    const src = readFileSync(fileURLToPath(new URL('./BriefsPage.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('useTopbarActions(topbar)');
    expect(src).toContain('canCreate: canCreateBrief');
    expect(src).toContain('...(showSort ? { sort: { value: sort, onChange: setSort } } : {})');
  });
});

describe('decision B: no screen search on Briefs', () => {
  it('the page holds no search state, search read, debounce or search NoResults', () => {
    const src = readFileSync(fileURLToPath(new URL('./BriefsPage.tsx', import.meta.url)), 'utf8');
    for (const gone of [
      'useServerSearch',
      'serverSearchQuery',
      'briefSearch',
      'Search briefs',
      'NoResults',
      'filterByTitle',
      "searchParams.get('q')",
    ]) {
      expect(src).not.toContain(gone);
    }
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
  href: string;
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
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
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
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
    });
    expect((cards[0]!.props as BriefCardElementProps).presignEnabled).toBe(false);
  });

  it('wires each card to its own detail link', () => {
    const cards = briefCardList({
      briefs: [makeBrief('a'), makeBrief('b')],
      cache,
      presignEnabled: true,
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
    });
    const [first, second] = cards.map((c) => c.props as BriefCardElementProps);
    expect(first!.href).toBe('/briefs/a');
    expect(second!.href).toBe('/briefs/b');
  });

  it('threads the workspace zone each card reads its due date on', () => {
    const cards = briefCardList({
      briefs: [makeBrief('a')],
      cache,
      presignEnabled: true,
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
      timeZone: 'Asia/Kolkata',
    });
    expect((cards[0]!.props as { timeZone?: string }).timeZone).toBe('Asia/Kolkata');
  });

  it('threads the list ONE clock into every card (no clock per card)', () => {
    const now = new Date('2026-11-07T09:00:00Z');
    const cards = briefCardList({
      briefs: [makeBrief('a'), makeBrief('b')],
      cache,
      presignEnabled: true,
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
      now,
    });
    for (const card of cards) expect((card.props as { now?: Date }).now).toBe(now);
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
    const groups = deriveBriefGroups(briefs, 'all', NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This week', 'Last week', 'June', 'May']);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 1, 1]);
    expect(groups.map((g) => g.key)).toEqual(['w0', 'w1', 'm-2026-06', 'm-2026-05']);
  });

  it('re-narrows to BriefWithThumbnail, preserving the same object references', () => {
    const groups = deriveBriefGroups(briefs, 'all', NOW, CAL);
    const week = groups[0]!.items.find((b) => b.id === 'week');
    expect(week).toBe(briefs[0]);
  });

  it('lets the status chip change section counts (Closed drops the open This Week brief)', () => {
    const groups = deriveBriefGroups(briefs, 'closed', NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This week']);
    expect(groups[0]!.items.map((b) => b.id)).toEqual(['closed']);
  });

  it('buckets on the WORKSPACE zone, not the browser zone', () => {
    // 19:00Z on Sunday 2026-07-05 is already Monday the 6th in Mumbai, so the
    // same instant opens This Week there and closes Last Week in London.
    const brief = [makeBrief('edge', { created_at: '2026-07-05T19:00:00Z' })];
    expect(deriveBriefGroups(brief, 'all', NOW, CAL)[0]!.label).toBe('This week');
    expect(
      deriveBriefGroups(brief, 'all', NOW, { timeZone: 'Europe/London', weekStartDay: 1 })[0]!
        .label,
    ).toBe('Last week');
  });
});

interface DayShape {
  label: string;
  className: string;
  cards: number;
}

interface SectionShape {
  label: string;
  days: DayShape[];
}

// Walk one <section> from briefSections without rendering. Children are
// [headerDiv, dayNodes]: the header holds only an <h3> label (no count: counts
// live on the chips), and dayNodes is the flat [heading, grid, heading, grid,
// ...] sequence, one pair per civil day, each grid holding that day's BriefCard
// list.
function readSection(section: ReactElement): SectionShape {
  const [headerDiv, dayNodes] = (section.props as { children: [ReactElement, ReactElement[]] })
    .children;
  const h3 = (headerDiv.props as { children: ReactElement }).children;
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
    label: String((h3.props as { children: string }).children),
    days,
  };
}

// The day heading is a plain label: token colours only (text-fg-2 flips with the
// theme), never sticky, never interactive, no transition or transform.
const DAY_HEADING_CLASS = 'pt-3 pb-1 text-sm font-medium text-fg-2';

describe('briefSections', () => {
  const cache = {
    peek: () => null,
    resolve: async () => ({ url: '', expiresAt: 0 }),
  } as unknown as PresignCache;

  function sectionsFor(briefs: BriefWithThumbnail[]): ReactElement[] {
    return briefSections({
      groups: deriveBriefGroups(briefs, 'all', NOW, CAL),
      timeZone: CAL.timeZone,
      now: NOW,
      cache,
      presignEnabled: true,
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
    });
  }

  it('renders a section per group with label (no count) and one card per brief', () => {
    const sections = sectionsFor([
      makeBrief('a', { created_at: created('2026-07-07') }),
      makeBrief('b', { created_at: created('2026-07-06') }),
      makeBrief('c', { created_at: created('2026-06-10') }),
    ]);
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => readSection(s))).toEqual([
      {
        label: 'This week',
        days: [
          { label: 'Yesterday', className: DAY_HEADING_CLASS, cards: 1 },
          { label: 'Mon 6 Jul', className: DAY_HEADING_CLASS, cards: 1 },
        ],
      },
      {
        label: 'June',
        days: [{ label: 'Wed 10 Jun', className: DAY_HEADING_CLASS, cards: 1 }],
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
    expect(days.map((d) => d.label)).toEqual(['Today', 'Mon 6 Jul']);
    expect(days.map((d) => d.cards)).toEqual([2, 1]);
  });

  it('renders a single day heading when every brief in a group shares a day', () => {
    const sections = sectionsFor([
      makeBrief('a', { created_at: created('2026-07-07', '20:00') }),
      makeBrief('b', { created_at: created('2026-07-07', '06:00') }),
    ]);
    const { days } = readSection(sections[0]!);
    expect(days).toEqual([{ label: 'Yesterday', className: DAY_HEADING_CLASS, cards: 2 }]);
  });

  it('reads the day heading in the workspace zone, not the browser zone', () => {
    const briefs = [makeBrief('edge', { created_at: '2026-07-07T19:00:00Z' })];
    const groups = deriveBriefGroups(briefs, 'all', NOW, CAL);
    const shared = {
      groups,
      now: NOW,
      cache,
      presignEnabled: true,
      hrefFor: (brief: BriefWithThumbnail) => `/briefs/${brief.id}`,
    };
    expect(
      readSection(briefSections({ ...shared, timeZone: 'Asia/Kolkata' })[0]!).days[0]!.label,
    ).toBe('Today');
    expect(
      readSection(briefSections({ ...shared, timeZone: 'Europe/London' })[0]!).days[0]!.label,
    ).toBe('Yesterday');
  });
});

describe('briefsEmptyState', () => {
  it('client with no open briefs: the New brief state', () => {
    expect(briefsEmptyState('open', 0, true)).toEqual({ kind: 'client-empty' });
    expect(briefsEmptyState('open', 3, true)).toEqual({ kind: 'client-empty' });
  });

  it('agency with no briefs: the one-line state', () => {
    expect(briefsEmptyState('open', 0, false)).toEqual({ kind: 'agency-empty' });
    expect(briefsEmptyState('all', 0, false)).toEqual({ kind: 'agency-empty' });
  });

  it('a chip with nothing under it: a heading, no Clear', () => {
    expect(briefsEmptyState('closed', 2, true)).toEqual({
      kind: 'filtered',
      title: 'Closed briefs show up here.',
    });
    expect(briefsEmptyState('open', 2, false)).toEqual({
      kind: 'filtered',
      title: 'Open briefs show up here.',
    });
  });
});

describe('deriveSortedBriefs', () => {
  const briefs = [
    makeBrief('none', { target_date: null, updated_at: '2026-07-09T00:00:00Z' }),
    makeBrief('late', { target_date: '2026-08-01', updated_at: '2026-07-01T00:00:00Z' }),
    makeBrief('soon', { target_date: '2026-07-20', updated_at: '2026-07-02T00:00:00Z' }),
    makeBrief('shut', {
      status: 'closed',
      target_date: '2026-07-10',
      updated_at: '2026-07-08T00:00:00Z',
    }),
  ];

  it('filters by chip, then sorts by due date (undated last)', () => {
    expect(deriveSortedBriefs(briefs, 'open', 'due').map((b) => b.id)).toEqual([
      'soon',
      'late',
      'none',
    ]);
  });

  it('recently updated puts the newest edit first, keeping object references', () => {
    const out = deriveSortedBriefs(briefs, 'all', 'updated');
    expect(out.map((b) => b.id)).toEqual(['none', 'shut', 'soon', 'late']);
    expect(out[0]).toBe(briefs[0]);
  });
});

describe('createdToast', () => {
  it('a lost note is an error toast with Add note, never the success style', () => {
    const navigate = vi.fn();
    const toast = createdToast({ briefId: 'b9', noteFailed: true }, navigate);
    expect(toast.title).toBe('Brief created. Your note did not post.');
    expect(toast.tone).toBe('error');
    expect(toast.action?.label).toBe('Add note');
    toast.action?.onPress();
    expect(navigate).toHaveBeenCalledWith('/briefs/b9?note=1');
  });

  it('a clean create is the success toast with Open', () => {
    const toast = createdToast({ briefId: 'b9', noteFailed: false }, vi.fn());
    expect(toast.title).toBe('Brief created');
    expect(toast.tone).toBe('success');
    expect(toast.action?.label).toBe('Open');
  });
});
