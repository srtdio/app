import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: null, workspaceKey: null, workspaces: [] }),
}));

import { ToastProvider } from '@/components/ui/toast';
import {
  StatusDrawerList,
  StatusMarkRow,
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
import type { ChatMark } from '@/lib/chat/marks';
import type { WriteResult } from '@/lib/chat/record';
import { statusBar, type StatusBar } from '@/lib/chat/status-bar';
import type { ThreadMessage } from '@/lib/chat/thread';

const NO_MARKS = { commitments: 0, decisions: 0, pending: 0, p1: 0 };

function bar(over: Partial<Parameters<typeof statusBar>[0]> = {}): StatusBar {
  return statusBar({ plan: 'none', posts: 0, briefs: 0, marks: NO_MARKS, side: 'agency', ...over });
}

function mark(id: string, type: ChatMark['type'] = 'commitment'): ChatMark {
  return {
    messageId: id,
    channelId: 'c',
    type,
    priority: type === 'pending' ? 1 : null,
    markedAt: `2026-10-0${id.length}T10:00:00Z`,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
}

function message(id: string, body: string): ThreadMessage {
  return {
    id,
    body,
    mine: false,
    senderUserId: 'u1',
    createdAt: '2026-10-01T10:00:00Z',
    time: Date.parse('2026-10-01T10:00:00Z'),
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
  } as unknown as ThreadMessage;
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

/** The painted text, without the hidden measuring copy. */
const visible = (html: string): string =>
  html.replace(/<div[^>]*data-status-measure=""[\s\S]*?<\/div>/, '').replace(/<[^>]+>/g, '');

describe('first paint is final', () => {
  it('holds an empty, inert 36px slot until every read settles, then paints once', () => {
    const frames = [null, null, bar({ posts: 3, marks: { ...NO_MARKS, commitments: 2 } })].map(
      (b) => renderToStaticMarkup(<StatusTickerBar bar={b} />),
    );
    expect(frames[0]).toContain('data-loops-strip="pending"');
    expect(frames[0]).toContain('aria-hidden="true"');
    expect(frames[0]).toContain('h-9');
    expect(visible(frames[0] ?? '')).toBe('');
    expect(frames[0]).not.toContain('<button');
    expect(frames[1]).toBe(frames[0]);
    expect(frames[2]).toContain('data-loops-strip="open"');
    expect(visible(frames[2] ?? '')).toBe('3in review2commitments');
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
    expect(html).toContain('Nothing open between you');
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
        bar={bar({ plan: { approved: 1, total: 5, changes: 1, more: 1 }, briefs: 2 })}
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

describe('the drawer list', () => {
  const marks = new Map(
    ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map((id) => [id, mark(id)] as const),
  );
  marks.set('p', mark('p', 'pending'));
  const messages = new Map([...marks.keys()].map((id) => [id, message(id, `Body ${id}`)]));

  function drawer(over: Partial<StatusDrawerData & StatusDrawerActions> = {}) {
    const actions = {
      onOpenPlan: vi.fn(),
      onOpenPlanItem: vi.fn(),
      onOpenPost: vi.fn(),
      onOpenBrief: vi.fn(),
      onSeeAllBriefs: vi.fn(),
      onJumpMark: vi.fn(),
      onSeeAllMarks: vi.fn(),
    };
    const onResolveMark = vi.fn(
      (): Promise<WriteResult> => Promise.resolve({ ok: true } as WriteResult),
    );
    const props = {
      keys: ['commitments', 'pending'] as const,
      side: 'agency' as const,
      timeZone: 'UTC',
      workspaceKey: null,
      plans: [],
      posts: { heading: 'Posts waiting on client', rows: [], count: 0 },
      briefs: { rows: [], count: 0 },
      marks,
      messageFor: (id: string) => messages.get(id),
      profiles: new Map(),
      onResolveMark,
      onReopenMark: vi.fn((): Promise<WriteResult> => Promise.resolve({ ok: true } as WriteResult)),
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
    return { html, tree: walk(tree), actions, onResolveMark };
  }

  it('sections in the bar order; five rows then See all; P1 pill on pending', () => {
    const { html } = drawer();
    expect(html.indexOf('data-status-section="commitments"')).toBeLessThan(
      html.indexOf('data-status-section="pending"'),
    );
    expect(html.match(/data-status-mark="/g)?.length).toBe(6);
    expect(html).toContain('See all 6');
    expect(html).toContain('data-priority="P1"');
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('line-clamp-2');
  });

  it('"See all" for marks opens the MarksSheet', () => {
    const { tree, actions } = drawer();
    const seeAll = tree.find((el) => (el.props as { attr?: string }).attr === 'marks');
    expect(seeAll).toBeDefined();
    (seeAll?.props as { onClick: () => void }).onClick();
    expect(actions.onSeeAllMarks).toHaveBeenCalledTimes(1);
  });

  it('a mark row stamp goes through the confirm: Ask never writes, Confirm does', async () => {
    const { tree, onResolveMark, actions } = drawer();
    const row = tree.find(
      (el) => el.type === StatusMarkRow && (el.props as { mark: ChatMark }).mark.messageId === 'p',
    );
    expect(row).toBeDefined();
    const rowProps = row?.props as {
      onAsk: () => void;
      onConfirm: () => void;
      onJump: () => void;
    };
    rowProps.onAsk();
    expect(onResolveMark).not.toHaveBeenCalled();
    rowProps.onConfirm();
    await Promise.resolve();
    expect(onResolveMark).toHaveBeenCalledWith('p');
    rowProps.onJump();
    expect(actions.onJumpMark).toHaveBeenCalledWith('p');
  });

  it('the row asks first: the stamp button only asks; the confirm names the stamp', () => {
    const base = {
      mark: mark('x', 'decision'),
      text: 'Go green',
      meta: 'Asha · 10:00',
      busy: false,
      canStamp: true,
      onJump: vi.fn(),
      onAsk: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    };
    const idle = renderToStaticMarkup(<StatusMarkRow {...base} confirming={false} />);
    expect(idle).toContain('Closed');
    expect(idle).not.toContain('data-mark-confirm');
    const asking = renderToStaticMarkup(<StatusMarkRow {...base} confirming />);
    expect(asking).toContain('data-mark-confirm="resolve"');
    expect(asking).toContain('Mark this decision as closed?');
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
    expect(POST_OPEN_FAILED).toBe("Couldn't open this post");
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
          workspaceKey: null,
          plans: [],
          posts: { heading: 'Posts waiting on client', rows: [post], count: 1 },
          briefs: { rows: [], count: 0 },
          marks: new Map(),
          messageFor: () => undefined,
          profiles: new Map(),
          onOpenPlan: () => {},
          onOpenPlanItem: () => {},
          onOpenPost: () => {},
          onOpenBrief: () => {},
          onSeeAllBriefs: () => {},
          onJumpMark: () => {},
          onSeeAllMarks: () => {},
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
    expect(busy).toContain('animate-pulse');
    expect(busy.match(/min-h-\[44px\]/g)?.length).toBe(idle.match(/min-h-\[44px\]/g)?.length);
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
