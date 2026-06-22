import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { AvatarStack } from '@/components/pages/activity/AvatarStack';
import type { ActivityItem } from '@/components/pages/activity/data';
import type { PresignCache } from '@/lib/asset-presign';

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
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T00:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: null,
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
