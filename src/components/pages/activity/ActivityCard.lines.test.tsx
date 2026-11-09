// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 9 Nov 2026 (locked): every notification gets its own line, grouped by item.
// A non-chat card is a head (item title, kind, "N new") and one line per
// notification, newest first; 5 show, the rest fold behind "+N more" (a 20
// text box, aria-expanded) that turns into "Show less". A line opens ITS entry only.
// Chat rows keep their one card.

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

import {
  ACTIVITY_LINES_SHOWN,
  ActivityCard,
  COMMENT_DELETED,
  entryLineText,
  itemCardLines,
} from '@/components/pages/activity/ActivityCard';
import {
  rememberMentionNames,
  resetMentionNames,
  resolvePersonMentionText,
} from '@/lib/chat/mentions';
import { entryLine, type ActivityItem } from '@/components/pages/activity/data';
import { LIST_CARD_SUB_INSET } from '@/components/ui/ListCard';
import type { PresignCache } from '@/lib/asset-presign';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cache = {} as unknown as PresignCache;
const NOW = Date.parse('2026-06-14T12:00:00.000Z');

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
    title: 'Q3 Launch',
    actorId: null,
    actorName: 'Priya',
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

/** `n` comments on one item, newest first (minutes apart). */
function comments(n: number, over: Partial<ActivityItem> = {}): ActivityItem[] {
  return Array.from({ length: n }, (_, k) => k).map((k) =>
    item({
      id: `c${k}`,
      commentId: `cm${k}`,
      createdAt: new Date(Date.parse('2026-06-14T10:00:00.000Z') - k * 60_000).toISOString(),
      ...over,
    }),
  );
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

function mount(group: ActivityItem[]): {
  onOpenGroup: ReturnType<typeof vi.fn>;
  onOpenEntry: ReturnType<typeof vi.fn>;
} {
  const onOpenGroup = vi.fn();
  const onOpenEntry = vi.fn();
  act(() =>
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
    ),
  );
  return { onOpenGroup, onOpenEntry };
}

const lines = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-activity-line]'),
];
const more = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-activity-more]');

describe('Activity density gaps and the head edge (9 Nov 2026)', () => {
  it('lines: head to line 1 4 / 8 / 12, line to line 8 / 12 / 16 (Compact / Cozy / Calm)', () => {
    mount(comments(8));
    const box = document.querySelector('[data-activity-lines]');
    const cls = box?.className.split(/\s+/) ?? [];
    expect(cls).toEqual(
      expect.arrayContaining([
        'pt-2',
        'compact:pt-1',
        'calm:pt-3',
        'gap-3',
        'compact:gap-2',
        'calm:gap-4',
        'pb-3',
      ]),
    );
    expect(cls).not.toContain('gap-6');
    act(() => more()?.click());
    const rest = document.querySelector('[data-activity-lines-rest]')?.className ?? '';
    expect(rest).toContain('gap-3');
    expect(rest).toContain('compact:gap-2');
    expect(rest).toContain('calm:gap-4');
  });

  it("the day's last card ends on its last text box (no 12 under it)", () => {
    act(() =>
      root?.render(
        <ActivityCard
          group={comments(2)}
          nowMs={NOW}
          timeZone="UTC"
          cache={cache}
          presignEnabled={false}
          onOpenGroup={vi.fn()}
          onOpenEntry={vi.fn()}
          selfName={null}
          lastInDay
        />,
      ),
    );
    expect(document.querySelector('[data-activity-lines]')?.className).not.toContain('pb-3');
  });

  it('the head tag ends on the right edge: the head dot is spoken, not drawn', () => {
    mount(comments(2));
    const dot = document.querySelector('[data-activity-item-head] [data-list-card-unread]');
    expect(dot?.getAttribute('aria-label')).toBe('Unread');
    expect(dot?.className).toBe('sr-only');
    // Each line keeps its drawn dot on the same edge.
    expect(document.querySelectorAll('[data-activity-line-dot]')).toHaveLength(2);
  });
});

