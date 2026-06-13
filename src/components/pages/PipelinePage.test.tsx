import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/events', () => ({ dispatchSorted: vi.fn() }));

import { pipelineHeader } from '@/components/pages/PipelinePage';
import { dispatchSorted } from '@/lib/events';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu } from '@/components/ui/SortMenu';
import { Tabs } from '@/components/shell/Tabs';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds search/sort/primaryAction in props, so it
// is expanded by calling its render once (mirroring SectionHeader's own tests)
// while leaving stateful children (SortMenu, Tabs) as unexpanded elements.
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

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  const all: ReactElement[] = [];
  collect(tree, all);
  for (const el of all) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') out.push(child);
  }
  return out;
}

function header(): ReactElement {
  return pipelineHeader({
    search: '',
    onSearchChange: () => {},
    sort: 'newest',
    onSortChange: () => {},
    stage: 'all',
    onStageChange: () => {},
  });
}

describe('pipelineHeader', () => {
  it('uses the shared SectionHeader with a single real sort control', () => {
    const tree = header();
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(1);
  });

  it('dispatches sorted:create-post from the "+" action', () => {
    const button = findAll(
      header(),
      (el) => (el.props as { 'aria-label'?: string })['aria-label'] === 'Create post',
    );
    expect(button).toHaveLength(1);
    (button[0]!.props as { onClick: () => void }).onClick();
    expect(dispatchSorted).toHaveBeenCalledWith('sorted:create-post');
  });

  it('keeps the stage tabs in the filter slot', () => {
    const tabs = findAll(header(), (el) => el.type === Tabs);
    expect(tabs).toHaveLength(1);
    const items = (tabs[0]!.props as { items: { label: string }[] }).items;
    expect(items.map((t) => t.label)).toContain('All');
  });

  it('drops the dead Sort button and decorative add-chips', () => {
    const labels = texts(header());
    expect(labels).not.toContain('Sort');
    expect(labels).not.toContain('+ Owner');
    expect(labels).not.toContain('+ Bucket');
    expect(labels).not.toContain('+ Date');
  });
});
