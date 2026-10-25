// @vitest-environment jsdom
// Type roles on the activity card (design rules, 24 Oct 2026): the card title
// is base/500 (was 15px semibold), the body line is base fg-2 secondary copy,
// the actor line and time are sm fg-3 meta, and the scope tag stays the xs
// chip. Fixtures and mocks mirror ActivityCard.test.tsx.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
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
      onSnooze={() => {}}
      onMarkRead={() => {}}
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

describe('ActivityCard type roles', () => {
  it('the card title is base/500, never 15px semibold', () => {
    mount([item({ title: 'Q3 Launch', body: 'Looks good to me', actorName: 'Asha Rao' })]);
    const title = byText('Q3 Launch');
    expectRole(title, ['text-base', 'font-medium', 'text-fg']);
    expect(title.className).not.toContain('text-lg');
    expect(title.className).not.toContain('font-semibold');
    expect(title.className).not.toMatch(/leading-\[/);
  });

  it('the body line is base fg-2 secondary copy', () => {
    mount([item({ title: 'Q3 Launch', body: 'Looks good to me', actorName: 'Asha Rao' })]);
    const p = [...document.querySelectorAll('p')].find((el) =>
      el.textContent?.includes('Looks good to me'),
    );
    expect(p).toBeDefined();
    expectRole(p as HTMLElement, ['text-base', 'text-fg-2']);
  });

  it('the time is sm fg-3 meta in sans tabular figures', () => {
    mount([item({ title: 'Q3 Launch' })]);
    const time = document.querySelector('[data-activity-time]');
    expect(time).not.toBeNull();
    expectRole(time as HTMLElement, ['text-sm', 'tabular-nums', 'text-fg-3']);
    expect(time?.className).not.toContain('font-mono');
  });

  it('the scope tag stays the xs chip', () => {
    mount([item({ title: 'Q3 Launch', scope: 'posts' })]);
    expectRole(byText('Posts'), ['text-xs', 'font-medium', 'text-fg-2']);
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
