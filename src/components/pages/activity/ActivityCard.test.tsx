import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityCard,
  activityCardTitle,
  activityCardTag,
  activityKind,
  activityPreviewText,
  failedSendItems,
} from '@/components/pages/activity/ActivityCard';
import { chatMentionPreview, type ActivityItem } from '@/components/pages/activity/data';
import type { PresignCache } from '@/lib/asset-presign';

// The card's ⋯ menu picks popover vs Sheet by width; the node env has no matchMedia.

// The card reads the workspace key (for KEY-N) from the workspace context.
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  // The real display formatter, so the welcome row reads "<Brand> - <Platform>".
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

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
    messageId: null,
    channelType: null,
    ...over,
  };
}

const NOW = Date.parse('2026-06-14T01:00:00.000Z');

function renderCard(
  group: ActivityItem[],
  extra: {
    entering?: boolean;
    onEdit?: (i: ActivityItem) => void;
    onRetry?: (i: ActivityItem) => void;
  } = {},
): string {
  return renderToStaticMarkup(
    <ActivityCard
      group={group}
      nowMs={NOW}
      timeZone="UTC"
      cache={cache}
      presignEnabled={false}
      onOpenGroup={() => {}}
      onOpenEntry={() => {}}
      onSnooze={() => {}}
      onMarkRead={() => {}}
      selfName={null}
      {...extra}
    />,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ActivityCard on ui/ListCard', () => {
  it('renders one ListCard with the activity hooks kept and the old layout gone', () => {
    const html = renderCard([
      item({ id: 'a', title: 'Q3 Launch', eventType: 'stage_change', toStage: 'review' }),
      item({ id: 'b', title: 'Q3 Launch', eventType: 'comment' }),
    ]);
    expect(html).toContain('data-list-card=""');
    expect(html).toContain('data-activity-id="a"');
    expect(html).toContain('data-activity-event="stage_change"');
    // No lead rail, no nested thread rows, no "+N more" toggle button.
    expect(html).not.toContain('w-1 shrink-0');
    expect(html).not.toContain('data-activity-thread');
    expect(html).not.toContain('aria-expanded="false">+');
    // The actor starts the title; the title names the thing once; no KEY-N.
    expect(html).toContain('Someone sent Q3 Launch for review');
    expect(count(html, 'Q3 Launch')).toBe(1);
    expect(html).not.toMatch(/GBL-\d/);
  });

  it('a threaded group is one card; with no line of its own it previews "+N more"', () => {
    const group = [
      item({ id: 'a', title: 'Q3', eventType: 'stage_change', toStage: 'approved' }),
      item({ id: 'b', title: 'Q3', eventType: 'mention' }),
      item({ id: 'c', title: 'Q3', eventType: 'comment' }),
    ];
    expect(activityPreviewText(group)).toBe('+2 more');
    const html = renderCard(group);
    expect(count(html, 'data-list-card=""')).toBe(1);
    expect(html).toContain('+2 more');
  });

  it('the unread dot shows only when something in the group is unread', () => {
    const unread = renderCard([item({ readAt: null })]);
    expect(unread).toContain('data-list-card-unread');
    const read = renderCard([item({ readAt: '2026-06-14T00:30:00.000Z' })]);
    expect(read).not.toContain('data-list-card-unread');
    // Unread is the dot, never a picked card.
    expect(unread).not.toContain('lit-selected');
  });

  it('the time is formatRelative on the list clock (mono meta), never a clock time', () => {
    const html = renderCard([item({ createdAt: '2026-06-14T00:00:00.000Z' })]);
    const time = /<span data-list-card-time="" data-activity-time="" class="([^"]*)">([^<]*)</.exec(
      html,
    );
    expect(time?.[1]).toContain('font-mono');
    expect(time?.[1]).toContain('tabular-nums');
    expect(time?.[2]).toBe('1 hour ago');
    expect(html).not.toContain('12:00 AM');
    expect(html).not.toContain('Yesterday');
  });

  it('the time ages with the clock it is handed (no timer of its own)', () => {
    const at = (nowMs: number): string =>
      /data-activity-time="" class="[^"]*">([^<]*)</.exec(
        renderToStaticMarkup(
          <ActivityCard
            group={[item({ createdAt: '2026-06-14T00:00:00.000Z' })]}
            nowMs={nowMs}
            cache={cache}
            presignEnabled={false}
            onOpenGroup={() => {}}
            onOpenEntry={() => {}}
            onSnooze={() => {}}
            onMarkRead={() => {}}
            selfName={null}
          />,
        ),
      )?.[1] ?? '';
    const base = Date.parse('2026-06-14T00:00:00.000Z');
    expect(at(base + 10_000)).toBe('just now');
    expect(at(base + 5 * 60_000)).toBe('5 min ago');
    expect(at(base + 2 * 86_400_000)).toBe('2 days ago');
  });

  it('an edited plan_updated card reads the last edit time, not the first', () => {
    const html = renderCard([
      item({
        id: 'pe',
        eventType: 'plan_updated',
        entityType: 'plan',
        createdAt: '2026-06-13T00:58:00.000Z',
        alert: {
          kind: 'plan',
          channelId: null,
          chatName: null,
          chatType: null,
          scheduledId: null,
          reason: null,
          stale: false,
          preview: null,
          plan: {
            planId: 'plan1',
            itemId: null,
            planTitle: 'Week of 12 Oct',
            kind: 'edited',
            itemTitle: null,
            postId: null,
            from: null,
            to: null,
            leftPlan: false,
            lastChangeAt: '2026-06-14T00:59:30.000Z',
          },
          planTitle: null,
          itemTitle: null,
        },
      }),
    ]);
    expect(html).toMatch(/data-activity-time=""[^>]*>just now</);
    expect(html).not.toContain('Yesterday');
  });

  it('one grey tag naming the kind: Mention, Post, Brief, Plan, Reminder', () => {
    expect(activityKind(item({ entityType: 'post', scope: 'posts' }))).toBe('Post');
    expect(activityKind(item({ entityType: 'brief', scope: 'briefs' }))).toBe('Brief');
    expect(activityKind(item({ entityType: 'plan_item', scope: 'posts', planId: 'p' }))).toBe(
      'Plan',
    );
    expect(
      activityKind(item({ eventType: 'mention', entityType: 'chat_channel', scope: 'groups' })),
    ).toBe('Mention');
    expect(activityKind(item({ eventType: 'mention', entityType: 'post', scope: 'posts' }))).toBe(
      'Mention',
    );
    expect(
      activityKind(item({ eventType: 'task_due', entityType: 'chat_channel', scope: 'people' })),
    ).toBe('Reminder');
    expect(activityKind(item({ eventType: 'invite', entityType: null, scope: 'people' }))).toBe(
      undefined,
    );
    const html = renderCard([item({ eventType: 'comment', scope: 'posts' })]);
    expect(html).toMatch(/data-activity-scope-tag=""[^>]*>[^]*?bg-panel-2 text-fg-2[^"]*">Post</);
    expect(count(html, 'data-list-card-tag')).toBe(1);
  });

  it('a group of several entries counts them in its one tag ("3 updates")', () => {
    const group = [
      item({ id: 'a', title: 'Q3', eventType: 'stage_change', toStage: 'approved' }),
      item({ id: 'b', title: 'Q3', eventType: 'mention' }),
      item({ id: 'c', title: 'Q3', eventType: 'comment' }),
    ];
    expect(activityCardTag(group)).toBe('3 updates');
    expect(activityCardTag(group.slice(0, 1))).toBe('Post');
    const html = renderCard(group);
    expect(html).toMatch(/data-activity-updates-tag=""[^>]*>[^]*?">3 updates</);
    expect(count(html, 'data-list-card-tag')).toBe(1);
    expect(html).not.toContain('data-activity-scope-tag');
  });

  it('the ⋯ sits on line 3 through ActionMenuTrigger (the trailing rule)', () => {
    const html = renderCard([item({})]);
    expect(html).toMatch(/data-list-card-more=""[^]*data-activity-menu=""/);
    expect(html).toMatch(/aria-label="Activity options"[^>]*-mr-3/);
  });

  it('a live-added card renders at its final place, never a class fade or slide', () => {
    const entering = renderCard([item({ id: 'new' })], { entering: true });
    expect(entering).toContain('data-activity-entering=""');
    const root = /^<div[^>]*data-activity-entering=""[^>]*class="([^"]*)"/.exec(entering)?.[1];
    expect(root).not.toMatch(/translate-|rotate|opacity|transition|duration-|motion-safe/);
    expect(renderCard([item({ id: 'old' })])).not.toContain('data-activity-entering');
  });
});

