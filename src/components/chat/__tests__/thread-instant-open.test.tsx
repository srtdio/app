// @vitest-environment jsdom
// Chat threads open instantly (10 Nov 2026): a loaded root paints the view in
// the same frame (loading), the first page fills it or marks it failed (+
// Retry); a newer open supersedes an older one (no single-flight lockout); a
// bubble tap opens its thread except on interactive children or while
// selecting; the push moves the chat pane behind.

import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useThreadView } from '@/lib/chat/use-thread-view';
import type { HistoryPage } from '@/lib/chat/history';
import type { ChatMessageRow, MessageReaction, ThreadMessage } from '@/lib/chat/thread';
import { THREAD_LOAD_FAILED, ThreadViewFill, ThreadViewFrame } from '@/components/chat/ThreadView';
import { BUBBLE_TAP_KEEP, bubbleTapOpens } from '@/components/chat/MessageBubble';
import { resetPlayerForTests } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ROOT = { id: 'root-1', body: 'Hi' } as unknown as ThreadMessage;
const OTHER = { id: 'root-2', body: 'Yo' } as unknown as ThreadMessage;
const EMPTY: Result<HistoryPage> = { ok: true, data: { rows: [], hasMore: false } };
const FAILED: Result<HistoryPage> = {
  ok: false,
  error: { code: 'unknown', message: 'offline' },
} as Result<HistoryPage>;

function harness(pages: Array<Deferred<Result<HistoryPage>>>, rootRow?: ChatMessageRow) {
  const calls = { page: 0 };
  const reads = {
    loadRoot: vi.fn(
      (): Promise<Result<ChatMessageRow[]>> =>
        Promise.resolve(
          rootRow !== undefined ? { ok: true, data: [rootRow] } : { ok: true, data: [] },
        ),
    ),
    loadPage: vi.fn((): Promise<Result<HistoryPage>> => {
      const next = pages[calls.page];
      calls.page += 1;
      return next?.promise ?? Promise.resolve(EMPTY);
    }),
    loadReactions: vi.fn(
      (): Promise<Result<Map<string, MessageReaction[]>>> =>
        Promise.resolve({ ok: true, data: new Map() }),
    ),
  };
  const out: { hook: ReturnType<typeof useThreadView> | null } = { hook: null };
  function Probe(): null {
    const stable = useRef(reads);
    out.hook = useThreadView({ channelId: 'c1', currentUserId: 'u1', reads: stable.current });
    return null;
  }
  mount(<Probe />);
  return { out, reads };
}

describe('useThreadView: open without waiting', () => {
  it('paints the loaded root with loading in the same call, before any read resolves', () => {
    const page = deferred<Result<HistoryPage>>();
    const { out } = harness([page]);
    act(() => {
      void out.hook?.open(ROOT.id, [ROOT]);
    });
    expect(out.hook?.view?.rootId).toBe(ROOT.id);
    expect(out.hook?.view?.root).toBe(ROOT);
    expect(out.hook?.view?.loading).toBe(true);
    expect(out.hook?.view?.fetched).toEqual([]);
  });

  it('the first page fills it; a failure marks failed and Retry re-reads', async () => {
    const first = deferred<Result<HistoryPage>>();
    const second = deferred<Result<HistoryPage>>();
    const { out, reads } = harness([first, second]);
    act(() => {
      void out.hook?.open(ROOT.id, [ROOT]);
    });
    await act(async () => first.resolve(FAILED));
    expect(out.hook?.view?.failed).toBe(true);
    expect(out.hook?.view?.loading).toBe(false);
    act(() => out.hook?.retry());
    expect(out.hook?.view?.loading).toBe(true);
    expect(out.hook?.view?.failed).toBe(false);
    expect(reads.loadPage).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(EMPTY));
    expect(out.hook?.view?.loading).toBe(false);
    expect(out.hook?.view?.failed).toBe(false);
  });

  it('a newer open supersedes a hung one (no lockout); the stale page is dropped', async () => {
    const hung = deferred<Result<HistoryPage>>();
    const next = deferred<Result<HistoryPage>>();
    const { out } = harness([hung, next]);
    act(() => {
      void out.hook?.open(ROOT.id, [ROOT, OTHER]);
    });
    act(() => {
      void out.hook?.open(OTHER.id, [ROOT, OTHER]);
    });
    expect(out.hook?.view?.rootId).toBe(OTHER.id);
    await act(async () => hung.resolve(FAILED));
    // The older attempt's failure never reaches the newer view.
    expect(out.hook?.view?.rootId).toBe(OTHER.id);
    expect(out.hook?.view?.failed).toBe(false);
    await act(async () => next.resolve(EMPTY));
    expect(out.hook?.view?.loading).toBe(false);
  });

  it('a root that cannot be found resolves false (toast) and the view stays shut', async () => {
    const { out } = harness([]);
    let opened: boolean | undefined;
    await act(async () => {
      opened = await out.hook?.open('missing', []);
    });
    expect(opened).toBe(false);
    expect(out.hook?.view).toBeNull();
  });
});

