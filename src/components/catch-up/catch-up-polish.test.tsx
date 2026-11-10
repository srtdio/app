// @vitest-environment jsdom
// Catch-up polish (10 Nov 2026): kind sticker, replies row, comment words,
// first-link previews, the newest row never under the reply box, and the one
// message action layer's keys.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { stickerOf, CatchUpCard } from '@/components/catch-up/CatchUpCard';
import { firstLinkOf, firstName, repliedLine } from '@/components/catch-up/CatchUpRows';
import { replyHint, sheetTitle, targetRootOf } from '@/components/catch-up/CatchUpScreen';
import { actionKeysOf } from '@/components/catch-up/CatchUpActionLayer';
import { IconBank, IconBriefs, IconChat, IconPipeline, IconPlan } from '@/components/ui/icons';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';
import type { CatchUpBody, CatchUpMessageRow } from '@/lib/catch-up/body';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import type { PresignCache } from '@/lib/asset-presign';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const msg = (over: Partial<CatchUpMessageRow> = {}): CatchUpMessageRow => ({
  kind: 'message',
  id: 'm1',
  author: { id: 'u1', name: 'Priya Shah', avatarUrl: null },
  createdAt: '2026-11-08T10:00:00Z',
  text: 'Looks good',
  replyCount: 0,
  ...over,
});

const item = (kind: CatchUpItem['kind']): CatchUpItem => ({ ...cardOf(entry()), kind });

describe('kind sticker', () => {
  it('nav icon + word per kind', () => {
    expect(stickerOf('post')).toEqual({ label: 'Post', Icon: IconPipeline });
    expect(stickerOf('plan-item')).toEqual({ label: 'Plan', Icon: IconPlan });
    expect(stickerOf('brief')).toEqual({ label: 'Brief', Icon: IconBriefs });
    expect(stickerOf('idea')).toEqual({ label: 'Idea', Icon: IconBank });
    expect(stickerOf('chat-main')).toEqual({ label: 'Chat', Icon: IconChat });
    expect(stickerOf('chat-thread')).toEqual({ label: 'Chat', Icon: IconChat });
  });
});

describe('comment words', () => {
  it('the box: Comment, Reply to <first name>; chat unchanged', () => {
    expect(replyHint(item('post'), false)).toBe('Comment');
    expect(replyHint(item('brief'), true, 'Priya Shah')).toBe('Reply to Priya');
    expect(replyHint(item('plan-item'), false)).toBe('Comment');
    expect(replyHint(item('chat-thread'), false)).toBe('Reply in thread');
    expect(replyHint(item('chat-main'), true, 'Priya Shah')).toBe('Reply in thread');
  });

  it('the grey line by family', () => {
    const root = msg({ text: 'Swap the cover' });
    expect(repliedLine('comment', root)).toBe('Replied to Priya: Swap the cover');
    expect(repliedLine('chat', root)).toBe('Replied in thread: Swap the cover');
    expect(firstName('  Maya  ')).toBe('Maya');
  });

  it('the sheet title by family', () => {
    expect(sheetTitle(item('post'))).toBe('Replies');
    expect(sheetTitle(item('chat-main'))).toBe('Thread');
  });

  it('the Slack-way target names its root author', () => {
    const root = msg({ id: 'root', author: { id: 'u2', name: 'Sam Lee', avatarUrl: null } });
    const body = { rows: [msg({ id: 'r1', threadRoot: root })] } as unknown as CatchUpBody;
    const target = {
      kind: 'comment' as const,
      entityType: 'post' as const,
      entityId: 'p1',
      parentCommentId: 'root',
    };
    expect(targetRootOf(body, target)?.author.name).toBe('Sam Lee');
    expect(targetRootOf(body, null)).toBeNull();
  });
});

describe('link previews', () => {
  it('the first link only', () => {
    expect(firstLinkOf('see https://a.example/x and https://b.example')).toBe(
      'https://a.example/x',
    );
    expect(firstLinkOf('no links here')).toBeNull();
  });
});