describe('ActivityCard pictures', () => {
  it('a post with no picture shows the PostPlaceholder ("Aa", the play glyph for video)', () => {
    const text = renderCard([item({ title: 'Q3', format: 'text' })]);
    expect(text).toContain('data-list-card-picture="placeholder"');
    expect(text).toContain('data-post-placeholder="text"');
    const video = renderCard([item({ title: 'Q3', format: 'video' })]);
    expect(video).toContain('data-post-placeholder="video"');
  });

  it('a mention is that person: the actor photo circle at 72', () => {
    const html = renderCard([
      item({
        eventType: 'mention',
        entityType: 'chat_channel',
        scope: 'people',
        channelType: 'dm',
        actorName: 'Bob',
        actorAvatarUrl: 'https://cdn/bob.png',
        body: 'ping',
      }),
    ]);
    expect(html).toContain('data-list-card-picture="person"');
    expect(html).toContain('https://cdn/bob.png');
    expect(html).toContain('data-avatar-role="profile"');
    // No separate small actor avatar.
    expect(html).not.toContain('data-avatar-role="inline"');
  });

  it('a brief is the brief icon box; a plan item the plan icon box', () => {
    const brief = renderCard([
      item({ eventType: 'brief_created', entityType: 'brief', scope: 'briefs', actorName: 'Dev' }),
    ]);
    expect(brief).toContain('data-list-card-picture="icon"');
    const plan = renderCard([
      item({ eventType: 'plan_comment', entityType: 'plan_item', planId: 'p', body: 'hi' }),
    ]);
    expect(plan).toContain('data-list-card-picture="icon"');
  });

  it('the welcome row shows the workspace mark with its initial', () => {
    const html = renderCard([
      item({
        eventType: 'system',
        entityType: 'workspace',
        entityId: 'w1',
        welcome: { workspaceName: 'Kite', platform: 'instagram' },
      }),
    ]);
    expect(html).toContain('data-list-card-picture="image"');
    expect(html).toContain('>K<');
  });
});

