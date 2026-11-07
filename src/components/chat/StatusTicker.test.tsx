import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: null, workspaceKey: null, workspaces: [] }),
}));

import { ToastProvider } from '@/components/ui/toast';
import {
  PlanBlock,
  StatusDrawerList,
  type StatusDrawerActions,
  type StatusDrawerData,
} from '@/components/chat/StatusDrawer';
import {
  POST_OPEN_FAILED,
  StatusTickerBar,
  barTap,
  postTapOutcome,
  prefetchPosts,
  rememberDrawer,
  renderedPostIds,
  resetDrawerMemory,
  settleBusyPost,
  takeDrawerMemory,
  tapPost,
  type PostTapCache,
  needsCompact,
  snapOpen,
  snapShut,
} from '@/components/chat/StatusTicker';
import type { PlanBundle } from '@/lib/chat/plans';
import { statusBar, type PlanSummary, type StatusBar } from '@/lib/chat/status-bar';

function bar(over: Partial<Parameters<typeof statusBar>[0]> = {}): StatusBar {
  return statusBar({ plans: [], posts: 0, briefs: 0, tasks: 0, side: 'agency', ...over });
}

function plan(id: string, title: string, approved = 1, total = 5, changes = 0): PlanSummary {
  return { id, title, approved, total, changes };
}

/** Every element in a returned tree (walks props.children). */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  walk((node.props as { children?: ReactNode }).children, out);
  return out;
}

