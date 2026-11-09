// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A grouped Activity card's "3 updates ⌄" tag (ListCard tagToggle) unfolds one
// row per entry under the card; a row opens ITS entry (onOpenEntry), the
// toggle never opens the head (onOpenGroup), a second tap folds. A single
// entry card has no toggle. Fixtures mirror ActivityCard.open-entry.test.tsx.

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

import { ActivityCard, activitySubRowLine } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import { LIST_CARD_SUB_INSET } from '@/components/ui/ListCard';
import type { PresignCache } from '@/lib/asset-presign';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cache = {} as unknown as PresignCache;
const NOW = Date.parse('2026-06-14T01:00:00.000Z');

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

const stage = item({
  id: 'stage',
  title: 'Q3 Launch',
  eventType: 'stage_change',
  toStage: 'review',
  actorName: 'Maya',
  createdAt: '2026-06-14T00:30:00.000Z',
  readAt: '2026-06-14T00:40:00.000Z',
});
const newer = item({
  id: 'newer',
  title: 'Q3 Launch',
  eventType: 'comment',
  commentId: 'c-newer',
  actorName: 'Priya',
  createdAt: '2026-06-14T00:10:00.000Z',
});
const older = item({
  id: 'older',
  title: 'Q3 Launch',
  eventType: 'comment',
  commentId: 'c-older',
  actorName: 'Asha',
  createdAt: '2026-06-14T00:00:00.000Z',
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(group: ActivityItem[]): {
  onOpenGroup: ReturnType<typeof vi.fn>;
  onOpenEntry: ReturnType<typeof vi.fn>;
} {
  const onOpenGroup = vi.fn();
  const onOpenEntry = vi.fn();
  act(() => {
    root?.render(
      <ActivityCard
        group={group}
        nowMs={NOW}
        timeZone="UTC"
        cache={cache}
        presignEnabled={false}
        onOpenGroup={onOpenGroup}
        onOpenEntry={onOpenEntry}
        selfName={null}
      />,
    );
  });
  return { onOpenGroup, onOpenEntry };
}

const toggle = (): HTMLButtonElement | null =>
  host?.querySelector<HTMLButtonElement>('[data-activity-updates-toggle]') ?? null;
const subRows = (): HTMLElement[] =>
  Array.from(host?.querySelectorAll<HTMLElement>('[data-activity-sub-row]') ?? []);

describe('ActivityCard grouped updates toggle', () => {
  it('shows the "3 updates" toggle, folded, inside the card tag', () => {
    mount([stage, newer, older]);
    const button = toggle();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('3 updates');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('Show 3 updates');
    expect(button?.closest('[data-activity-updates-tag]')).not.toBeNull();
    expect(button?.closest('[data-list-card]')).not.toBeNull();
    // A 44 hit box above the cover; the chevron is from ui/icons and turns.
    expect(button?.className).toContain('min-h-11');
    expect(button?.className).toContain('pointer-events-auto');
    expect(button?.className).toContain('z-raised');
    expect(host?.querySelector('[data-activity-sub-rows]')).toBeNull();
  });

  it('a tap unfolds one row per entry in group order and never opens the head', () => {
    const { onOpenGroup, onOpenEntry } = mount([stage, newer, older]);
    act(() => toggle()?.click());
    expect(onOpenGroup).not.toHaveBeenCalled();
    expect(onOpenEntry).not.toHaveBeenCalled();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle()?.getAttribute('aria-label')).toBe('Hide 3 updates');
    expect(host?.querySelector('[data-list-card-tag-chevron]')?.className).toContain('rotate-180');
    const list = host?.querySelector<HTMLElement>('[data-activity-sub-rows]');
    expect(list).not.toBeNull();
    // Under the card (not inside it), on the card's text column.
    expect(list?.closest('[data-list-card]')).toBeNull();
    for (const cls of LIST_CARD_SUB_INSET.split(' ')) expect(list?.className).toContain(cls);
    const rows = subRows();
    expect(rows.map((row) => row.getAttribute('data-activity-sub-row'))).toEqual([
      'stage',
      'newer',
      'older',
    ]);
    // Each row is a 44 tall PressableRow button: "Name · what", then the time.
    expect(rows[0]?.tagName).toBe('BUTTON');
    expect(rows[0]?.className).toContain('min-h-11');
    expect(rows[1]?.textContent).toContain('Priya · New comment');
    expect(rows[1]?.textContent).toContain(activitySubRowLine(newer));
    // The unread dot only on unread entries (stage was read).
    expect(rows[0]?.querySelector('[data-activity-sub-row-unread]')).toBeNull();
    expect(rows[1]?.querySelector('[data-activity-sub-row-unread]')).not.toBeNull();
  });

  it('a sub row opens its own entry, not the group', () => {
    const { onOpenGroup, onOpenEntry } = mount([stage, newer, older]);
    act(() => toggle()?.click());
    act(() => subRows()[2]?.click());
    expect(onOpenEntry).toHaveBeenCalledTimes(1);
    expect(onOpenEntry.mock.calls[0]?.[0]).toBe(older);
    expect(onOpenGroup).not.toHaveBeenCalled();
  });

  it('a second tap folds the rows away', () => {
    mount([stage, newer, older]);
    act(() => toggle()?.click());
    expect(subRows()).toHaveLength(3);
    act(() => toggle()?.click());
    expect(subRows()).toHaveLength(0);
    expect(host?.querySelector('[data-activity-sub-rows]')).toBeNull();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('the head tap still opens the group', () => {
    const { onOpenGroup, onOpenEntry } = mount([stage, newer, older]);
    act(() => host?.querySelector<HTMLElement>('[data-activity-lead]')?.click());
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0]?.[1]).toBe(newer);
    expect(onOpenEntry).not.toHaveBeenCalled();
  });

  it('a single entry card has no toggle and no sub rows', () => {
    mount([newer]);
    expect(toggle()).toBeNull();
    expect(host?.querySelector('[data-list-card-tag-toggle]')).toBeNull();
    expect(host?.querySelector('[data-activity-scope-tag]')).not.toBeNull();
    expect(host?.querySelector('[data-activity-sub-rows]')).toBeNull();
  });

  it('the sub row line names the actor, else the short line alone', () => {
    expect(activitySubRowLine(newer)).toBe('Priya · New comment');
    expect(activitySubRowLine(item({ eventType: 'comment' }))).toBe('New comment');
  });
});
