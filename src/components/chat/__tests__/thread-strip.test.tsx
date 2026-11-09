// @vitest-environment jsdom
// The one thread strip (9 Nov 2026): chat's RepliesSeparatorRow is the only
// strip; catch up's thread view draws it too (no second count row). A band
// between two hairlines, 44 tall, a faint fg tint; a 32 icon column on the
// photo column, the label on the message text column; "Reply in thread"
// focuses the reply box (pointerdown keeps focus off the strip), "N replies"
// is ink and not a target; the root keys stay on the right.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useCoarsePointer: () => true,
}));

import {
  REPLY_IN_THREAD,
  RepliesSeparatorRow,
  THREAD_STRIP_COLUMNS,
} from '@/components/chat/ThreadRail';
import { CatchUpThreadView } from '@/components/catch-up/CatchUpThreadView';
import type { CatchUpMessageRow } from '@/lib/catch-up/body';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

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

describe('RepliesSeparatorRow: the one strip', () => {
  it('band: two hairlines, 44 tall, the fg tint, icon column w-8 then the label', () => {
    const out = renderToStaticMarkup(
      <ul>
        <RepliesSeparatorRow label="2 replies" through={false} />
      </ul>,
    );
    expect(out).toContain('border-y border-border');
    expect(out).toContain('min-h-11');
    expect(out).toContain('bg-fg/[0.03]');
    expect(out).toContain('data-thread-strip-icon');
    expect(out).toMatch(/data-thread-strip-icon[^>]*class="[^"]*w-8/);
    expect(out).toContain('data-thread-strip="replies"');
  });

  it('label column = the host text column: chat 16 + 32 + 8, catch up 16 + 32 + 12', () => {
    expect(THREAD_STRIP_COLUMNS.chat).toEqual({ x: 'px-4', gap: 'gap-2' });
    expect(THREAD_STRIP_COLUMNS['catch-up']).toEqual({ x: 'px-4', gap: 'gap-3' });
    // The hosts' rows: chat 'px-4' + 'gap-2'; catch up px-4 + gap-3.
    expect(src('components/chat/MessageBubble.tsx')).toContain("'group flex items-start gap-2'");
    expect(src('components/catch-up/CatchUpRows.tsx')).toContain("'flex gap-3 py-2'");
  });

  it('"N replies" is ink and not a focus target', () => {
    const onFocusReply = vi.fn();
    act(() =>
      root?.render(
        <ul>
          <RepliesSeparatorRow label="3 replies" through={false} onFocusReply={onFocusReply} />
        </ul>,
      ),
    );
    const label = document.querySelector('[data-thread-strip-label]');
    expect(label?.textContent).toBe('3 replies');
    expect(label?.className).toContain('text-fg');
    expect(label?.className).not.toContain('text-fg-2');
    expect(document.querySelector('[data-thread-strip-focus]')).toBeNull();
  });

  it('no replies: "Reply in thread" (fg-2) focuses the reply box; pointerdown keeps focus', () => {
    const onFocusReply = vi.fn();
    act(() =>
      root?.render(
        <ul>
          <RepliesSeparatorRow label={null} through={false} onFocusReply={onFocusReply} />
        </ul>,
      ),
    );
    const label = document.querySelector('[data-thread-strip-label]');
    expect(label?.textContent).toBe(REPLY_IN_THREAD);
    expect(label?.className).toContain('text-fg-2');
    const tap = document.querySelector<HTMLButtonElement>('[data-thread-strip-focus]');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    tap?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => tap?.click());
    expect(onFocusReply).toHaveBeenCalledTimes(1);
  });

  it('root keys stay on the right, 44 each, unchanged', () => {
    const out = renderToStaticMarkup(
      <ul>
        <RepliesSeparatorRow
          label={null}
          through={false}
          actions={{ onTasks: () => {}, onForward: () => {}, onMore: () => {} }}
        />
      </ul>,
    );
    expect(out).toContain('data-thread-root-action="tasks"');
    expect(out).toContain('data-thread-root-action="forward"');
    expect(out).toContain('data-thread-root-action="more"');
    expect(out).toContain('-mr-3');
  });

  it('chat thread view: the strip shows at 0 replies, 12 above and 8 below; focus wired', () => {
    const mt = src('components/chat/MessageThread.tsx');
    expect(mt).toContain('const strip = threads !== undefined && viewRoot;');
    expect(mt).toContain('className="mb-2 mt-3"');
    expect(mt).toContain('onFocusReply={threads?.onFocusReply}');
    expect(mt).toContain('onFocusReply: () => focusComposerInput(viewComposerInputRef.current)');
  });
});

const author = { id: 'u1', name: 'Priya', avatarUrl: null };
const rootRow: CatchUpMessageRow = {
  kind: 'message',
  id: 'r1',
  author,
  createdAt: '2026-11-09T10:00:00.000Z',
  text: 'Root message',
  replyCount: 0,
};

describe('CatchUpThreadView uses the one strip', () => {
  it('no second count row; the shared strip in the catch-up family', () => {
    expect(src('components/catch-up/CatchUpThreadView.tsx')).not.toContain(
      'data-catch-up-thread-count',
    );
    act(() =>
      root?.render(
        <CatchUpThreadView
          root={rootRow}
          thread={{ root: rootRow, replies: [] }}
          sent={[]}
          selfName={null}
          timeZone="UTC"
          reply={<textarea data-reply-box="" />}
          onRetryLoad={() => {}}
          onRetrySend={() => {}}
        />,
      ),
    );
    expect(document.querySelectorAll('[data-thread-separator]')).toHaveLength(1);
    expect(document.querySelector('[data-thread-strip]')?.getAttribute('data-thread-strip')).toBe(
      'empty',
    );
  });

  it('"Reply in thread" focuses the reply box', () => {
    act(() =>
      root?.render(
        <CatchUpThreadView
          root={rootRow}
          thread={{ root: rootRow, replies: [] }}
          sent={[]}
          selfName={null}
          timeZone="UTC"
          reply={<textarea data-reply-box="" />}
          onRetryLoad={() => {}}
          onRetrySend={() => {}}
        />,
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('[data-thread-strip-focus]')?.click());
    expect(document.activeElement?.hasAttribute('data-reply-box')).toBe(true);
  });

  it('with replies: "N replies" in ink', () => {
    const reply: CatchUpMessageRow = { ...rootRow, id: 'x1', text: 'A reply' };
    act(() =>
      root?.render(
        <CatchUpThreadView
          root={rootRow}
          thread={{ root: rootRow, replies: [reply, { ...reply, id: 'x2' }] }}
          sent={[]}
          selfName={null}
          timeZone="UTC"
          reply={<textarea />}
          onRetryLoad={() => {}}
          onRetrySend={() => {}}
        />,
      ),
    );
    expect(document.querySelector('[data-thread-strip-label]')?.textContent).toBe('2 replies');
    expect(document.querySelector('[data-thread-strip-focus]')).toBeNull();
  });
});