/** The painted text, without the hidden measuring copies. */
const visible = (html: string): string =>
  html
    .replace(/<div[^>]*data-status-measure="[^"]*"[\s\S]*?<\/div>/g, '')
    .replace(/<span[^>]*data-status-measure="ellipsis"[^>]*>[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, '');

describe('first paint is final', () => {
  it('holds an empty, inert 36px slot until every read settles, then paints once', () => {
    const frames = [null, null, bar({ posts: 3, briefs: 2, tasks: 1 })].map(
      (b) => renderToStaticMarkup(<StatusTickerBar bar={b} />),
    );
    expect(frames[0]).toContain('data-loops-strip="pending"');
    expect(frames[0]).toContain('aria-hidden="true"');
    expect(frames[0]).toContain('h-9');
    expect(visible(frames[0] ?? '')).toBe('');
    expect(frames[0]).not.toContain('<button');
    expect(frames[1]).toBe(frames[0]);
    expect(frames[2]).toContain('data-loops-strip="open"');
    expect(visible(frames[2] ?? '')).toBe('3in review2briefs1task');
  });

  it('a failed read with nothing else open is a blank bar, never Nothing open', () => {
    const html = renderToStaticMarkup(<StatusTickerBar bar={bar({ posts: null })} />);
    expect(html).toContain('data-loops-strip="unknown"');
    expect(html).not.toContain('Nothing open');
  });
});

describe('Nothing open', () => {
  it('shows the check and the line in fg-3, and is not a button', () => {
    const html = renderToStaticMarkup(<StatusTickerBar bar={bar()} />);
    expect(html).toContain('data-loops-strip="empty"');
    expect(html).toContain('Open plans, posts, briefs and tasks show up here.');
    expect(html).toContain('text-fg-3');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-status-chevron');
  });
});

describe('the bar', () => {
  it('items are 44px targets over a 36px bar: tokens only, no callout', () => {
    const html = renderToStaticMarkup(
      <StatusTickerBar
        bar={bar({
          plans: [plan('a', 'Week ahead', 1, 5, 1), plan('b', 'Festive'), plan('c', 'Later')],
          briefs: 2,
        })}
      />,
    );
    expect(html).toContain('h-9');
    expect(html).toContain('px-4');
    expect(html).toContain('before:-inset-y-1');
    expect(html).toContain('[touch-action:none]');
    expect(html).toContain('[-webkit-touch-callout:none]');
    expect(html).toContain('select-none');
    expect(html).toContain('data-status-item="plan"');
    expect(html).toContain('text-warn');
    expect(html).toContain('data-status-more=""');
    expect(html).toContain('data-status-chevron=""');
  });

  it('a plan title item stays on one line, never wraps', () => {
    const html = renderToStaticMarkup(
      <StatusTickerBar
        bar={bar({ plans: [plan('a', 'A very long festive season launch plan'), plan('b', 'B')] })}
      />,
    );
    const item = html.match(/<button[^>]*data-status-item="plan"[^>]*>/)?.[0] ?? '';
    expect(item).toContain('whitespace-nowrap');
    expect(html).not.toContain('line-clamp');
  });

  it('no current shared plan: no plan item', () => {
    const html = renderToStaticMarkup(<StatusTickerBar bar={bar({ briefs: 2 })} />);
    expect(html).not.toContain('data-status-item="plan"');
    expect(visible(html)).toBe('2briefs');
  });

  it('one plan reads as today: "Plan A/N", no +K', () => {
    const html = renderToStaticMarkup(
      <StatusTickerBar bar={bar({ plans: [plan('a', 'Week ahead', 2, 5)], briefs: 2 })} />,
    );
    expect(html.match(/data-status-item="plan"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Plan 2 of 5 approved"');
    expect(visible(html)).toBe('Plan2/52briefs');
  });

  it('two plans: one item each, titled, soonest end first, no +K', () => {
    const html = renderToStaticMarkup(
      <StatusTickerBar
        bar={bar({ plans: [plan('a', 'Week ahead', 2, 5), plan('b', 'Festive', 3, 3)] })}
      />,
    );
    expect(html.match(/data-status-item="plan"/g)).toHaveLength(2);
    expect(visible(html)).toBe('Week ahead2/5Festive3/3');
    expect(html).toContain('aria-label="Week ahead 2 of 5 approved"');
    expect(html).not.toContain('data-status-more=""');
  });

  it('three plans: two items, then +1 for the rest', () => {
    const html = renderToStaticMarkup(
      <StatusTickerBar
        bar={bar({ plans: [plan('a', 'Week ahead'), plan('b', 'Festive'), plan('c', 'Later')] })}
      />,
    );
    expect(visible(html)).toBe('Week ahead1/5Festive1/5+1');
    expect(html).not.toContain('Later');
  });

  it('compact only when the full row overflows its room', () => {
    expect(needsCompact(400, 300)).toBe(true);
    expect(needsCompact(300, 300)).toBe(false);
    expect(needsCompact(400, 0)).toBe(false);
  });

  it('tap on an item opens at that section; elsewhere opens at the top; open closes', () => {
    const on = (key: string | null) => ({
      closest: () => (key === null ? null : { getAttribute: () => key }),
    });
    expect(barTap(false, on('briefs'))).toEqual({ action: 'open', section: 'briefs' });
    expect(barTap(false, on(null))).toEqual({ action: 'open', section: null });
    expect(barTap(false, on('nope'))).toEqual({ action: 'open', section: null });
    expect(barTap(true, on('briefs'))).toEqual({ action: 'close' });
  });

  it('snaps at 40% of the height or a flick over 0.4 px/ms', () => {
    expect(snapOpen({ offset: 40, height: 100, velocity: 0 })).toBe(true);
    expect(snapOpen({ offset: 39, height: 100, velocity: 0 })).toBe(false);
    expect(snapOpen({ offset: 5, height: 100, velocity: 0.5 })).toBe(true);
    expect(snapOpen({ offset: 90, height: 100, velocity: -0.5 })).toBe(false);
    expect(snapShut({ offset: 60, height: 100, velocity: 0 })).toBe(true);
    expect(snapShut({ offset: 61, height: 100, velocity: 0 })).toBe(false);
    expect(snapShut({ offset: 95, height: 100, velocity: -0.5 })).toBe(true);
  });
});

/** A current shared plan with one concept item. */
function planBundle(id: string, title: string): PlanBundle {
  return {
    plan: {
      id,
      workspace_id: 'w',
      title,
      starts_on: '2026-10-01',
      ends_on: '2026-10-30',
      audience: 'client',
      created_by: null,
    },
    items: [
      {
        id: `${id}-i`,
        plan_id: id,
        kind: 'concept',
        position: 0,
        title: 'Concept',
        description: null,
        post_id: null,
        created_at: '2026-10-01T00:00:00Z',
        target_date: null,
      },
    ],
    reviews: [],
    postStages: {},
    postInfo: {},
  };
}

describe('the drawer list', () => {
  const briefs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => ({
    id,
    number: i + 1,
    title: `Brief ${id}`,
    created_at: '2026-10-01T10:00:00Z',
  }));

  function drawer(over: Partial<StatusDrawerData & StatusDrawerActions> = {}) {
    const actions = {
      onOpenPlan: vi.fn(),
      onOpenPlanItem: vi.fn(),
      onOpenPost: vi.fn(),
      onOpenBrief: vi.fn(),
      onSeeAllBriefs: vi.fn(),
      onOpenTask: vi.fn(),
      onSeeAllTasks: vi.fn(),
    };
    const props = {
      keys: ['posts', 'briefs'] as const,
      side: 'agency' as const,
      timeZone: 'UTC',
      plans: [],
      posts: { heading: 'Posts waiting on approvers', rows: [], count: 0 },
      briefs: { rows: briefs, count: briefs.length },
      tasks: { rows: [], count: 0 },
      ...actions,
      ...over,
    };
    let tree: ReactElement | null = null;
    function Probe(): ReactElement {
      tree = StatusDrawerList({
        ...props,
        open: true,
        postsExpanded: false,
        onExpandPosts: () => {},
      });
      return tree;
    }
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    return { html, tree: walk(tree), actions };
  }

  it('sections in the bar order; five rows then See all', () => {
    const { html } = drawer();
    expect(html.indexOf('data-status-section="posts"')).toBeLessThan(
      html.indexOf('data-status-section="briefs"'),
    );
    expect(html.match(/data-status-brief="/g)?.length).toBe(5);
    expect(html).toContain('See all 7');
    expect(html).toContain('min-h-11');
    expect(html).toContain('line-clamp-2');
  });

  it('Plans lists every current shared plan in order; a tap opens that plan', () => {
    const plans = [
      planBundle('a', 'Week ahead'),
      planBundle('b', 'Festive'),
      planBundle('c', 'Later'),
    ];
    const { html, tree, actions } = drawer({ keys: ['plan'], plans });
    expect(html).toContain('Plans');
    expect(html).toContain('3 open');
    const blocks = [...html.matchAll(/data-plan-block="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toEqual(['a', 'b', 'c']);
    const open = tree.filter((el) => el.type === PlanBlock);
    expect(open).toHaveLength(3);
    (open[1]?.props as { onOpen: () => void }).onOpen();
    expect(actions.onOpenPlan).toHaveBeenCalledWith('b');
  });

  it('one plan: the section reads Plan and A/N', () => {
    const { html } = drawer({ keys: ['plan'], plans: [planBundle('a', 'Week ahead')] });
    expect(html).toContain('>Plan<');
    expect(html).toContain('0/1');
  });

  it('Tasks: title, due line and priority tag; five rows then See all; taps open the sheet', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      channelId: 'c',
      number: i + 1,
      title: `Task ${i + 1}`,
      side: 'agency' as const,
      status: 'todo' as const,
      priority: 1 as const,
      createdBy: null,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      deletedAt: null,
      dueOn: i === 0 ? '2026-10-12' : null,
      doneAt: null,
    }));
    const { html, tree, actions } = drawer({
      keys: ['tasks'],
      tasks: { rows: tasks, count: tasks.length },
    });
    expect(html).toContain('data-status-section="tasks"');
    expect(html).toContain('Open tasks');
    expect(html.match(/data-status-task="/g)?.length).toBe(5);
    expect(html).toContain('See all 6');
    expect(html).toContain('data-task-p="1"');
    expect(html).toContain('Due ');
    const row = tree.find(
      (el) => (el.props as { 'data-status-task'?: string })['data-status-task'] === 't0',
    );
    (row?.props as { onClick: () => void }).onClick();
    expect(actions.onOpenTask).toHaveBeenCalledWith('t0');
    const seeAll = tree.find((el) => (el.props as { attr?: string }).attr === 'tasks');
    (seeAll?.props as { onClick: () => void }).onClick();
    expect(actions.onSeeAllTasks).toHaveBeenCalledTimes(1);
  });

  it('"See all" for briefs goes to Briefs', () => {
    const { tree, actions } = drawer();
    const seeAll = tree.find((el) => (el.props as { attr?: string }).attr === 'briefs');
    expect(seeAll).toBeDefined();
    (seeAll?.props as { onClick: () => void }).onClick();
    expect(actions.onSeeAllBriefs).toHaveBeenCalledTimes(1);
  });
});

describe('post rows never fail silently', () => {
  /** A fake card cache: `state` per id, every request and retry recorded. */
  function fakeCache(state: Record<string, 'cached' | 'loading' | 'failed' | 'hidden'>) {
    const requests: string[][] = [];
    const retries: string[][] = [];
    const cache: PostTapCache = {
      posts: (ids) => ({
        loading: ids.some((id) => state[id] === 'loading'),
        posts: ids.filter((id) => state[id] === 'cached').map((id) => ({ id })),
        failed: ids.filter((id) => state[id] === 'failed'),
      }),
      request: (ids) => requests.push([...(ids.postIds ?? [])]),
      retry: (ids) => retries.push([...(ids.postIds ?? [])]),
    };
    return { cache, requests, retries, state };
  }

  it('opening the drawer asks for every rendered post id in one batched request', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}` }));
    const { cache, requests } = fakeCache({});
    prefetchPosts(cache, true, renderedPostIds(rows, false));
    expect(requests).toEqual([['p0', 'p1', 'p2', 'p3', 'p4']]);
    prefetchPosts(cache, true, renderedPostIds(rows, true));
    expect(requests[1]).toHaveLength(8);
    prefetchPosts(cache, false, renderedPostIds(rows, false));
    prefetchPosts(cache, true, []);
    prefetchPosts(null, true, ['p0']);
    expect(requests).toHaveLength(2);
  });

  it('a cached post opens at once', () => {
    const { cache, requests } = fakeCache({ a: 'cached' });
    expect(tapPost(cache, 'a')).toBe('open');
    expect(requests).toEqual([]);
  });

  it('an uncached post goes busy, then opens once its read lands', () => {
    const { cache, requests, state } = fakeCache({ a: 'loading' });
    expect(tapPost(cache, 'a')).toBe('busy');
    expect(requests).toEqual([['a']]);
    expect(settleBusyPost(cache, 'a')).toBeNull();
    state.a = 'cached';
    expect(settleBusyPost(cache, 'a')).toBe('open');
  });

  it('a failed or hidden read clears busy with the toast', () => {
    const { cache, retries, state } = fakeCache({ a: 'loading', h: 'hidden', f: 'failed' });
    expect(tapPost(cache, 'a')).toBe('busy');
    state.a = 'failed';
    expect(settleBusyPost(cache, 'a')).toBe('toast');
    state.a = 'hidden';
    expect(settleBusyPost(cache, 'a')).toBe('toast');
    expect(tapPost(cache, 'h')).toBe('toast');
    // A read that gave up earlier gets a fresh try instead of a dead tap.
    expect(tapPost(cache, 'f')).toBe('busy');
    expect(retries).toEqual([['f']]);
    expect(tapPost(null, 'a')).toBe('toast');
    expect(POST_OPEN_FAILED).toBe("Couldn't open this post. Try again.");
  });

  it('outcomes read the snapshot: open, failed, pending, not visible', () => {
    const snap = (over: object) => ({ loading: false, posts: [], failed: [], ...over });
    expect(postTapOutcome(snap({ posts: [{ id: 'a' }] }), 'a')).toBe('open');
    expect(postTapOutcome(snap({ failed: ['a'] }), 'a')).toBe('failed');
    expect(postTapOutcome(snap({ loading: true }), 'a')).toBe('pending');
    expect(postTapOutcome(snap({}), 'a')).toBe('not_visible');
  });

  it('the busy row keeps its box: same classes plus a tint and a pulsing chevron', () => {
    const post = {
      id: 'p1',
      number: 1,
      title: 'Launch teaser',
      format: 'carousel',
      target_date: null,
      stage_entered_at: '2026-10-01T00:00:00Z',
      thumbnailAssetVersionId: null,
    };
    const render = (busy: string | null): string => {
      function Probe(): ReactElement {
        return StatusDrawerList({
          keys: ['posts'],
          side: 'agency',
          timeZone: 'UTC',
          plans: [],
          posts: { heading: 'Posts waiting on approvers', rows: [post], count: 1 },
          briefs: { rows: [], count: 0 },
          tasks: { rows: [], count: 0 },
          onOpenPlan: () => {},
          onOpenPlanItem: () => {},
          onOpenPost: () => {},
          onOpenBrief: () => {},
          onSeeAllBriefs: () => {},
          onOpenTask: () => {},
          onSeeAllTasks: () => {},
          open: true,
          postsExpanded: false,
          onExpandPosts: () => {},
          busyPostId: busy,
        });
      }
      return renderToStaticMarkup(
        <ToastProvider>
          <Probe />
        </ToastProvider>,
      );
    };
    const idle = render(null);
    const busy = render('p1');
    expect(idle).toContain('aria-busy="false"');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('bg-panel-2');
    // No pulse: the busy row keeps its tint and aria-busy (motion never fades).
    expect(busy).not.toContain('animate-pulse');
    expect(busy.match(/min-h-11/g)?.length).toBe(idle.match(/min-h-11/g)?.length);
  });

  it('post and brief rows name their titles only, never a KEY-N code', () => {
    const post = {
      id: 'p1',
      number: 12,
      title: 'Launch teaser',
      format: 'carousel',
      target_date: null,
      stage_entered_at: '2026-10-01T00:00:00Z',
      thumbnailAssetVersionId: null,
    };
    const brief = {
      id: 'b1',
      number: 7,
      title: 'Diwali brief',
      created_at: '2026-10-01T00:00:00Z',
    };
    function Probe(): ReactElement {
      return StatusDrawerList({
        keys: ['posts', 'briefs'],
        side: 'agency',
        timeZone: 'UTC',
        plans: [],
        posts: { heading: 'Posts waiting on approvers', rows: [post], count: 1 },
        briefs: { rows: [brief], count: 1 },
        tasks: { rows: [], count: 0 },
        onOpenPlan: () => {},
        onOpenPlanItem: () => {},
        onOpenPost: () => {},
        onOpenBrief: () => {},
        onSeeAllBriefs: () => {},
        onOpenTask: () => {},
        onSeeAllTasks: () => {},
        open: true,
        postsExpanded: false,
        onExpandPosts: () => {},
        busyPostId: null,
      });
    }
    const html = renderToStaticMarkup(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    expect(html).toContain('Launch teaser');
    expect(html).toContain('Diwali brief');
    expect(html).toContain('data-status-brief="b1"');
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });
});

describe('drawer memory restores only on Back', () => {
  const state = { scrollTop: 120, postsExpanded: true };

  it('saved at key K restores when the chat mounts at K', () => {
    resetDrawerMemory();
    rememberDrawer('c1', 'K', state);
    expect(takeDrawerMemory('c1', 'K')).toEqual({ locationKey: 'K', ...state });
    expect(takeDrawerMemory('c1', 'K')).toBeNull();
  });

  it('a different key clears it and the drawer stays closed', () => {
    resetDrawerMemory();
    rememberDrawer('c1', 'K', state);
    expect(takeDrawerMemory('c1', 'L')).toBeNull();
    expect(takeDrawerMemory('c1', 'K')).toBeNull();
  });

  it('no router key remembers nothing; other channels are untouched', () => {
    resetDrawerMemory();
    rememberDrawer('c1', undefined, state);
    expect(takeDrawerMemory('c1', undefined)).toBeNull();
    rememberDrawer('c2', 'K', state);
    expect(takeDrawerMemory('c1', 'K')).toBeNull();
    expect(takeDrawerMemory('c2', 'K')).not.toBeNull();
  });
});
