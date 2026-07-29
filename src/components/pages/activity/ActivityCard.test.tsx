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
    pointsAdded: null,
    checkpointTotal: null,
    batchId: null,
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
      selfName={null}
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
    // A single bordered, rounded card shell, laid out as a flex row with a rail.
    expect(html).toContain('rounded-xl');
    expect(html).toContain('w-[3px] shrink-0 bg-border-strong');
    // Title appears exactly once (the header row), never repeated per event line.
    expect(count(html, 'Q3 Launch')).toBe(1);
    // Lead actor line carries the event without the title.
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

  it('renders a neutral lead rail when a non-accent group has no actor', () => {
    const html = renderCard([
      item({ id: 'a', actorName: null, eventType: 'stage_change', toStage: 'approved' }),
    ]);
    // stage_change is neutral now: stage no longer tints the rail.
    expect(html).toContain('w-[3px] shrink-0 bg-border-strong');
    expect(html).not.toContain('w-[3px] shrink-0 bg-accent');
  });

  // The lead rail: accent for the five accent events, neutral otherwise. The 3px
  // rail is the card's first child and the two-state colour signal.
  const ACCENT_RAIL = 'w-[3px] shrink-0 bg-accent';
  const NEUTRAL_RAIL = 'w-[3px] shrink-0 bg-border-strong';

  const ALL_EVENT_TYPES = [
    'mention',
    'checkpoints_added',
    'comment',
    'comment_resolved',
    'stage_change',
    'post_ready',
    'brief_created',
    'brief_closed',
    'asset_uploaded',
    'asset_version_added',
    'invite',
    'trial_warning',
    'billing_failure',
    'system',
  ] as const;

  it('accents exactly the five accent event types and leaves the other nine neutral', () => {
    const accent = new Set([
      'mention',
      'checkpoints_added',
      'post_ready',
      'trial_warning',
      'billing_failure',
    ]);
    for (const eventType of ALL_EVENT_TYPES) {
      const html = renderCard([item({ eventType, actorName: null })]);
      if (accent.has(eventType)) {
        expect(html).toContain(ACCENT_RAIL);
        expect(html).not.toContain(NEUTRAL_RAIL);
      } else {
        expect(html).toContain(NEUTRAL_RAIL);
        expect(html).not.toContain(ACCENT_RAIL);
      }
    }
    // Precisely five accent, nine neutral.
    const accentCount = ALL_EVENT_TYPES.filter((t) => accent.has(t)).length;
    expect(accentCount).toBe(5);
    expect(ALL_EVENT_TYPES.length - accentCount).toBe(9);
  });

  it('renders an unrecognised event type as IconActivity on a neutral rail', () => {
    const html = renderCard([item({ eventType: 'not_a_real_event', actorName: null })]);
    expect(html).toContain(NEUTRAL_RAIL);
    expect(html).not.toContain(ACCENT_RAIL);
  });

  it('renders no inline event glyph span in the actor row', () => {
    const html = renderCard([item({ eventType: 'comment', actorName: 'Ann Lee' })]);
    expect(html).not.toContain('shrink-0 text-accent');
    expect(html).not.toContain('shrink-0 text-fg-3');
  });

  it('squares the thumbnail wrapper and insets it, dropping the stretched tile', () => {
    const html = renderCard([item({ id: 'a', eventType: 'comment' })]);
    expect(html).toContain('w-24 shrink-0 self-start overflow-hidden rounded-lg');
    expect(html).not.toContain('min-h-[104px]');
    expect(html).not.toContain('self-stretch');
  });

  it('renders a footer with the relative time for a solo group and no "+N more"', () => {
    const html = renderCard([
      item({ id: 'a', eventType: 'comment', createdAt: '2026-06-14T00:00:00.000Z' }),
    ]);
    // The footer container renders even with a single entry.
    expect(html).toContain('min-h-[44px] items-center gap-1.5 px-[14px]');
    expect(html).toContain('font-mono text-xs text-fg-3');
    expect(html).not.toContain('more');
  });

  it('renders the relative time and "+N more" together in the footer of a threaded group', () => {
    const html = renderCard([
      item({ id: 'a', eventType: 'comment' }),
      item({ id: 'b', eventType: 'mention' }),
    ]);
    expect(html).toContain('font-mono text-xs text-fg-3');
    expect(html).toContain('+1 more');
    // The toggle is an inset touch target, not the old full-width button.
    expect(html).toContain('ml-auto flex min-h-[44px]');
    expect(html).not.toContain('min-h-[44px] w-full');
  });

  it('places the scope tag and snoozed chip in the footer, not the content column', () => {
    // Snooze one hour past NOW so isSnoozed is true.
    const html = renderCard([
      item({
        id: 'a',
        eventType: 'comment',
        scope: 'briefs',
        snoozedUntil: '2026-06-14T02:00:00.000Z',
      }),
    ]);
    // Both chips render, and they sit after the footer container marker in the markup.
    const footerAt = html.indexOf('min-h-[44px] items-center gap-1.5 px-[14px]');
    expect(footerAt).toBeGreaterThanOrEqual(0);
    const tagAt = html.indexOf('Briefs');
    const snoozeAt = html.indexOf('Snoozed');
    expect(tagAt).toBeGreaterThan(footerAt);
    expect(snoozeAt).toBeGreaterThan(footerAt);
    // The old content-column meta row is gone.
    expect(html).not.toContain('mt-2 flex items-center gap-1.5');
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
        selfName: null,
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
