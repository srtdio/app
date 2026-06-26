import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { Button } from '@/components/ui/Button';

type Value = 'recent' | 'name';

const sortOptions: SortOption<Value>[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
];

// SectionHeader is a pure presentational component (no hooks), so it can be
// called as a function and its element tree walked without a DOM, mirroring the
// SortMenu/ChannelList test style in this codebase.
function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function ariaLabel(el: ReactElement): string | undefined {
  return (el.props as { 'aria-label'?: string })['aria-label'];
}

describe('SectionHeader', () => {
  it('renders the search input and calls onChange when it changes', () => {
    const onChange = vi.fn();
    const tree = SectionHeader({ search: { value: 'hi', onChange, placeholder: 'Search files' } });
    const inputs = findAll(tree, (el) => el.type === 'input');
    expect(inputs).toHaveLength(1);
    const input = inputs[0]!.props as {
      value: string;
      placeholder: string;
      onChange: (event: { target: { value: string } }) => void;
    };
    expect(input.value).toBe('hi');
    expect(input.placeholder).toBe('Search files');
    input.onChange({ target: { value: 'next' } });
    expect(onChange).toHaveBeenCalledWith('next');
  });

  it('shows the clear button only when search has a value and clears via onChange', () => {
    const onChange = vi.fn();
    const empty = SectionHeader({ search: { value: '', onChange } });
    expect(findAll(empty, (el) => ariaLabel(el) === 'Clear search')).toHaveLength(0);

    const filled = SectionHeader({ search: { value: 'x', onChange } });
    const clears = findAll(filled, (el) => ariaLabel(el) === 'Clear search');
    expect(clears).toHaveLength(1);
    (clears[0]!.props as { onClick: () => void }).onClick();
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('renders the sort control', () => {
    const tree = SectionHeader({
      sort: { options: sortOptions, value: 'recent', onChange: () => {} },
    });
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(1);
  });

  it('renders a custom sort node when the { node } form is provided', () => {
    const node = <button type="button" aria-label="Consolidated sort" />;
    const tree = SectionHeader({ sort: { node } });
    // The provided node renders in the sort position; the declarative SortMenu
    // is not used for this form.
    expect(findAll(tree, (el) => ariaLabel(el) === 'Consolidated sort')).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === SortMenu)).toHaveLength(0);
  });

  it('renders the primary action button and calls onClick', () => {
    const onClick = vi.fn();
    const tree = SectionHeader({ primaryAction: { label: 'Add', onClick } });
    const buttons = findAll(tree, (el) => el.type === Button);
    expect(buttons).toHaveLength(1);
    expect(ariaLabel(buttons[0]!)).toBe('Add');
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a custom primary action node when one is provided', () => {
    const node = <button type="button" aria-label="Add asset" />;
    const tree = SectionHeader({ primaryAction: { node } });
    expect(findAll(tree, (el) => ariaLabel(el) === 'Add asset')).toHaveLength(1);
  });

  it('renders the chips passed as children', () => {
    const tree = SectionHeader({ children: <span data-testid="chip-all">All 3</span> });
    const chips = findAll(
      tree,
      (el) => (el.props as { 'data-testid'?: string })['data-testid'] === 'chip-all',
    );
    expect(chips).toHaveLength(1);
  });

  it('omits the sort control when sort is not provided and does not throw', () => {
    const render = () => SectionHeader({ search: { value: '', onChange: () => {} } });
    expect(render).not.toThrow();
    expect(findAll(render(), (el) => el.type === SortMenu)).toHaveLength(0);
  });
});
