import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { VersionHistorySheet } from '@/components/pages/pcs/VersionHistorySheet';
import type { PostVersionView } from '@/lib/post-versions';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless VersionHistorySheet rather than mounting it, and
// collect the plain-string text nodes to assert what each row displays.

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

describe('VersionHistorySheet author resolution', () => {
  it('passes each version createdBy AND legacyAuthorName to resolveAuthor', () => {
    const resolveAuthor = vi.fn(resolverWith({ 'u-1': 'Active Member' }));
    VersionHistorySheet({
      open: true,
      onClose: () => {},
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Cutover' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'u-1', legacyAuthorName: null }),
      ],
      currentVersionNumber: 2,
      resolveAuthor,
      onSelectVersion: () => {},
    });
    expect(resolveAuthor).toHaveBeenCalledWith(null, 'Casey Cutover');
    expect(resolveAuthor).toHaveBeenCalledWith('u-1', null);
  });

  it('shows the legacy name when the FK author is null/unresolved', () => {
    const tree = VersionHistorySheet({
      open: true,
      onClose: () => {},
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: null, legacyAuthorName: 'Casey Cutover' }),
        version({ id: 'b', versionNumber: 2, createdBy: 'gone', legacyAuthorName: 'Robin Legacy' }),
      ],
      currentVersionNumber: 2,
      resolveAuthor: resolverWith({}),
      onSelectVersion: () => {},
    });
    const shown = texts(tree);
    expect(shown).toContain('Casey Cutover');
    expect(shown).toContain('Robin Legacy');
    expect(shown).not.toContain('(ex-member)');
  });

  it('prefers a resolved current member over the legacy name', () => {
    const tree = VersionHistorySheet({
      open: true,
      onClose: () => {},
      versions: [
        version({ id: 'a', versionNumber: 1, createdBy: 'u-1', legacyAuthorName: 'Stale Name' }),
      ],
      currentVersionNumber: 1,
      resolveAuthor: resolverWith({ 'u-1': 'Active Member' }),
      onSelectVersion: () => {},
    });
    const shown = texts(tree);
    expect(shown).toContain('Active Member');
    expect(shown).not.toContain('Stale Name');
  });
});
