import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import { briefsHeader, briefCardList } from '@/components/pages/BriefsPage';
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
    sort: 'newest',
    onSortChange: () => {},
    filter: 'all',
    onFilterChange,
  });
}

describe('briefsHeader', () => {
  it('uses the shared SectionHeader with a single sort control', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(1);
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
    title: `Brief ${id}`,
    objective: 'objective',
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