describe('Activity: one card per item, one line per notification', () => {
  it('3 notifications: 1 card, 3 lines, no "+N more"', () => {
    mount(comments(3));
    expect(document.querySelectorAll('[data-list-card]')).toHaveLength(1);
    expect(lines()).toHaveLength(3);
    expect(more()).toBeNull();
    expect(document.querySelector('[data-activity-new]')?.textContent).toBe('3 new');
    expect(document.querySelector('[data-list-card-title]')?.textContent).toBe('Q3 Launch');
    // The lines start on the head's title column, not under the picture.
    expect(document.querySelector('[data-activity-lines]')?.className).toContain(
      LIST_CARD_SUB_INSET.split(' ')[0],
    );
  });

  it('exactly 5: no "+N more"', () => {
    mount(comments(5));
    expect(lines()).toHaveLength(5);
    expect(more()).toBeNull();
  });

  it('8 notifications: 5 lines + "+3 more"; tap shows 8 + "Show less"; tap again folds to 5', async () => {
    mount(comments(8));
    expect(ACTIVITY_LINES_SHOWN).toBe(5);
    expect(lines()).toHaveLength(5);
    expect(lines().map((l) => l.getAttribute('data-activity-line'))).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
      'c4',
    ]);
    expect(more()?.textContent).toBe('+3 more');
    expect(more()?.getAttribute('aria-expanded')).toBe('false');
    expect(more()?.getAttribute('aria-label')).toBe('Show 3 more updates');
    // Its text box (the label's 20 line; gap measured like a line's); the tap is its hit box.
    expect(more()?.className).toContain('min-h-0');
    act(() => more()?.click());
    expect(lines()).toHaveLength(8);
    expect(more()?.textContent).toBe('Show less');
    expect(more()?.getAttribute('aria-expanded')).toBe('true');
    // The fold plays itemOut (instant here), then the rest unmount.
    await act(async () => {
      more()?.click();
      await Promise.resolve();
    });
    expect(lines()).toHaveLength(5);
    expect(more()?.textContent).toBe('+3 more');
  });

  it('a line opens ITS entry only (never the group); the head still opens the item', () => {
    const group = comments(3);
    const { onOpenGroup, onOpenEntry } = mount(group);
    act(() => lines()[1]?.click());
    expect(onOpenEntry).toHaveBeenCalledTimes(1);
    expect(onOpenEntry).toHaveBeenCalledWith(group[1]);
    expect(onOpenGroup).not.toHaveBeenCalled();
    act(() => document.querySelector<HTMLButtonElement>('[data-activity-lead]')?.click());
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
  });

  it('a line: actor, the Activity line without the name, time, unread dot; read lines are muted with no dot', () => {
    const [unread, read] = comments(2);
    mount([
      unread as ActivityItem,
      { ...(read as ActivityItem), readAt: '2026-06-14T11:00:00.000Z' },
    ]);
    const [first, second] = lines();
    expect(first?.textContent).toContain('Priya');
    expect(first?.textContent).toContain(entryLine(unread as ActivityItem).text);
    expect(first?.querySelector('[data-activity-line-dot]')).not.toBeNull();
    expect(second?.querySelector('[data-activity-line-dot]')).toBeNull();
    expect(second?.innerHTML).toContain('text-fg-3');
    expect(document.querySelector('[data-activity-new]')?.textContent).toBe('1 new');
  });

  it('a group of one: the head and its single line', () => {
    mount(comments(1));
    expect(lines()).toHaveLength(1);
    expect(more()).toBeNull();
  });

  it('briefs, plan items and ideas behave the same', () => {
    for (const over of [
      { entityType: 'brief', scope: 'briefs', eventType: 'comment', title: 'Diwali brief' },
      { entityType: 'plan_item', eventType: 'plan_comment', planId: 'pl1', title: 'Reel idea' },
      {
        entityType: 'plan_item',
        eventType: 'plan_comment',
        planId: null,
        scopeKey: 'bank',
        title: 'Bank idea',
      },
    ] as Partial<ActivityItem>[]) {
      mount(comments(7, over));
      expect(lines()).toHaveLength(5);
      expect(more()?.textContent).toBe('+2 more');
      expect(document.querySelector('[data-list-card-title]')?.textContent).toBe(over.title);
    }
  });

  it('own actions get no line', () => {
    const [mine, theirs] = comments(2);
    expect(
      itemCardLines([{ ...(mine as ActivityItem), own: true }, theirs as ActivityItem]),
    ).toHaveLength(1);
  });

  it('unknown type: the fallback line, never dropped; a missing actor reads "Someone"', () => {
    mount([item({ id: 'u', eventType: 'something_new', actorName: null })]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]?.textContent).toContain('Someone');
    expect(entryLine(item({ eventType: 'something_new' })).text.length).toBeGreaterThan(0);
  });

  it('chat rows keep their one card: no lines, no "+N more"', () => {
    mount([
      item({
        id: 'chat',
        eventType: 'mention',
        entityType: 'chat_channel',
        entityId: 'chan-1',
        scope: 'groups',
        channelType: 'group',
        title: 'Launch crew',
        actorName: 'Bob',
        body: 'hey there',
      }),
    ]);
    expect(lines()).toHaveLength(0);
    expect(more()).toBeNull();
    expect(document.querySelector('[data-list-card-title]')?.textContent).toBe(
      'Bob mentioned you in Launch crew',
    );
    expect(document.body.textContent).toContain('hey there');
  });

  it('no green anywhere on the card', () => {
    mount(comments(8));
    act(() => more()?.click());
    expect(document.body.innerHTML).not.toMatch(/\b(bg|text|border)-(good|success|green)/);
  });
});

