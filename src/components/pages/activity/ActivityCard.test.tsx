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
    // stage_change is neutral now: stage no longer tints the rail or the glyph.
    expect(html).toContain('w-[3px] shrink-0 bg-border-strong');
    expect(html).not.toContain('w-[3px] shrink-0 bg-accent');
    expect(html).toContain('shrink-0 text-fg-3');
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

  /** Collect every element in a returned element tree. */
  function collectAll(node: ReactNode, acc: ReactElement[]): void {
    if (Array.isArray(node)) {
      for (const child of node) collectAll(child, acc);
      return;
    }
    if (!isValidElement(node)) return;
    acc.push(node);
    collectAll((node.props as { children?: ReactNode }).children, acc);
  }

  /** The icon component name rendered inside the first span matching `marker`. */
  function iconNameInSpan(over: Partial<ActivityItem>, marker: string): string {
    const tree = ActivityCard({
      group: [item(over)],
      nowMs: NOW,
      cache,
      presignEnabled: false,
      onOpenGroup: () => {},
      onOpenEntry: () => {},
      onSnooze: () => {},
      onMarkRead: () => {},
      selfName: null,
    });
    const all: ReactElement[] = [];
    collectAll(tree, all);
    const span = all.find(
      (el) =>
        el.type === 'span' &&
        String((el.props as { className?: string }).className ?? '').includes(marker),
    );
    const icon = (span?.props as { children?: ReactNode } | undefined)?.children;
    if (!isValidElement(icon)) throw new Error(`no icon in span "${marker}" for ${over.eventType}`);
    const type = icon.type;
    return typeof type === 'function' ? type.name : String(type);
  }

  // The event glyph is the same single inline glyph in every layout branch: the
  // bare glyph span is the only one whose class starts with `shrink-0 text-`.
  const GLYPH_MARKER = 'shrink-0 text-';

  /** The inline glyph icon name for an actor-less card. */
  function leadIconName(eventType: string): string {
    return iconNameInSpan({ eventType, actorName: null }, GLYPH_MARKER);
  }

  /** The inline glyph icon name for a card that carries an actor. */
  function inlineGlyphIconName(eventType: string): string {
    return iconNameInSpan({ eventType, actorName: 'Ann Lee' }, GLYPH_MARKER);
  }

  it('gives each of the 14 event types its own distinct icon, none the fallback', () => {
    const names = ALL_EVENT_TYPES.map(leadIconName);
    expect(names).toHaveLength(14);
    // Every event type maps to a different icon component.
    expect(new Set(names).size).toBe(14);
    // None of the known types fall through to the IconActivity default.
    expect(names).not.toContain('IconActivity');
  });

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
    expect(leadIconName('not_a_real_event')).toBe('IconActivity');
  });

  // The inline event glyph: coloured by event tone. The bare glyph span is the
  // only one whose class starts with `shrink-0 text-`.
  const ACCENT_INLINE = 'shrink-0 text-accent';
  const NEUTRAL_INLINE = 'shrink-0 text-fg-3';

  it('shows the inline event glyph beside the actor, never a fallback circle', () => {
    const html = renderCard([item({ eventType: 'comment', actorName: 'Ann Lee' })]);
    // The old 48px fallback circle is gone from the layout entirely.
    expect(html).not.toContain('h-12 w-12');
    // The inline glyph carries the event tone.
    expect(html).toContain(NEUTRAL_INLINE);
  });

  it('gives every event type its own inline glyph, none the fallback', () => {
    const names = ALL_EVENT_TYPES.map(inlineGlyphIconName);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
    expect(names).not.toContain('IconActivity');
    // The inline glyph draws the same icon whether or not the card has an actor.
    for (const eventType of ALL_EVENT_TYPES) {
      expect(inlineGlyphIconName(eventType)).toBe(leadIconName(eventType));
    }
  });

  it('accents the five accent inline glyphs even though those events carry an actor', () => {
    const accent = new Set([
      'mention',
      'checkpoints_added',
      'post_ready',
      'trial_warning',
      'billing_failure',
    ]);
    for (const eventType of ALL_EVENT_TYPES) {
      const html = renderCard([item({ eventType, actorName: 'Ann Lee' })]);
      if (accent.has(eventType)) {
        expect(html).toContain(ACCENT_INLINE);
        expect(html).not.toContain(NEUTRAL_INLINE);
      } else {
        expect(html).toContain(NEUTRAL_INLINE);
        expect(html).not.toContain(ACCENT_INLINE);
      }
    }
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
