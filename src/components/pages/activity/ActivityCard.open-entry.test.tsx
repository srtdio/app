// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F1: a grouped card's head opens the newest entry that links to a comment, so
// a stage change (or post_ready, checkpoints_added) on top never swallows the
// comment under it. With no comment entry the head opens the lead, as before.

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { entityHref, groupOpenEntry, type ActivityItem } from '@/components/pages/activity/data';
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

function tapHead(group: ActivityItem[]): ReturnType<typeof vi.fn> {
  const onOpenGroup = vi.fn();
  act(() => {
    root?.render(
      <ActivityCard
        group={group}
        nowMs={NOW}
        cache={cache}
        presignEnabled={false}
        onOpenGroup={onOpenGroup}
        onOpenEntry={() => {}}
        onSnooze={() => {}}
        onMarkRead={() => {}}
        selfName={null}
      />,
    );
  });
  const head = host?.querySelector<HTMLElement>('[data-activity-lead]');
  act(() => head?.click());
  return onOpenGroup;
}

const stage = item({
  id: 'stage',
  eventType: 'stage_change',
  toStage: 'review',
  createdAt: '2026-06-14T00:30:00.000Z',
});
const older = item({
  id: 'older',
  eventType: 'comment',
  commentId: 'c-older',
  createdAt: '2026-06-14T00:00:00.000Z',
});
const newer = item({
  id: 'newer',
  eventType: 'comment',
  commentId: 'c-newer',
  createdAt: '2026-06-14T00:10:00.000Z',
});

describe('ActivityCard head tap (F1)', () => {
  it('opens the newest entry that links to a comment, not a stage change on top', () => {
    const group = [stage, newer, older];
    const onOpenGroup = tapHead(group);
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0]?.[0]).toBe(group);
    expect(onOpenGroup.mock.calls[0]?.[1]).toBe(newer);
    expect(entityHref(newer)).toBe('/posts/p1?comment=c-newer');
  });

  it('follows createdAt, not group order (oldest-first lists)', () => {
    expect(groupOpenEntry([older, newer, stage])).toBe(newer);
  });

  it('with no comment entry the head opens the lead, as before', () => {
    const ready = item({ id: 'ready', eventType: 'post_ready', createdAt: stage.createdAt });
    const group = [stage, ready];
    const onOpenGroup = tapHead(group);
    expect(onOpenGroup.mock.calls[0]?.[1]).toBe(stage);
  });
});
