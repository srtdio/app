import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  clearBodySelection,
  MessageBubble,
  outOfView,
  SELECT_TEXT_HANDLE_SLOP_PX,
  selectBodyText,
  SELECTING_TEXT_BODY,
  tapEndsTextSelect,
  THREAD_LIST_CLASS,
} from '@/components/chat/MessageThread';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PEER = '0190a0a0-0000-7000-8000-000000000002';
const PROFILES: Map<string, ChatProfile> = new Map([
  [PEER, { userId: PEER, displayName: 'Alice', avatarUrl: null }],
]);

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = '2026-10-05T10:00:00Z';
  return {
    id: 'm1',
    senderUserId: PEER,
    body: 'hello there',
    createdAt,
    time: Date.parse(createdAt),
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

function bubble(m: ThreadMessage, selectingText: boolean): ReactElement {
  return MessageBubble({
    message: m,
    profiles: PROFILES,
    cache,
    presignEnabled: false,
    showTicks: true,
    isGroup: false,
    head: true,
    tail: true,
    timeZone: 'UTC',
    layout: 'touch',
    viewerUserId: 'me',
    mentions: { peerUserId: null, onOpen: noop },
    selectingText,
    swipe: {},
    press: {
      handlers: {
        onPointerDown: noop,
        onPointerMove: noop,
        onPointerUp: noop,
        onPointerCancel: noop,
      },
      onContextMenu: noop,
      consumeClick: () => false,
      onKeyOpen: noop,
      onMore: noop,
      onReact: noop,
      coarse: true,
    },
  });
}

function walk(node: ReactNode, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node as ReactElement<Record<string, unknown>>);
  walk((node.props as { children?: ReactNode }).children, visit);
}

function all(root: ReactElement, attr: string): ReactElement<Record<string, unknown>>[] {
  const hits: ReactElement<Record<string, unknown>>[] = [];
  walk(root, (el) => {
    if (el.props[attr] !== undefined) hits.push(el);
  });
  return hits;
}

function classes(el: ReactElement<Record<string, unknown>> | undefined): string[] {
  return String(el?.props.className ?? '').split(' ');
}

const SELECTABLE = SELECTING_TEXT_BODY.split(' ');
const GUARD = NO_TOUCH_SELECT.split(' ');

