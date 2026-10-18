// W8 regressions for Activity: the card's ⋯ menu, group read state, Mark all
// read on the active chip only behind Undo, the plain load error and the shared
// snooze labels.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityCard,
  UNREAD_DOT_CLASS,
  groupHasUnread,
} from '@/components/pages/activity/ActivityCard';
import {
  ACTIVITY_LOAD_FAILED,
  MARKED_READ_LABEL,
  SNOOZE_OPTIONS,
  markAllTargets,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { INBOX_SNOOZE_OPTIONS } from '@/lib/inbox/bell-types';
import type { PresignCache } from '@/lib/asset-presign';

const cache = {} as unknown as PresignCache;
const NOW = Date.parse('2026-06-14T01:00:00.000Z');
const READ = '2026-06-14T00:30:00.000Z';

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
    messageId: null,
    channelType: null,
    ...over,
  };
}

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

describe('W8 fix 3: the card shows a visible 44px ⋯ menu', () => {
  it('mounts ActivityRowMenu on every card', () => {
    const html = renderCard([item({ id: 'a' })]);
    expect(html).toContain('data-activity-menu');
    expect(html).toContain('aria-label="Activity options"');
    expect(html).toMatch(/aria-label="Activity options"[^>]*class="[^"]*h-11 w-11/);
  });
});

describe('W8 fix 4: a card is highlighted when any entry is unread', () => {
  it('highlights a group whose lead is read but a later entry is not', () => {
    const group = [item({ id: 'a', readAt: READ }), item({ id: 'b', readAt: null })];
    expect(groupHasUnread(group)).toBe(true);
    const html = renderCard(group);
    expect(html).toContain('border-accent-line');
    expect(html).toContain('aria-label="Unread"');
  });

  it('is plain once every entry is read', () => {
    const group = [item({ id: 'a', readAt: READ }), item({ id: 'b', readAt: READ })];
    expect(groupHasUnread(group)).toBe(false);
    expect(renderCard(group)).not.toContain('border-accent-line');
  });
});

describe('W8 fix 5: Mark all read applies to the active chip only', () => {
  const mention = item({ id: 'm', eventType: 'mention' });
  const comment = item({ id: 'c', eventType: 'comment' });
  const readMention = item({ id: 'r', eventType: 'mention', readAt: READ });
  const snoozed = item({
    id: 's',
    eventType: 'mention',
    snoozedUntil: new Date(NOW + 3_600_000).toISOString(),
  });
  const items = [mention, comment, readMention, snoozed];

  it('on Mentions, targets only the unread, non-snoozed mentions', () => {
    expect(markAllTargets(items, 'mentions', NOW).map((i) => i.id)).toEqual(['m']);
  });

  it('on All, targets every unread, non-snoozed row', () => {
    expect(markAllTargets(items, 'all', NOW).map((i) => i.id)).toEqual(['m', 'c']);
  });

  it('labels the Undo toast "Marked as read"', () => {
    expect(MARKED_READ_LABEL).toBe('Marked as read');
  });
});

describe('W8 fix 6: the load error is plain copy, never raw error text', () => {
  it('is a fixed sentence with no em-dash', () => {
    expect(ACTIVITY_LOAD_FAILED).toBe(
      "Couldn't load activity. Check your connection and try again.",
    );
    expect(ACTIVITY_LOAD_FAILED).not.toContain('—');
  });
});

describe('W8 fix 7: shared snooze labels and one unread dot size', () => {
  it('Activity uses the same snooze labels as the bell', () => {
    expect(SNOOZE_OPTIONS).toBe(INBOX_SNOOZE_OPTIONS);
    expect(SNOOZE_OPTIONS.map((o) => o.label)).toEqual([
      '1 hour',
      '4 hours',
      'Tomorrow 9 AM',
      'Next week',
    ]);
  });

  it('every unread dot is 8px', () => {
    expect(UNREAD_DOT_CLASS).toContain('h-2 w-2');
    const html = renderCard([item({ id: 'a' })]);
    expect(html).not.toContain('h-1.5 w-1.5');
  });
});