describe('Activity lines carry the comment text (locked 9 Nov 2026)', () => {
  const MAYA = '7f0e8a10-1b2c-4d3e-8f40-5a6b7c8d9e0f';

  afterEach(() => resetMentionNames());

  it('a comment line reads the actor, then the comment text, not "Commented on"', () => {
    mount([item({ id: 'a', commentId: 'cm', body: 'Love the second slide' })]);
    const [line] = lines();
    expect(line?.textContent).toContain('Priya');
    expect(line?.textContent).toContain('Love the second slide');
    expect(line?.textContent).not.toMatch(/Commented on/i);
  });

  it('a mention resolves to a name, never a raw @[uuid]', () => {
    rememberMentionNames('w1', [{ userId: MAYA, displayName: 'Maya' }]);
    // The read resolves the body as the comment thread does (resolvePersonMentionText).
    const body = resolvePersonMentionText(`Can you check @[${MAYA}]`, 'w1');
    mount([item({ id: 'm', eventType: 'mention', commentId: 'cm', body })]);
    const text = lines()[0]?.textContent ?? '';
    expect(text).toContain('@Maya');
    expect(text).not.toContain('@[');
    expect(text).not.toContain(MAYA);
  });

  it('a multi-line comment folds to one line; links are shortened', () => {
    const { text } = entryLineText(
      item({
        commentId: 'cm',
        body: 'First line\n\nsecond line see https://www.example.com/a/b/brief-final',
      }),
    );
    expect(text).not.toContain('\n');
    expect(text).toBe('First line second line see example.com/…/brief-final');
  });

  it('plan comments and checkpoint notes read their text too', () => {
    expect(
      entryLineText(item({ eventType: 'plan_comment', entityType: 'plan_item', body: 'Swap day' }))
        .text,
    ).toBe('Swap day');
    expect(
      entryLineText(item({ eventType: 'checkpoints_added', pointsAdded: 2, body: 'Crop tighter' }))
        .text,
    ).toBe('Crop tighter');
  });

  it('a deleted comment reads "Comment deleted", muted, and still opens its spot', () => {
    const gone = item({ id: 'g', commentId: 'cm', body: null, bodyGone: true });
    const { onOpenEntry } = mount([gone]);
    const [line] = lines();
    const text = line?.querySelector('[data-activity-line-gone]');
    expect(text?.textContent).toBe(COMMENT_DELETED);
    expect(text?.className).toContain('text-fg-3');
    act(() => line?.click());
    expect(onOpenEntry).toHaveBeenCalledWith(gone);
  });

  it('a stage change line keeps its activityLine wording', () => {
    const stage = item({ id: 's', eventType: 'stage_change', toStage: 'approved', body: null });
    expect(entryLineText(stage)).toEqual({ ...entryLine(stage), muted: false });
  });

  it('still one line per notification, same cap: 8 comments show 5 + "+3 more"', () => {
    mount(comments(8, { body: 'Looks good' }));
    expect(lines()).toHaveLength(ACTIVITY_LINES_SHOWN);
    expect(more()?.textContent).toBe('+3 more');
    for (const line of lines()) expect(line.textContent).toContain('Looks good');
  });
});