describe('Select text: only the active body is selectable', () => {
  it('the active bubble body takes select-text and the native callout', () => {
    const row = bubble(message(), true);
    const [body] = all(row, 'data-msg-body');
    expect(classes(body)).toEqual(expect.arrayContaining(SELECTABLE));
    expect(body?.props['data-selecting-text']).toBe('');
  });

  it('list, row and bubble keep NO_TOUCH_SELECT, active or not', () => {
    for (const cls of GUARD) expect(THREAD_LIST_CLASS.split(' ')).toContain(cls);
    for (const active of [true, false]) {
      const row = bubble(message(), active);
      expect(classes(row)).toEqual(expect.arrayContaining(GUARD));
      expect(classes(all(row, 'data-bubble')[0])).toEqual(expect.arrayContaining(GUARD));
    }
  });

  it('every other bubble body stays unselectable', () => {
    const [body] = all(bubble(message(), false), 'data-msg-body');
    for (const cls of SELECTABLE) expect(classes(body)).not.toContain(cls);
    expect(body?.props['data-selecting-text']).toBeUndefined();
  });

  it('the reply quote, forwarded label and meta are not the body (stay guarded)', () => {
    const row = bubble(
      message({
        forwarded: true,
        reply: { id: 'q1', preview: 'quoted', authorUserId: PEER } as ThreadMessage['reply'],
      }),
      true,
    );
    const selectable = all(row, 'className').filter((el) => classes(el).includes('select-text'));
    expect(selectable.map((el) => el.props['data-msg-body'])).toEqual(['']);
  });

  it('while selecting: no hold, menu, chevron, smiley, swipe or contextmenu on that bubble', () => {
    const row = bubble(message(), true) as ReactElement<Record<string, unknown>>;
    expect(row.props.onContextMenu).toBeUndefined();
    const [b] = all(row, 'data-bubble');
    expect(b?.props.onPointerDown).toBeUndefined();
    expect(b?.props.onContextMenu).toBeUndefined();
    expect(b?.props['data-swipe-reply']).toBeUndefined();
    expect(all(row, 'data-more')).toHaveLength(0);
    expect(all(row, 'data-react')).toHaveLength(0);
    const preventDefault = vi.fn();
    (b?.props.onKeyDown as (e: object) => void)({
      key: 'Enter',
      shiftKey: false,
      target: 1,
      currentTarget: 1,
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('not selecting: the bubble keeps its hold, menu and swipe wiring', () => {
    const row = bubble(message(), false) as ReactElement<Record<string, unknown>>;
    const [b] = all(row, 'data-bubble');
    expect(b?.props.onPointerDown).toBeDefined();
    expect(b?.props['data-swipe-reply']).toBe('');
  });

  it('mentions read as plain "@Name" text while selecting (no button)', () => {
    const m = message({ body: `hi @[${PEER}] there` });
    const active = bubble(m, true);
    const mention = all(active, 'data-mention')[0];
    expect(mention?.type).toBe('span');
    expect(mention?.props.children).toBe('@Alice');
  });
});

/** A minimal DOM for the selection helpers (the unit run has no DOM). */
function fakeDom(opts: { spacer: boolean }) {
  const calls: string[] = [];
  const selection = {
    rangeCount: 0,
    anchorNode: null as unknown,
    removeAllRanges: () => {
      calls.push('removeAllRanges');
      selection.rangeCount = 0;
    },
    addRange: (range: unknown) => {
      calls.push('addRange');
      selection.rangeCount = 1;
      void range;
    },
  };
  const spacer = { id: 'spacer' };
  const range = {
    selectNodeContents: (node: unknown) =>
      calls.push(`selectNodeContents:${String(node === body)}`),
    setEndBefore: (node: unknown) => calls.push(`setEndBefore:${String(node === spacer)}`),
  };
  const doc = { getSelection: () => selection, createRange: () => range };
  const body = {
    ownerDocument: doc,
    querySelector: (sel: string) =>
      sel.includes('data-meta-spacer') && opts.spacer ? spacer : null,
    contains: (node: unknown) => node === 'inside',
  };
  return { body: body as unknown as Element, selection, calls };
}

describe('selectBodyText and clearBodySelection', () => {
  it('selects the whole body, ending before the invisible meta spacer', () => {
    const { body, calls } = fakeDom({ spacer: true });
    expect(selectBodyText(body)).toBe(true);
    expect(calls).toEqual([
      'selectNodeContents:true',
      'setEndBefore:true',
      'removeAllRanges',
      'addRange',
    ]);
  });

  it('a body with no spacer is selected whole', () => {
    const { body, calls } = fakeDom({ spacer: false });
    selectBodyText(body);
    expect(calls).not.toContain('setEndBefore:true');
  });

  it('clears only a selection inside the body', () => {
    const inside = fakeDom({ spacer: false });
    inside.selection.rangeCount = 1;
    inside.selection.anchorNode = 'inside';
    clearBodySelection(inside.body);
    expect(inside.calls).toEqual(['removeAllRanges']);
    const outside = fakeDom({ spacer: false });
    outside.selection.rangeCount = 1;
    outside.selection.anchorNode = { isConnected: true };
    clearBodySelection(outside.body);
    expect(outside.calls).toEqual([]);
  });

  it('outOfView: fully above or below the list only', () => {
    const list = { top: 100, bottom: 700 };
    expect(outOfView({ top: 40, bottom: 100 }, list)).toBe(true);
    expect(outOfView({ top: 700, bottom: 760 }, list)).toBe(true);
    expect(outOfView({ top: 90, bottom: 120 }, list)).toBe(false);
  });
});

describe('tapEndsTextSelect: only a real tap away from the text ends Select', () => {
  const body = { top: 200, bottom: 260, left: 40, right: 300 };
  const at = (x: number, y: number) => ({ x, y });

  it('a tap far from the body ends it', () => {
    expect(tapEndsTextSelect({ down: at(200, 600), up: at(202, 601), body })).toBe(true);
    expect(tapEndsTextSelect({ down: at(200, 20), up: at(200, 20), body })).toBe(true);
  });

  it('a handle grabbed just outside the text (padding, knob below the last line) keeps it', () => {
    const slop = SELECT_TEXT_HANDLE_SLOP_PX;
    expect(tapEndsTextSelect({ down: at(300 + slop, 260), up: at(300 + slop, 260), body })).toBe(
      false,
    );
    expect(tapEndsTextSelect({ down: at(120, 260 + slop), up: at(120, 260 + slop), body })).toBe(
      false,
    );
    expect(
      tapEndsTextSelect({ down: at(40 - slop, 200 - slop), up: at(40 - slop, 200 - slop), body }),
    ).toBe(false);
  });

  it('dragging (a handle, or scrolling the list) never ends it, wherever it starts', () => {
    expect(tapEndsTextSelect({ down: at(120, 275), up: at(160, 330), body })).toBe(false);
    expect(tapEndsTextSelect({ down: at(200, 600), up: at(200, 450), body })).toBe(false);
  });

  it('a tap on the text itself keeps it', () => {
    expect(tapEndsTextSelect({ down: at(150, 230), up: at(150, 230), body })).toBe(false);
  });
});
