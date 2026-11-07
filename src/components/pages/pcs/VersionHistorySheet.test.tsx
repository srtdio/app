import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { versionHistorySheet } from '@/components/pages/pcs/VersionHistorySheet';
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
}): ReactNode {
  return versionHistorySheet({
    open: true,
    onClose: noop,
    versions: over.versions,
    currentVersionNumber: over.currentVersionNumber,
    resolveAuthor: over.resolveAuthor ?? resolverWith({}),
    onSelectVersion: over.onSelectVersion ?? noop,
  });
}

describe('VersionHistorySheet author resolution', () => {
  it('passes each version createdBy AND legacyAuthorName to resolveAuthor', () => {
    const resolveAuthor = vi.fn(resolverWith({ 'u-1': 'Active Member' }));
    render({
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Morgan' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'u-1', legacyAuthorName: null }),
      ],
      currentVersionNumber: 2,
      resolveAuthor,
    });
    expect(resolveAuthor).toHaveBeenCalledWith(null, 'Casey Morgan');
    expect(resolveAuthor).toHaveBeenCalledWith('u-1', null);
  });

  it('shows the legacy name when the FK author is null/unresolved', () => {
    const tree = render({
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Morgan' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'gone', legacyAuthorName: 'Robin Legacy' }),
      ],
      currentVersionNumber: 2,
    });
    const shown = texts(tree);
    expect(shown).toContain('Casey Morgan');
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

describe('VersionHistorySheet without Compare versions (retired)', () => {
  const twoVersions = [
    version({ id: 'a', versionNumber: 1 }),
    version({ id: 'b', versionNumber: 2 }),
  ];

  it('no select controls and no footer, whatever the version count', () => {
    for (const versions of [[version({ id: 'a', versionNumber: 1 })], twoVersions]) {
      const tree = render({ versions, currentVersionNumber: versions.length });
      const selects = elements(sheetProps(tree).children).filter(
        (el) => (el.props as { 'aria-pressed'?: boolean })['aria-pressed'] !== undefined,
      );
      expect(selects).toHaveLength(0);
      expect(sheetProps(tree).footer).toBeUndefined();
      const shown = texts(tree).join(' ');
      expect(shown).not.toContain('Compare');
      expect(shown).not.toContain('Select two versions');
    }
  });

  it('an older row still opens the read-only version; the current row only closes', () => {
    const onSelectVersion = vi.fn();
    const tree = render({ versions: twoVersions, currentVersionNumber: 2, onSelectVersion });
    const rows = elements(sheetProps(tree).children).filter(
      (el) => typeof (el.props as { onClick?: unknown }).onClick === 'function',
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) (row.props as { onClick: () => void }).onClick();
    expect(onSelectVersion).toHaveBeenCalledTimes(1);
    expect(onSelectVersion).toHaveBeenCalledWith('a');
  });
});
