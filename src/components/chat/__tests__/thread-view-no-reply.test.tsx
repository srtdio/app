import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { messageMenuItems } from '@/components/chat/MessageActionMenu';
import { RepliesSeparatorRow } from '@/components/chat/ThreadRail';
import { threadListItems } from '@/components/chat/MessageThread';
import { createSwipeReplyController, type SwipeFrame } from '@/lib/chat/swipe-reply';

// Part 4 (8 Nov 2026): inside a thread view there is no Reply (no tile, no
// right swipe); the left swipe (Delete) stays. The main chat keeps both.

const base = {
  canCopy: true,
  onReply: () => {},
  onCopy: () => {},
  canForward: true,
  onForward: () => {},
};

describe('long-press sheet: Reply', () => {
  it('main chat: Reply is the first tile', () => {
    const keys = messageMenuItems(base).map((i) => i.key);
    expect(keys[0]).toBe('reply');
  });

  it('thread view (canReply false): no Reply, the other tiles stay', () => {
    const keys = messageMenuItems({ ...base, canReply: false }).map((i) => i.key);
    expect(keys).not.toContain('reply');
    expect(keys).toContain('forward');
  });
});

let clock = 0;
const touch = (x: number, timeStamp: number) => {
  clock = timeStamp;
  return { clientX: 100 + x, clientY: 0, pointerType: 'touch', pointerId: 1, timeStamp };
};

function swipe(dx: number, takes?: (side: 'left' | 'right') => boolean) {
  const frames: SwipeFrame[] = [];
  const onReply = vi.fn();
  const onLeft = vi.fn();
  const c = createSwipeReplyController({
    direction: 'both',
    onReply,
    onLeft,
    vibrate: () => {},
    raf: (paint) => {
      paint();
      return 1;
    },
    cancelRaf: () => {},
    now: () => clock,
    onFrame: (f) => frames.push(f),
    ...(takes !== undefined ? { takes } : {}),
  });
  c.handlers.onPointerDown(touch(0, 0));
  const step = dx > 0 ? 1 : -1;
  for (let x = step; Math.abs(x) <= Math.abs(dx); x += step) {
    c.handlers.onPointerMove(touch(x, Math.abs(x) * 10));
  }
  c.handlers.onPointerUp({ timeStamp: clock + 1 });
  return { frames, onReply, onLeft };
}

const threadView = (side: 'left' | 'right'): boolean => side !== 'right';

describe('row swipe', () => {
  it('main chat: swipe right replies, swipe left deletes', () => {
    expect(swipe(90).onReply).toHaveBeenCalledTimes(1);
    expect(swipe(-90).onLeft).toHaveBeenCalledTimes(1);
  });

  it('thread view: swipe right does nothing and never moves the row', () => {
    const right = swipe(90, threadView);
    expect(right.onReply).not.toHaveBeenCalled();
    expect(right.frames.every((f) => f.offset === 0)).toBe(true);
  });

  it('thread view: swipe left still deletes', () => {
    expect(swipe(-90, threadView).onLeft).toHaveBeenCalledTimes(1);
  });
});

describe('thread view divider', () => {
  it('a full width row between hairlines with the three root actions', () => {
    const out = renderToStaticMarkup(
      <ul>
        <RepliesSeparatorRow
          label="3 replies"
          through={false}
          actions={{ onTasks: () => {}, onForward: () => {}, onMore: () => {} }}
        />
      </ul>,
    );
    expect(out).toContain('data-thread-replies-divider');
    expect(out).toContain('border-y border-border');
    expect(out).toContain('min-h-11');
    expect(out).toContain('aria-label="Add to Tasks"');
    expect(out).toContain('aria-label="Forward"');
    expect(out).toContain('aria-label="More actions"');
    expect(out).toContain('data-thread-root-action="tasks"');
    expect(out).toContain('data-thread-root-action="forward"');
    expect(out).toContain('data-thread-root-action="more"');
  });

  it('an action the person cannot take is not drawn', () => {
    const out = renderToStaticMarkup(
      <ul>
        <RepliesSeparatorRow label="1 reply" through={false} actions={{ onMore: () => {} }} />
      </ul>,
    );
    expect(out).not.toContain('data-thread-root-action="tasks"');
    expect(out).not.toContain('data-thread-root-action="forward"');
    expect(out).toContain('data-thread-root-action="more"');
  });
});

describe('thread view starts at the top', () => {
  it('main chat: the spacer pins the list to the bottom (mt-auto)', () => {
    const out = renderToStaticMarkup(
      <ul>
        {threadListItems([], false, () => (
          <li />
        ))}
      </ul>,
    );
    expect(out).toContain('mt-auto');
  });

  it('thread view: no bottom-anchored gap', () => {
    const items = threadListItems(
      [],
      false,
      () => <li />,
      undefined,
      'touch',
      false,
      undefined,
      undefined,
      true,
    );
    const out = renderToStaticMarkup(<ul>{items}</ul>);
    expect(out).not.toContain('mt-auto');
    expect(out).toContain('data-thread-top');
  });
});
