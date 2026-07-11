import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import type { ActivityItem } from '@/components/pages/activity/data';
import type { PresignCache } from '@/lib/asset-presign';

// The unit env is `node` with no DOM, so events cannot be dispatched. We mock
// React's useState with a pure shim that reproduces the server-render initial
// state (so every existing renderToStaticMarkup test is unchanged), but lets a
// single test flip the lead card's expand flag on. With the thread expanded we
// invoke ActivityCard as a plain function and walk the returned element tree:
// child components stay unrendered nodes, so no DOM or matchMedia is touched.
const hooks = vi.hoisted(() => ({ forceExpand: false }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: <S,>(initial: S | (() => S)): [S, (next: S) => void] => {
      const value = typeof initial === 'function' ? (initial as () => S)() : initial;
      if (hooks.forceExpand && (value as unknown) === false) {
        return [true as unknown as S, () => {}];
      }
      return [value, () => {}];
    },
  };
});

/** Recursively collect every element of a given host type from a tree. */
function collectByType(node: ReactNode, type: string, acc: ReactElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, acc);
    return;
  }
  if (!isValidElement(node)) return;
  if (node.type === type) acc.push(node);
  const props = node.props as { children?: ReactNode };
  collectByType(props.children, type, acc);
}

// The same shim the pipeline board test uses: presignEnabled is false so the
// tile renders its fallback and never touches the cache, so an empty stand-in is
// safe (no presigning in the unit env).
const cache = {} as unknown as PresignCache;

// The card embeds ActivityRowMenu, which reads window.matchMedia at render. The
// unit env is `node`, so stub a minimal matchMedia (no DOM, no listeners fire).
const mql = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
(globalThis as unknown as { window: { matchMedia: () => typeof mql } }).window = {
  matchMedia: () => mql,
};

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    number: null,
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T00:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: null,
    assetId: null,
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    ...over,
  };
}

const NOW = Date.parse('2026-06-14T01:00:00.000Z');

function renderCard(group: ActivityItem[]): string {
  return renderToStaticMarkup(
    <ActivityCard
      group={group}
      nowMs={NOW}
      cache={cache}
      presignEnabled={false}
      onOpenGroup={() => {}}
      onOpenEntry={() => {}}
      onSnooze={() => {}}
      onMarkRead={() => {}}
    />,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ActivityCard', () => {
  it('renders a single contained card with the title shown once as the header', () => {
    const html = renderCard([
      item({ id: 'a', title: 'Q3 Launch', eventType: 'stage_change', toStage: 'review' }),
      item({ id: 'b', title: 'Q3 Launch', eventType: 'comment' }),
    ]);
    // One bordered, rounded card shell.
    expect(html).toContain('rounded-xl');
    // Title appears exactly once (the header), never repeated per event line.
    expect(count(html, 'Q3 Launch')).toBe(1);
    // Lead short line carries the event without the title.
    expect(html).toContain('Moved to review');
  });

  it('threads a group of >1 behind a "+N more" toggle, collapsed by default', () => {
    const html = renderCard([
      item({ id: 'a', title: 'Q3', eventType: 'comment' }),
      item({ id: 'b', title: 'Q3', eventType: 'mention' }),
      item({ id: 'c', title: 'Q3', eventType: 'stage_change', toStage: 'approved' }),
    ]);
    expect(html).toContain('+2 more');
    // Collapsed: the hidden events are not in the markup yet.
    expect(html).not.toContain('New mention');
  });

  it('renders a solo group as the same card shell with no "+N more"', () => {
    const html = renderCard([item({ id: 'a', title: 'Solo', eventType: 'comment' })]);
    expect(html).toContain('rounded-xl');
    expect(html).toContain('New comment');
    expect(html).not.toContain('more');
  });

  it('shows the unread dot and an accent-line border for an unread lead, hidden once read', () => {
    const unread = renderCard([item({ id: 'a', readAt: null })]);
    expect(unread).toContain('aria-label="Unread"');
    expect(unread).toContain('border-accent-line');
    const read = renderCard([item({ id: 'a', readAt: '2026-06-14T00:30:00.000Z' })]);
    expect(read).not.toContain('aria-label="Unread"');
  });

  it('falls back to a tone-tinted icon circle when the group has no actor', () => {
    const html = renderCard([
      item({ id: 'a', actorName: null, eventType: 'stage_change', toStage: 'approved' }),
    ]);
    // approved -> good tone on the icon circle.
    expect(html).toContain('border-good');
  });

  it('marks each expanded thread row interactive in the collapsed markup contract', () => {
    // Regression guard: a thread row is a button (role + cursor) so it is its own
    // deep-link target, not a dead list item.
    hooks.forceExpand = true;
    try {
      const onOpenEntry = vi.fn();
      const entry = item({ id: 'b', eventType: 'comment' });
      const group = [item({ id: 'a', eventType: 'comment' }), entry];
      const tree = ActivityCard({
        group,
        nowMs: NOW,
        cache,
        presignEnabled: false,
        onOpenGroup: () => {},
        onOpenEntry,
        onSnooze: () => {},
        onMarkRead: () => {},
      });
      const rows: ReactElement[] = [];
      collectByType(tree, 'li', rows);
      // One thread row for the single rest entry, and it is keyboard/pointer ready.
      expect(rows).toHaveLength(1);
      const row = rows[0]?.props as {
        role?: string;
        tabIndex?: number;
        onClick?: () => void;
        className?: string;
      };
      expect(row.role).toBe('button');
      expect(row.tabIndex).toBe(0);
      expect(row.className).toContain('cursor-pointer');
      // Clicking the thread row opens that exact entry once.
      row.onClick?.();
      expect(onOpenEntry).toHaveBeenCalledTimes(1);
      expect(onOpenEntry).toHaveBeenCalledWith(entry);
    } finally {
      hooks.forceExpand = false;
    }
  });
});

describe('AvatarStack', () => {
  it('renders nothing for an empty set', () => {
    expect(renderToStaticMarkup(<AvatarStack names={[]} />)).toBe('');
  });

  it('overlaps up to three and shows a +N indicator beyond that', () => {
    const html = renderToStaticMarkup(<AvatarStack names={['Ann', 'Bo', 'Cy', 'Di', 'Ed']} />);
    expect(html).toContain('+2');
  });
});