describe('bubble tap opens its thread', () => {
  function clickOn(target: Element, currentTarget: Element) {
    return { defaultPrevented: false, target, currentTarget };
  }
  beforeEach(() => window.getSelection()?.removeAllRanges());

  it('opens on the body text, not on interactive children', () => {
    const bubble = document.createElement('div');
    const text = document.createElement('p');
    bubble.appendChild(text);
    const onTapOpen = vi.fn();
    expect(bubbleTapOpens({ event: clickOn(text, bubble), selecting: false, onTapOpen })).toBe(
      true,
    );
    for (const html of [
      '<a href="/x">x</a>',
      '<button>x</button>',
      '<img alt="">',
      '<span data-mention="">@Ana</span>',
      '<span data-msg-link="">link</span>',
      '<div data-plan-card=""><span>x</span></div>',
      '<div data-voice-note=""><span>x</span></div>',
      '<span role="button">x</span>',
    ]) {
      const host = document.createElement('div');
      host.innerHTML = html;
      bubble.appendChild(host);
      const inner = host.querySelector('span span, span, a, button, img, div') ?? host;
      expect(bubbleTapOpens({ event: clickOn(inner, bubble), selecting: false, onTapOpen })).toBe(
        false,
      );
    }
    expect(BUBBLE_TAP_KEEP).toContain('audio');
  });

  it('never while selecting, when consumed, or without an opener (reply blocked)', () => {
    const bubble = document.createElement('div');
    const onTapOpen = vi.fn();
    expect(bubbleTapOpens({ event: clickOn(bubble, bubble), selecting: true, onTapOpen })).toBe(
      false,
    );
    expect(
      bubbleTapOpens({
        event: { ...clickOn(bubble, bubble), defaultPrevented: true },
        selecting: false,
        onTapOpen,
      }),
    ).toBe(false);
    expect(
      bubbleTapOpens({ event: clickOn(bubble, bubble), selecting: false, onTapOpen: undefined }),
    ).toBe(false);
  });
});

describe('thread view push moves the chat pane behind', () => {
  type AnimateFn = HTMLElement['animate'];
  const original = (HTMLElement.prototype as { animate?: AnimateFn }).animate;
  let targets: Element[] = [];
  beforeEach(() => {
    targets = [];
    (HTMLElement.prototype as { animate?: unknown }).animate = vi.fn(function (this: Element) {
      targets.push(this);
      return { addEventListener: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
    });
  });
  afterEach(() => {
    resetPlayerForTests();
    if (original === undefined) delete (HTMLElement.prototype as { animate?: unknown }).animate;
    else (HTMLElement.prototype as { animate?: unknown }).animate = original;
  });

  it('pushIn with the pane behind on mount; Close pushes back with it', () => {
    const pane = document.createElement('div');
    document.body.appendChild(pane);
    const behindRef = { current: pane };
    const host = mount(
      <ThreadViewFrame title="Thread" selecting={false} onClosed={vi.fn()} behindRef={behindRef}>
        <div />
      </ThreadViewFrame>,
    );
    const view = host.querySelector('[data-thread-view]');
    expect(targets).toContain(pane);
    expect(targets).toContain(view);
    targets = [];
    act(() => host.querySelector<HTMLButtonElement>('[data-thread-view-close]')?.click());
    expect(targets).toContain(pane);
    expect(targets).toContain(view);
  });
});

describe('thread view fill', () => {
  it('placeholders while loading; the failure line and Retry when failed', () => {
    const loading = renderToStaticMarkup(
      <ThreadViewFill loading failed={false} onRetry={() => undefined} />,
    );
    expect(loading).toContain('data-thread-fill');
    expect(loading).toContain('data-bone');
    const failed = renderToStaticMarkup(
      <ThreadViewFill loading={false} failed onRetry={() => undefined} />,
    );
    expect(THREAD_LOAD_FAILED).toBe("Couldn't load this thread.");
    expect(failed).toContain('load this thread.');
    expect(failed).toContain('Retry');
    expect(
      renderToStaticMarkup(
        <ThreadViewFill loading={false} failed={false} onRetry={() => undefined} />,
      ),
    ).toBe('');
  });
});