describe('the one action layer: keys', () => {
  it('chat rows: to-do when the chat is known, forward always', () => {
    const chat = { ...item('chat-main'), entityId: 'ch1' } as CatchUpItem;
    expect(actionKeysOf({ item: chat, row: msg() }, [{ channelId: 'ch1' }])).toEqual({
      tasks: true,
      forward: true,
    });
    expect(actionKeysOf({ item: chat, row: msg() }, [])).toEqual({ tasks: false, forward: true });
  });

  it('comment rows: post and brief comments make a task; plan comments do not', () => {
    expect(actionKeysOf({ item: item('post'), row: msg() }, [])).toEqual({
      tasks: true,
      forward: true,
    });
    expect(actionKeysOf({ item: item('idea'), row: msg() }, [])).toEqual({
      tasks: false,
      forward: true,
    });
    expect(actionKeysOf({ item: item('brief'), row: msg({ text: ' ' }) }, [])).toEqual({
      tasks: false,
      forward: false,
    });
  });
});

describe('newest row never under the reply box', () => {
  let root: Root | null = null;
  const observers: { cb: () => void; off: boolean }[] = [];
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  function mount(): HTMLDivElement {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        rec: { cb: () => void; off: boolean };
        constructor(cb: () => void) {
          this.rec = { cb, off: false };
          observers.push(this.rec);
        }
        observe(): void {}
        disconnect(): void {
          this.rec.off = true;
        }
      },
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const body: CatchUpBody = {
      title: 'Card',
      context: null,
      rows: [msg()],
      firstNewId: null,
      hasOlder: false,
      threads: false,
      latestReplyId: null,
    };
    act(() =>
      root?.render(
        <CatchUpCard
          item={item('plan-item')}
          body={body}
          older={[]}
          sent={[]}
          selfName={null}
          laptop={false}
          tint={null}
          typing={null}
          menu={{ title: 'Card', items: [] }}
          onRetrySend={() => undefined}
          onRetryLoad={() => undefined}
          onOpenThread={() => undefined}
          onOpenPoint={() => undefined}
          onNearTop={() => undefined}
          cache={{} as PresignCache}
          presignEnabled={false}
          onOpenPicture={() => undefined}
        />,
      ),
    );
    const el = host.querySelector<HTMLDivElement>('[data-catch-up-body]');
    if (el === null) throw new Error('no body');
    // jsdom has no layout: the one row sits 700 down; keep scrollTop as written.
    const li = el.querySelector('[data-catch-up-rows] > li');
    if (li !== null) Object.defineProperty(li, 'offsetTop', { configurable: true, value: 700 });
    let top = 0;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    return el;
  }

  function grow(el: HTMLDivElement, height: number): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: height });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
    act(() => observers.forEach((o) => !o.off && o.cb()));
  }

  it('re-places at the bottom when rows grow before the first scroll', () => {
    const el = mount();
    expect(observers).toHaveLength(1);
    grow(el, 900);
    expect(el.scrollTop).toBe(700);
  });

  it('stops after the person scrolls', () => {
    const el = mount();
    grow(el, 900);
    el.scrollTop = 300;
    act(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    grow(el, 1200);
    expect(el.scrollTop).toBe(300);
    expect(observers[0]?.off).toBe(true);
  });
});

describe('strip keys: the shared openers', () => {
  it('to-do, forward and more on the catch-up strip call the one action layer', async () => {
    const { CatchUpThreadView } = await import('@/components/catch-up/CatchUpThreadView');
    const onTasks = vi.fn();
    const onForward = vi.fn();
    const onMore = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <CatchUpThreadView
          root={msg()}
          thread={{ root: msg(), replies: [msg({ id: 'r1' })] }}
          sent={[]}
          selfName={null}
          reply={null}
          onRetryLoad={() => undefined}
          onRetrySend={() => undefined}
          actions={{ onTasks, onForward, onMore }}
        />,
      ),
    );
    const key = (name: string): HTMLElement => {
      const el = host.querySelector<HTMLElement>(`[data-thread-root-action="${name}"]`);
      if (el === null) throw new Error(`no ${name} key`);
      return el;
    };
    act(() => key('tasks').click());
    act(() => key('forward').click());
    act(() => key('more').click());
    expect(onTasks).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledWith(key('more'));
    act(() => root.unmount());
  });
});
