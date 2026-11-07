// Chat rows swipe both ways (touch and pen): right = Reply, left = the long-
// press menu's Delete (its rule, its sheet). The whole row is the grab area, on
// own rows exactly as on others'. MessageBubble is pure, so the row's wiring is
// inspected on its returned element; the row's controller glue is driven with
// the same pieces MessageRow composes (createSwipeReplyController with
// direction 'both', rowSwipeCanTrigger, messageDeleteOffer), and the menu
// Delete's own path (deleteChoices) decides the sheet the swipe opens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { DELETE_WINDOW_MS } from '@/components/chat/MessageActionMenu';
import {
  messageAgeMs,
  MessageBubble,
  messageDeleteOffer,
  paintRowSwipe,
  rowSwipeCanTrigger,
  SWIPE_ROW_TOUCH,
  SwipeDeleteIcon,
  SwipeReplyIcon,
  THREAD_LIST_CLASS,
  type BubbleSwipe,
} from '@/components/chat/MessageThread';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import { deleteChoices } from '@/lib/chat/delete-flow';
import { createSwipeReplyController, SWIPE_REST, type SwipeFrame } from '@/lib/chat/swipe-reply';
import type { ThreadMessage } from '@/lib/chat/thread';

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);

const CREATED_AT = '2026-09-22T18:45:00.000Z';
const CREATED_MS = Date.parse(CREATED_AT);
/** Five minutes after the send: inside the delete window. */
const IN_WINDOW = CREATED_MS + 5 * 60_000;
/** Past the window: Delete for everyone is gone. */
const PAST_WINDOW = CREATED_MS + DELETE_WINDOW_MS + 60_000;

function makeMessage(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: 'hello there',
    createdAt: CREATED_AT,
    time: CREATED_MS,
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

const noop = (): void => {};

function walk(node: ReactNode, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node as ReactElement<Record<string, unknown>>);
  walk((node.props as { children?: ReactNode }).children, visit);
}

function find(root: ReactNode, key: string): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  walk(root, (el) => {
    if (el.props[key] !== undefined) out.push(el);
  });
  return out;
}

const swipeHandlers = {
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
};
const bubbleHandlers = {
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerUp: vi.fn(),
  onPointerCancel: vi.fn(),
};

function render(
  message: ThreadMessage,
  opts: { selecting?: boolean; selectingText?: boolean; consumeClick?: () => boolean } = {},
): ReactElement<Record<string, unknown>> {
  const swipe: BubbleSwipe = {
    handlers: swipeHandlers,
    consumeClick: opts.consumeClick ?? (() => false),
  };
  return MessageBubble({
    message,
    profiles: PROFILES,
    cache,
    presignEnabled: false,
    showTicks: true,
    isGroup: false,
    head: true,
    tail: true,
    timeZone: 'UTC',
    layout: 'touch',
    onBadgeClick: noop,
    press: {
      handlers: bubbleHandlers,
      onContextMenu: noop,
      consumeClick: () => false,
      onKeyOpen: noop,
      coarse: true,
    },
    swipe,
    ...(opts.selectingText === true ? { selectingText: true } : {}),
    ...(opts.selecting === true
      ? { selection: { role: 'selectable' as const, checked: false, onToggle: noop } }
      : {}),
  }) as ReactElement<Record<string, unknown>>;
}

const img = (n: number) => ({ assetId: `s-${n}`, name: `s${n}.png`, mime: 'image/png' });
const KINDS: Record<string, Partial<ThreadMessage>> = {
  text: {},
  album: { body: '', attachments: [img(1), img(2)] },
  photo: { body: '', attachments: [img(1)] },
  file: { body: '', attachments: [{ assetId: 'f', name: 'a.pdf', mime: 'application/pdf' }] },
  voice: { body: '', attachments: [{ assetId: 'v', name: 'v.webm', mime: 'audio/webm' }] },
  link: { body: 'see https://example.com/page' },
  post: { body: '', sharedPostIds: ['p1'] },
  plan: { body: '', sharedPlanIds: ['plan-1'] },
  idea: { body: '', sharedPlanItemIds: ['idea-1'] },
  forwarded: { forwarded: true },
};

