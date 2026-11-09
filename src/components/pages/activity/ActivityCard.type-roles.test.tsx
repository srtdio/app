// @vitest-environment jsdom
// Type roles on the activity card (design rules, 24 Oct 2026): the card title
// is base/500 (was 15px semibold), the body line is base fg-2 secondary copy,
// the actor line and time are sm fg-3 meta, and the scope tag stays the xs
// chip. Fixtures and mocks mirror ActivityCard.test.tsx.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import type { PresignCache } from '@/lib/asset-presign';

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

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

function mount(group: ActivityItem[]): void {
  document.body.innerHTML = renderToStaticMarkup(
    <ActivityCard
      group={group}
      nowMs={NOW}
      cache={cache}
      presignEnabled={false}
      onOpenGroup={() => {}}
      onOpenEntry={() => {}}
      selfName={null}
    />,
  );
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ActivityCard type roles (ui/ListCard: heading, secondary, meta + one tag)', () => {
  it('the card title is the heading role, one truncated line', () => {
    mount([item({ title: 'Q3 Launch', body: 'Looks good to me', actorName: 'Asha Rao' })]);
    const title = document.querySelector('[data-list-card-title]');
    // 9 Nov 2026: the head names the item; the notification is its own line.
    expect(title?.textContent).toBe('Q3 Launch');
    expectRole(title as HTMLElement, ['text-lg', 'font-semibold', 'truncate']);
    expect(title?.className).not.toMatch(/leading-\[/);
  });

  it('the head preview ("N new") and each line are the secondary role, one truncated line', () => {
    mount([item({ title: 'Q3 Launch', body: 'Looks good to me', actorName: 'Asha Rao' })]);
    const preview = byText('1 new');
    expectRole(preview, ['text-md', 'text-fg-2', 'truncate']);
    // A comment line reads the comment text (locked 9 Nov 2026).
    const line = byText('Looks good to me');
    expectRole(line, ['text-md', 'truncate']);
    expect(line.className).not.toContain('line-clamp-2');
  });

  it('the time is the meta role: mono, tabular, fg-3', () => {
    mount([item({ title: 'Q3 Launch' })]);
    const time = document.querySelector('[data-activity-time]');
    expect(time).not.toBeNull();
    expectRole(time as HTMLElement, ['font-mono', 'text-sm', 'tabular-nums', 'text-fg-3']);
  });

  it('the kind tag is the one grey xs Tag', () => {
    mount([item({ title: 'Q3 Launch', scope: 'posts' })]);
    expectRole(byText('Post'), ['text-xs', 'font-medium', 'bg-panel-2', 'text-fg-2']);
    expect(document.querySelectorAll('[data-list-card-tag]')).toHaveLength(1);
  });

  it('renders no arbitrary pixel sizes or bold weights', () => {
    mount([item({ title: 'Q3 Launch', body: 'Looks good to me', actorName: 'Asha Rao' })]);
    const html = document.body.innerHTML;
    expect(html).not.toMatch(/text-\[\d+(\.\d+)?px\]/);
    expect(html).not.toMatch(/leading-\[\d+(\.\d+)?px\]/);
    expect(html).not.toContain('font-bold');
    expect(html).not.toContain('tracking-wide');
  });
});
