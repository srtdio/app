import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  versionHistorySheet,
  toggleCompareSelection,
} from '@/components/pages/pcs/VersionHistorySheet';
import type { PostVersionView } from '@/lib/post-versions';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless versionHistorySheet rather than mounting it, and
// collect the plain-string text nodes / elements to assert what the sheet shows.

function walk(node: ReactNode, strings: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, strings));
    return;
  }
  if (typeof node === 'string') {
    strings.push(node);
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  walk((node as ReactElement).props as ReactNode, strings);
  walk(((node as ReactElement).props as { children?: ReactNode }).children, strings);
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  walk(tree, out);
  return out;
}

// Collect every element reachable through children (props excluded), so element
// props like aria-pressed / disabled can be asserted.
function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  collect((el.props as { children?: ReactNode }).children, out);
}

function elements(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  collect(node, out);
  return out;
}

function sheetProps(tree: ReactNode): { children?: ReactNode; footer?: ReactNode } {
  return (tree as ReactElement).props as { children?: ReactNode; footer?: ReactNode };
}

function version(over: Partial<PostVersionView>): PostVersionView {
  return {
    id: 'v',
    versionNumber: 1,
    snapshot: { caption: 'c', gallery: [] },
    createdBy: null,
    legacyAuthorName: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

// A stand-in for the page's resolveAuthorName: prefers a current member, then the
// legacy name, then (ex-member). The sheet must thread the legacy name through.
function resolverWith(members: Record<string, string>) {
  return (userId: string | null, legacyName: string | null): string => {
    if (userId === null || userId === '') return legacyName ?? '(ex-member)';
    return members[userId] ?? legacyName ?? '(ex-member)';
  };
}

const noop = (): void => {};

function render(over: {
  versions: readonly PostVersionView[];
  currentVersionNumber: number | null;
  resolveAuthor?: (userId: string | null, legacyName: string | null) => string;
  onSelectVersion?: (id: string) => void;
  onCompare?: (fromId: string, toId: string) => void;
  selectedIds?: readonly string[];
  onToggleSelect?: (id: string) => void;
}): ReactNode {
  return versionHistorySheet({
    open: true,
    onClose: noop,
    versions: over.versions,
    currentVersionNumber: over.currentVersionNumber,
    resolveAuthor: over.resolveAuthor ?? resolverWith({}),
    onSelectVersion: over.onSelectVersion ?? noop,
    onCompare: over.onCompare ?? noop,
    selectedIds: over.selectedIds ?? [],
    onToggleSelect: over.onToggleSelect ?? noop,
  });
}

describe('VersionHistorySheet author resolution', () => {
  it('passes each version createdBy AND legacyAuthorName to resolveAuthor', () => {
    const resolveAuthor = vi.fn(resolverWith({ 'u-1': 'Active Member' }));
    render({
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Cutover' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'u-1', legacyAuthorName: null }),
      ],
      currentVersionNumber: 2,
      resolveAuthor,
    });
    expect(resolveAuthor).toHaveBeenCalledWith(null, 'Casey Cutover');
    expect(resolveAuthor).toHaveBeenCalledWith('u-1', null);
  });

  it('shows the legacy name when the FK author is null/unresolved', () => {
    const tree = render({
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Cutover' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'gone', legacyAuthorName: 'Robin Legacy' }),
      ],
      currentVersionNumber: 2,
    });
    const shown = texts(tree);
    expect(shown).toContain('Casey Cutover');
    expect(shown).toContain('Robin Legacy');
    expect(shown).not.toContain('(ex-member)');
  });

  it('prefers a resolved current member over the legacy name', () => {
    const tree = render({
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: 'u-1', legacyAuthorName: 'Stale Name' }),
      ],
      currentVersionNumber: 1,
      resolveAuthor: resolverWith({ 'u-1': 'Active Member' }),
    });
    const shown = texts(tree);
    expect(shown).toContain('Active Member');
    expect(shown).not.toContain('Stale Name');
  });
});

describe('VersionHistorySheet compare selection', () => {
  const twoVersions = [
    version({ id: 'a', versionNumber: 1 }),
    version({ id: 'b', versionNumber: 2 }),
  ];

  it('shows no select controls and no footer for a single-version post', () => {
    const tree = render({
      versions: [version({ id: 'a', versionNumber: 1 })],
      currentVersionNumber: 1,
    });
    const selects = elements(sheetProps(tree).children).filter(
      (el) => (el.props as { 'aria-pressed'?: boolean })['aria-pressed'] !== undefined,
    );
    expect(selects).toHaveLength(0);
    expect(sheetProps(tree).footer).toBeUndefined();
  });

  it('renders a select control per row when there are two or more versions', () => {
    const tree = render({ versions: twoVersions, currentVersionNumber: 2 });
    const selects = elements(sheetProps(tree).children).filter(
      (el) => (el.props as { 'aria-pressed'?: boolean })['aria-pressed'] !== undefined,
    );
    expect(selects).toHaveLength(2);
    expect(
      selects.every((el) => (el.props as { 'aria-pressed'?: boolean })['aria-pressed'] === false),
    ).toBe(true);
  });

  it('marks the selected rows via aria-pressed', () => {
    const tree = render({ versions: twoVersions, currentVersionNumber: 2, selectedIds: ['a'] });
    const pressed = elements(sheetProps(tree).children).filter(
      (el) => (el.props as { 'aria-pressed'?: boolean })['aria-pressed'] === true,
    );
    expect(pressed).toHaveLength(1);
  });

  it('footer is disabled with a prompt label when fewer than two are selected', () => {
    const tree = render({ versions: twoVersions, currentVersionNumber: 2, selectedIds: [] });
    const footer = sheetProps(tree).footer;
    expect(texts(footer)).toContain('Select two versions');
    const button = elements(footer).find((el) => el.type === 'button');
    expect((button?.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it('footer enables and labels old -> new regardless of pick order', () => {
    const onCompare = vi.fn();
    const tree = render({
      versions: twoVersions,
      currentVersionNumber: 2,
      selectedIds: ['b', 'a'],
      onCompare,
    });
    const footer = sheetProps(tree).footer;
    expect(texts(footer)).toContain('Compare v1 → v2');
    const button = elements(footer).find((el) => el.type === 'button');
    expect((button?.props as { disabled?: boolean }).disabled).toBe(false);
    (button?.props as { onClick: () => void }).onClick();
    expect(onCompare).toHaveBeenCalledWith('a', 'b');
  });
});

describe('toggleCompareSelection', () => {
  it('adds up to two ids', () => {
    expect(toggleCompareSelection([], 'a')).toEqual(['a']);
    expect(toggleCompareSelection(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('replaces the oldest when a third is picked', () => {
    expect(toggleCompareSelection(['a', 'b'], 'c')).toEqual(['b', 'c']);
  });

  it('re-picking a selected id clears it', () => {
    expect(toggleCompareSelection(['a', 'b'], 'a')).toEqual(['b']);
  });
});