describe('the whole row is the grab area, own rows as freely as others', () => {
  for (const [kind, over] of Object.entries(KINDS)) {
    for (const mine of [false, true]) {
      it(`${mine ? 'own' : 'peer'} ${kind}: the <li> carries the swipe, the bubble keeps the hold`, () => {
        const root = render(makeMessage({ ...over, mine }));
        // The row itself (full width), not only the bubble.
        expect(root.type).toBe('li');
        expect(root.props['data-swipe-row']).toBe('');
        expect(root.props.onPointerDown).toBe(swipeHandlers.onPointerDown);
        expect(root.props.onPointerMove).toBe(swipeHandlers.onPointerMove);
        expect(root.props.onPointerUp).toBe(swipeHandlers.onPointerUp);
        expect(root.props.onPointerCancel).toBe(swipeHandlers.onPointerCancel);
        // Vertical pans stay the list's on the whole row.
        for (const cls of SWIPE_ROW_TOUCH.split(' ')) {
          expect(String(root.props.className).split(' ')).toContain(cls);
        }
        // The bubble keeps only the long-press.
        const [bubble] = find(root, 'data-bubble');
        expect(bubble?.props.onPointerDown).toBe(bubbleHandlers.onPointerDown);
        // One reply arrow and one bin, both at rest.
        let replies = 0;
        let bins = 0;
        walk(root, (el) => {
          if (el.type === SwipeReplyIcon) replies += 1;
          if (el.type === SwipeDeleteIcon) bins += 1;
        });
        expect(replies).toBe(1);
        expect(bins).toBe(1);
      });
    }
  }

  it('own and peer rows get the identical grab wiring (no own-only clamp or class)', () => {
    const own = render(makeMessage({ mine: true }));
    const peer = render(makeMessage({ mine: false }));
    const swipeProps = (el: ReactElement<Record<string, unknown>>) => ({
      down: el.props.onPointerDown,
      move: el.props.onPointerMove,
      up: el.props.onPointerUp,
      row: el.props['data-swipe-row'],
      touch: SWIPE_ROW_TOUCH.split(' ').every((c) =>
        String(el.props.className).split(' ').includes(c),
      ),
    });
    expect(swipeProps(own)).toEqual(swipeProps(peer));
  });

  it('sending and failed rows never swipe', () => {
    for (const state of ['sending', 'failed'] as const) {
      const root = render(makeMessage({ mine: true, state }));
      expect(root.props.onPointerDown).toBeUndefined();
      expect(root.props['data-swipe-row']).toBeUndefined();
      expect(String(root.props.className)).not.toContain('touch-pan-y');
    }
  });

  it('selection mode and Select text turn the row swipe off', () => {
    for (const opts of [{ selecting: true }, { selectingText: true }]) {
      const root = render(makeMessage({ mine: true }), opts);
      expect(root.props.onPointerDown).toBeUndefined();
      expect(root.props['data-swipe-row']).toBeUndefined();
      let bins = 0;
      walk(root, (el) => {
        if (el.type === SwipeDeleteIcon) bins += 1;
      });
      expect(bins).toBe(0);
    }
  });

  it('the click that trails a swipe is swallowed on the row (pointer capture sends it there)', () => {
    const consume = vi.fn(() => true);
    const root = render(makeMessage({ mine: true }), { consumeClick: consume });
    const onClickCapture = root.props.onClickCapture as (e: unknown) => void;
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    onClickCapture(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    const tap = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    consume.mockReturnValue(false);
    onClickCapture(tap);
    expect(tap.preventDefault).not.toHaveBeenCalled();
  });

  it('a tombstone row takes the swipe too (a rubber band, nothing fires)', () => {
    const root = render(makeMessage({ mine: true, body: '', deleted: true }));
    expect(root.props['data-deleted']).toBe('');
    expect(root.props.onPointerDown).toBe(swipeHandlers.onPointerDown);
    expect(rowSwipeCanTrigger('left', makeMessage({ deleted: true }), () => true)).toBe(false);
    expect(rowSwipeCanTrigger('right', makeMessage({ deleted: true }), () => true)).toBe(false);
    // No icons on a tombstone.
    let icons = 0;
    walk(root, (el) => {
      if (el.type === SwipeReplyIcon || el.type === SwipeDeleteIcon) icons += 1;
    });
    expect(icons).toBe(0);
  });

  it('the thread list never becomes a sideways scroller under an own swipe', () => {
    const cls = THREAD_LIST_CLASS.split(' ');
    expect(cls).toContain('overflow-y-auto');
    expect(cls).toContain('overflow-x-hidden');
  });

  it('the bin is a 32px token circle: bad ink at rest, accent when armed, no transition', () => {
    const icon = SwipeDeleteIcon({});
    const cls = String((icon.props as { className?: string }).className);
    expect(cls).toContain('h-8 w-8');
    expect(cls).toContain('right-0');
    expect(cls).toContain('bg-panel-3 text-bad');
    expect(cls).toContain('data-[armed]:bg-accent data-[armed]:text-accent-fg');
    expect(cls).toContain('scale-0');
    expect(cls).toContain('opacity-0');
    expect(cls).not.toContain('transition');
    // Assembled so this file carries no banned literal (chat-tokens.test.ts).
    const hex = new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}`, 'i');
    expect(cls).not.toMatch(hex);
    expect(cls).not.toContain('text-white');
    expect(cls).not.toContain(['dark', ':'].join(''));
  });
});

describe('messageDeleteOffer: the menu Delete rule the left swipe reads', () => {
  const base = { notes: false, canDeleteForMe: true };

  it('own message in the window: Delete for everyone (and Delete for me)', () => {
    const offer = messageDeleteOffer({
      ...base,
      message: makeMessage({ mine: true }),
      nowMs: IN_WINDOW,
    });
    expect(offer).toEqual({ canDelete: true, forMeOnly: false });
  });

  it('own message past the window: Delete for me only', () => {
    const offer = messageDeleteOffer({
      ...base,
      message: makeMessage({ mine: true }),
      nowMs: PAST_WINDOW,
    });
    expect(offer).toEqual({ canDelete: true, forMeOnly: true });
  });

  it("someone else's message: Delete for me only", () => {
    const offer = messageDeleteOffer({ ...base, message: makeMessage(), nowMs: IN_WINDOW });
    expect(offer).toEqual({ canDelete: true, forMeOnly: true });
  });

  it('marked (no Delete in the menu): a tombstone, a chat without Delete for me', () => {
    expect(
      messageDeleteOffer({ ...base, message: makeMessage({ deleted: true }), nowMs: IN_WINDOW })
        .canDelete,
    ).toBe(false);
    expect(
      messageDeleteOffer({
        notes: false,
        canDeleteForMe: false,
        message: makeMessage(),
        nowMs: IN_WINDOW,
      }).canDelete,
    ).toBe(false);
  });

  it('Personal notes: own notes delete at any age, never "for me"', () => {
    const offer = messageDeleteOffer({
      notes: true,
      canDeleteForMe: false,
      message: makeMessage({ mine: true }),
      nowMs: PAST_WINDOW,
    });
    expect(offer).toEqual({ canDelete: true, forMeOnly: false });
  });
});

/**
 * The row's controller as MessageRow builds it: direction 'both', right =
 * the reply, left = the thread's onDeleteMessage (the menu Delete's own call),
 * canTrigger = rowSwipeCanTrigger over the menu's rule. Returns what fired.
 */
function rowController(message: ThreadMessage, nowMs: number, canDeleteForMe = true) {
  const replied: string[] = [];
  const deleted: Array<{ id: string; nowMs: number }> = [];
  const frames: SwipeFrame[] = [];
  const canDelete = (m: ThreadMessage): boolean =>
    messageDeleteOffer({ message: m, nowMs, notes: false, canDeleteForMe }).canDelete;
  const c = createSwipeReplyController({
    direction: 'both',
    onReply: () => replied.push(message.id),
    onLeft: () => {
      if (canDelete(message)) deleted.push({ id: message.id, nowMs });
    },
    canTrigger: (side) => rowSwipeCanTrigger(side, message, canDelete),
    onFrame: (f) => frames.push(f),
    vibrate: noop,
    raf: (paint) => {
      paint();
      return 1;
    },
    cancelRaf: noop,
    now: () => 0,
    enabled: () => message.state === 'sent',
  });
  const swipe = (dx: number): void => {
    const at = (x: number, t: number) => ({
      clientX: 200 + x,
      clientY: 300,
      pointerType: 'touch',
      pointerId: 1,
      timeStamp: t,
    });
    c.handlers.onPointerDown(at(0, 0));
    const step = dx < 0 ? -1 : 1;
    for (let i = 1; i <= Math.abs(dx); i += 1) c.handlers.onPointerMove(at(i * step, i * 10));
    c.handlers.onPointerUp({ timeStamp: Math.abs(dx) * 10 + 500 });
  };
  return { swipe, replied, deleted, frames };
}

/** The sheet the thread's onDeleteMessage opens for one message (MessageThread's own rule). */
function sheetFor(message: ThreadMessage, nowMs: number): { everyone: boolean; forMe: boolean } {
  const choices = deleteChoices({
    mine: message.mine && message.state === 'sent' && message.deleted !== true,
    ageMs: messageAgeMs(message, nowMs),
    notes: false,
    failed: false,
  });
  return {
    everyone: choices.kind === 'sheet' && choices.everyone,
    forMe: choices.kind === 'sheet',
  };
}

describe('row swipe: right = Reply, left = the menu Delete', () => {
  it('own message, swipe left inside the window: the Delete sheet with for everyone and Delete for me', () => {
    const m = makeMessage({ id: 'own-new', mine: true });
    const row = rowController(m, IN_WINDOW);
    row.swipe(-80);
    expect(row.deleted).toEqual([{ id: 'own-new', nowMs: IN_WINDOW }]);
    expect(row.replied).toEqual([]);
    expect(sheetFor(m, IN_WINDOW)).toEqual({ everyone: true, forMe: true });
    // The bin showed on the left side while it slid.
    expect(row.frames.some((f) => f.side === 'left' && f.armed)).toBe(true);
  });

  it('own message past the window: Delete for me only', () => {
    const m = makeMessage({ id: 'own-old', mine: true });
    const row = rowController(m, PAST_WINDOW);
    row.swipe(-80);
    expect(row.deleted).toEqual([{ id: 'own-old', nowMs: PAST_WINDOW }]);
    expect(sheetFor(m, PAST_WINDOW)).toEqual({ everyone: false, forMe: true });
  });

  it("someone else's message, swipe left: Delete for me only", () => {
    const m = makeMessage({ id: 'peer' });
    const row = rowController(m, IN_WINDOW);
    row.swipe(-80);
    expect(row.deleted).toEqual([{ id: 'peer', nowMs: IN_WINDOW }]);
    expect(sheetFor(m, IN_WINDOW)).toEqual({ everyone: false, forMe: true });
  });

  it('marked (the menu has no Delete): a left swipe rubber-bands and opens nothing', () => {
    const m = makeMessage({ id: 'peer-no-delete' });
    const row = rowController(m, IN_WINDOW, false);
    row.swipe(-120);
    expect(row.deleted).toEqual([]);
    expect(row.frames.every((f) => !f.armed && f.offset <= 32)).toBe(true);
    const tomb = makeMessage({ id: 'tomb', deleted: true, body: '' });
    const t = rowController(tomb, IN_WINDOW);
    t.swipe(-120);
    t.swipe(120);
    expect(t.deleted).toEqual([]);
    expect(t.replied).toEqual([]);
  });

  it('swipe right replies on own and others alike', () => {
    for (const mine of [true, false]) {
      const m = makeMessage({ id: mine ? 'own' : 'peer', mine });
      const row = rowController(m, PAST_WINDOW);
      row.swipe(80);
      expect(row.replied).toEqual([m.id]);
      expect(row.deleted).toEqual([]);
    }
  });

  it('own and peer rows swipe the same distance for the same finger travel', () => {
    const own = rowController(makeMessage({ mine: true }), IN_WINDOW);
    const peer = rowController(makeMessage({ mine: false }), IN_WINDOW);
    own.swipe(100);
    peer.swipe(100);
    expect(own.frames.map((f) => f.offset)).toEqual(peer.frames.map((f) => f.offset));
  });
});

describe('paintRowSwipe', () => {
  function fakeEl() {
    const attrs = new Set<string>();
    return {
      style: {} as Record<string, string>,
      toggleAttribute: (name: string, on?: boolean) => {
        if (on === true) attrs.add(name);
        else attrs.delete(name);
      },
      armed: () => attrs.has('data-armed'),
    };
  }
  const frame = (over: Partial<SwipeFrame>): SwipeFrame => ({
    ...SWIPE_REST,
    dragging: true,
    ...over,
  });

  it('left: the bubble slides left, the bin follows, the reply arrow rests', () => {
    const bubble = fakeEl();
    const reply = fakeEl();
    const bin = fakeEl();
    paintRowSwipe(
      bubble as unknown as HTMLElement,
      reply as unknown as HTMLElement,
      bin as unknown as HTMLElement,
      frame({ offset: 64, progress: 1, armed: true, side: 'left' }),
      true,
    );
    expect(bubble.style.transform).toBe('translate3d(-64px,0,0)');
    expect(bin.style.transform).toBe('scale(1)');
    expect(bin.armed()).toBe(true);
    expect(reply.style.transform).toBe('');
    expect(reply.armed()).toBe(false);
  });

  it('right: the bubble slides right, the reply arrow follows, the bin rests', () => {
    const bubble = fakeEl();
    const reply = fakeEl();
    const bin = fakeEl();
    paintRowSwipe(
      bubble as unknown as HTMLElement,
      reply as unknown as HTMLElement,
      bin as unknown as HTMLElement,
      frame({ offset: 32, progress: 0.5, side: 'right' }),
      true,
    );
    expect(bubble.style.transform).toBe('translate3d(32px,0,0)');
    expect(reply.style.opacity).toBe('0.5');
    expect(bin.style.transform).toBe('');
  });

  it('a way that cannot fire slides the bubble but shows no icon', () => {
    const bubble = fakeEl();
    const reply = fakeEl();
    const bin = fakeEl();
    paintRowSwipe(
      bubble as unknown as HTMLElement,
      reply as unknown as HTMLElement,
      bin as unknown as HTMLElement,
      frame({ offset: 20, progress: 20 / 64, side: 'left' }),
      false,
    );
    expect(bubble.style.transform).toBe('translate3d(-20px,0,0)');
    expect(bin.style.transform).toBe('');
    expect(bin.style.opacity).toBe('');
    expect(reply.style.transform).toBe('');
  });
});

describe('MessageThread source: the row wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./MessageThread.tsx', import.meta.url)), 'utf8');

  it("rows swipe both ways and the left swipe calls the menu Delete's onDeleteMessage", () => {
    expect(src).toContain("direction: 'both'");
    expect(src).toContain('onLeft: () => latest.current.onSwipeDelete?.(latest.current.message)');
    expect(src).toMatch(
      /onSwipeDelete = useStableCallback\([\s\S]*?props\.onDeleteMessage\?\.\(m, serverNow\(\)\)/,
    );
    // The menu's Delete and the swipe read one rule.
    expect(src).toMatch(/const menuDelete =[\s\S]*?messageDeleteOffer\(/);
    expect(src).toMatch(/canSwipeDelete = useStableCallback\([\s\S]*?messageDeleteOffer\(/);
  });

  it('the swipe captures the pointer on the row, not the bubble', () => {
    expect(src).toContain('const scope = rowRef.current ?? bubbleRef.current;');
    expect(src).toContain('scope?.setPointerCapture(pointerId);');
  });
});