describe('ActivityCard titles and previews', () => {
  it('chat mention: "<actor> mentioned you in <group>" over the message', () => {
    const html = renderCard([
      item({
        eventType: 'mention',
        entityType: 'chat_channel',
        entityId: 'chan-1',
        scope: 'groups',
        channelType: 'group',
        title: 'Launch crew',
        actorName: 'Bob',
        body: 'hey @Ana see this',
        messageId: 'msg-1',
      }),
    ]);
    expect(html).toContain('Bob mentioned you in Launch crew');
    expect(html).toContain('hey @Ana see this');
    expect(html).not.toContain('@[');
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(' ');
    expect(classes).not.toMatch(/dark:|#[0-9a-f]{6}/i);
  });

  it('"@all" draws bold with the mention-of-me accent (tokens only)', () => {
    const html = renderCard([
      item({
        eventType: 'mention',
        entityType: 'chat_channel',
        entityId: 'chan-1',
        channelType: 'group',
        title: 'Launch crew',
        actorName: 'Bob',
        body: chatMentionPreview('@[all] standup in 5', () => undefined),
      }),
    ]);
    expect(html).toMatch(
      /<span data-mention-all="" class="font-semibold text-accent">@all<\/span>/,
    );
  });

  it('actor rows: "<Name> approved <Title>", the name first, the title once', () => {
    const group = [
      item({
        title: 'Watch launch',
        eventType: 'stage_change',
        toStage: 'approved',
        actorName: 'Maya',
      }),
    ];
    expect(activityCardTitle(group)).toBe('Maya approved Watch launch');
    const html = renderCard(group);
    expect(count(html, 'Watch launch')).toBe(1);
  });

  it('the title names the newest entry actor, never an older row actor', () => {
    const older = item({
      id: 'old',
      title: 'Q3',
      eventType: 'comment',
      actorName: 'Asha',
      createdAt: '2026-06-14T00:00:00.000Z',
    });
    const newer = item({
      id: 'new',
      title: 'Q3',
      eventType: 'comment',
      actorName: 'Bina',
      createdAt: '2026-06-14T00:30:00.000Z',
    });
    expect(activityCardTitle([older, newer])).toBe('Bina commented on Q3');
    expect(activityCardTitle([newer, older])).toBe('Bina commented on Q3');
    const anon = item({
      id: 'n',
      title: 'Q3',
      eventType: 'comment',
      createdAt: '2026-06-14T00:30:00.000Z',
    });
    expect(activityCardTitle([anon, older])).toBe('New comment on Q3');
  });

  it('a comment previews its words without formatting markers', () => {
    const html = renderCard([
      item({
        eventType: 'plan_comment',
        entityType: 'plan_item',
        title: 'Diwali reel',
        actorName: 'Ana',
        body: '*ship* _today_ snake_case_name',
        planId: 'plan1',
      }),
    ]);
    expect(html).toContain('ship today snake_case_name');
    expect(html).not.toContain('_today_');
  });

  it('deleted files: the who-did-what title, the other files as the preview', () => {
    const group = [
      item({
        eventType: 'assets_deleted',
        entityType: 'workspace',
        scope: 'everything',
        actorName: 'Asha',
        assetCount: 3,
        filenames: ['deck.pdf', 'hero.png', 'teaser.mov'],
      }),
    ];
    expect(activityCardTitle(group)).toBe('Asha deleted 3 files');
    expect(activityPreviewText(group)).toBe('deck.pdf · Also hero.png and teaser.mov');
  });

  it('post_deleted opens nothing: no card button', () => {
    const html = renderCard([item({ eventType: 'post_deleted', title: 'Old', actorName: 'C' })]);
    expect(html).not.toContain('data-list-card-press');
    expect(html).not.toContain('data-activity-lead');
  });

  it('a tappable card is one button named by its title, unread dot and preview', () => {
    const html = renderCard([item({ title: 'Q3', actorName: 'Dev', readAt: null })]);
    const button = /<button[^>]*data-activity-lead=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).not.toContain('aria-label=');
    const ids = /aria-labelledby="([^"]+)"/.exec(button)?.[1]?.split(' ') ?? [];
    expect(ids).toHaveLength(3);
    expect(html).toContain(`id="${ids[0]}" data-list-card-title=""`);
    expect(html).toMatch(new RegExp(`<span[^>]*id="${ids[0]}"[^>]*>Dev commented on Q3<`));
    expect(html).toContain(`id="${ids[1]}" data-list-card-unread=""`);
    expect(html).toContain(`id="${ids[2]}" data-list-card-preview=""`);
  });
});

describe('a failed scheduled send: Edit and Retry move into the ⋯', () => {
  const failed = item({
    eventType: 'scheduled_failed',
    entityType: 'chat_channel',
    alert: {
      kind: 'failed',
      channelId: 'c1',
      chatName: 'Launch',
      chatType: 'group',
      scheduledId: 's1',
      reason: null,
      stale: false,
      preview: null,
      planTitle: null,
      itemTitle: null,
    },
  });

  it('the menu rows call Edit and Retry; the card keeps its one height (no buttons on it)', () => {
    const calls: string[] = [];
    const rows = failedSendItems(
      failed,
      () => calls.push('edit'),
      () => calls.push('retry'),
    );
    expect(rows.map((r) => r.id)).toEqual(['edit', 'retry']);
    for (const r of rows) r.onSelect();
    expect(calls).toEqual(['edit', 'retry']);
    const html = renderCard([failed], { onEdit: () => {}, onRetry: () => {} });
    expect(html).not.toContain('data-activity-action');
    expect(html).toContain('data-activity-only-you');
  });

  it('other cards add no rows', () => {
    expect(
      failedSendItems(
        item({}),
        () => {},
        () => {},
      ),
    ).toEqual([]);
  });
});
