import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import { briefsHeader } from '@/components/pages/BriefsPage';
import { dispatchSorted } from '@/lib/events';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { Chip } from '@/components/ui/Chip';
import type { BriefFilter } from '@/lib/brief-list';

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
