import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ICON_SIZE, IconPlus } from '@/components/ui/icons';

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
  // IconButton takes `label` and renders it as aria-label.
  const props = el.props as { 'aria-label'?: string; label?: string };
  return props['aria-label'] ?? props.label;
}

describe('SectionHeader', () => {
  it('renders the search input and calls onChange when it changes', () => {
    const onChange = vi.fn();
    const tree = SectionHeader({
      search: { value: 'hi', onChange, placeholder: 'Search files', label: 'Search files' },
    });
    const inputs = findAll(tree, (el) => el.type === Input || el.type === 'input');
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
    const empty = SectionHeader({ search: { value: '', onChange, label: 'Search' } });
    expect(findAll(empty, (el) => ariaLabel(el) === 'Clear search')).toHaveLength(0);

    const filled = SectionHeader({ search: { value: 'x', onChange, label: 'Search' } });
    const clears = findAll(filled, (el) => ariaLabel(el) === 'Clear search');
    expect(clears).toHaveLength(1);
    // The ghost "Clear" text Button, never an X icon.
    expect(clears[0]!.type).toBe(Button);
    const props = clears[0]!.props as { variant?: string; children?: ReactNode };
    expect(props.variant).toBe('ghost');
    expect(props.children).toBe('Clear');
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

  it('the declarative New button leads with IconPlus at the inline size', () => {
    const tree = SectionHeader({ primaryAction: { label: 'New post', onClick: vi.fn() } });
    const plus = findAll(tree, (el) => el.type === IconPlus);
    expect(plus).toHaveLength(1);
    expect((plus[0]!.props as { size?: number }).size).toBe(ICON_SIZE.inline);
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
    const render = () =>
      SectionHeader({ search: { value: '', onChange: () => {}, label: 'Search' } });
    expect(render).not.toThrow();
    expect(findAll(render(), (el) => el.type === SortMenu)).toHaveLength(0);
  });
});

describe('SectionHeader fixed row height', () => {
  function rowClass(tree: ReactNode): string {
    const row = findAll(tree, (el) => {
      const cls = (el.props as { className?: string }).className ?? '';
      return el.type === 'div' && cls.includes('px-4 md:px-6 mt-3 flex');
    })[0];
    return (row?.props as { className?: string } | undefined)?.className ?? '';
  }

  it('pins the search row to 44px so every list tab starts at the same height', () => {
    const tree = SectionHeader({ search: { value: '', onChange: () => {}, label: 'Search' } });
    expect(rowClass(tree).split(' ')).toContain('h-11');
  });

  it('lets the stacked chat-list pane grow at md', () => {
    const tree = SectionHeader({
      search: { value: '', onChange: () => {}, label: 'Search' },
      stackSearchMd: true,
    });
    expect(rowClass(tree).split(' ')).toContain('md:h-auto');
  });
});

describe('SectionHeader search: quiet at rest, the centre when focused', () => {
  const classOf = (el: ReactElement | undefined): string =>
    (el?.props as { className?: string } | undefined)?.className ?? '';
  const byData = (tree: ReactNode, key: string): ReactElement | undefined =>
    findAll(tree, (el) => (el.props as Record<string, unknown>)[key] === '')[0];
  const full = (value: string): ReactNode =>
    SectionHeader({
      search: { value, onChange: vi.fn(), label: 'Search posts' },
      sort: { options: sortOptions, value: 'recent', onChange: () => {} },
      primaryAction: { label: 'New post', onClick: vi.fn() },
    });

  it('the search field is ui/Input tone="search"', () => {
    const input = findAll(full(''), (el) => el.type === Input)[0]!;
    expect((input.props as { tone?: string }).tone).toBe('search');
  });

  it('the icon is fg-3 at rest and full ink while the field has focus', () => {
    const icon = findAll(full(''), (el) => el.type === 'span' && classOf(el).includes('left-2'))[0];
    expect(classOf(icon).split(' ')).toEqual(
      expect.arrayContaining(['text-fg-3', 'group-focus-within/sfield:text-fg']),
    );
  });

  it('phone: focus moves the controls aside and shows a ghost Cancel; laptop never shows it', () => {
    const tree = full('');
    const controls = classOf(byData(tree, 'data-search-controls')).split(' ');
    expect(controls).toContain('max-md:peer-focus-within/srch:absolute');
    expect(controls).toContain('max-md:peer-focus-within/srch:translate-x-[calc(100%+1rem)]');
    const cancel = byData(tree, 'data-search-cancel')!;
    expect(cancel.type).toBe(Button);
    expect((cancel.props as { variant: string }).variant).toBe('ghost');
    expect(classOf(cancel).split(' ')).toEqual(
      expect.arrayContaining(['md:hidden', 'hidden', 'group-focus-within/srch:inline-flex']),
    );
  });

  it('with text the row stays grown (controls aside, Cancel shown) until Cancel or clear', () => {
    const tree = full('carousel');
    const controls = classOf(byData(tree, 'data-search-controls')).split(' ');
    expect(controls).toContain('max-md:absolute');
    const cancel = byData(tree, 'data-search-cancel')!;
    expect(classOf(cancel).split(' ')).not.toContain('hidden');
  });

  it('Cancel clears the text', () => {
    const onChange = vi.fn();
    const tree = SectionHeader({
      search: { value: 'x', onChange, label: 'Search' },
      primaryAction: { label: 'New', onClick: vi.fn() },
    });
    const cancel = byData(tree, 'data-search-cancel')!;
    const target = { closest: () => null } as unknown as HTMLElement;
    (cancel.props as { onClick: (e: unknown) => void }).onClick({ currentTarget: target });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('the row clips on X only so the moved controls never scroll the page', () => {
    const row = findAll(full(''), (el) => classOf(el).includes('px-4 md:px-6 mt-3 flex'))[0];
    expect(classOf(row).split(' ')).toEqual(
      expect.arrayContaining(['h-11', 'relative', 'max-md:overflow-x-clip']),
    );
  });
});
