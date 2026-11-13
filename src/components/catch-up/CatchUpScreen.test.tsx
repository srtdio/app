// @vitest-environment jsdom
// Catch up's screen (9 Nov 2026): one card per item; "{n} left"; Keep unread
// writes nothing; Mark as read (Main, ink, never green) writes every entry of
// the item and moves on; Undo puts it back; a gone card is skipped silently;
// a failed read shows the error state with Retry; the name row opens the
// menu; Back closes.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useCoarsePointer: () => true,
}));
const writes = vi.hoisted(() => ({
  markCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  undoCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  markAllCatchUpRead: vi.fn(async () => ({ ok: true as const })),
  markCatchUpSkipped: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('@/lib/catch-up/writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catch-up/writes')>()),
  ...writes,
}));
const reads = vi.hoisted(() => ({
  readCatchUpBodies: vi.fn(),
}));
vi.mock('@/lib/catch-up/body', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catch-up/body')>()),
  readCatchUpBodies: reads.readCatchUpBodies,
}));
// The reply box is the shared writing box (its own tests); a stub here.
vi.mock('@/components/catch-up/CatchUpReply', () => ({
  CatchUpReply: (props: { hint: string; onFocusChange: (focused: boolean) => void }) => (
    <form data-catch-up-reply="" aria-label={props.hint}>
      <textarea data-catch-up-reply-input="" onFocus={() => props.onFocusChange(true)} />
    </form>
  ),
}));

import { CatchUpScreen, boxDraft, cardThreadTarget } from '@/components/catch-up/CatchUpScreen';
import { snapToRowTop } from '@/components/catch-up/CatchUpCard';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';
import type { CatchUpBody, CatchUpBodyResult, CatchUpMessageRow } from '@/lib/catch-up/body';
import { EMPTY_DRAFT } from '@/lib/catch-up/types';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';
import { endLine, leftLabel } from '@/lib/catch-up/copy';
import { CATCH_UP_UNDO_MS } from '@/lib/catch-up/use-catch-up';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(id: string): CatchUpItem {
  return cardOf(
    entry(
      { id: `${id}-1`, entity_id: id, payload: { comment_id: `${id}-c` } },
      { title: `Post ${id}` },
    ),
    entry({
      id: `${id}-2`,
      entity_id: id,
      event_type: 'post_deleted',
      created_at: '2026-11-08T09:00:00.000Z',
    }),
  );
}

function bodyFor(title: string): CatchUpBodyResult {
  return {
    title,
    context: null,
    rows: [
      {
        kind: 'message',
        id: `${title}-c`,
        author: { id: 'u1', name: 'Maya', avatarUrl: null },
        createdAt: '2026-11-08T10:00:00Z',
        text: 'Looks good',
        replyCount: 2,
      },
    ],
    firstNewId: `${title}-c`,
    hasOlder: false,
    threads: true,
    latestReplyId: null,
  };
}

let root: Root | null = null;
let host: HTMLDivElement;

function render(queue: CatchUpItem[]): {
  onClose: ReturnType<typeof vi.fn>;
  onRead: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onRead = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CatchUpScreen
        queue={queue}
        workspaceId="w1"
        currentUserId="u-me"
        selfName={null}
        onClose={onClose}
        onRead={onRead}
        onUnread={vi.fn()}
        onAllRead={vi.fn()}
        onOpenPlace={vi.fn()}
      />,
    ),
  );
  return { onClose, onRead };
}

function click(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  act(() => el.click());
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.values(writes).forEach((fn) => fn.mockClear());
  reads.readCatchUpBodies.mockReset();
  reads.readCatchUpBodies.mockImplementation(
    async (_client: unknown, input: { items: CatchUpItem[] }) =>
      new Map(input.items.map((i) => [i.key, bodyFor(i.entityId)])),
  );
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('catch-up end screen', () => {
  it('says "1 update" singular and "N updates" plural', () => {
    expect(endLine(1)).toBe('You went through 1 update.');
    expect(endLine(4)).toBe('You went through 4 updates.');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onDone = vi.fn();
    act(() => root?.render(<CatchUpEnd wentThrough={1} keptUnread={0} onDone={onDone} />));
    expect(host.textContent).toContain("Everything's sorted.");
    click('[data-catch-up-done]');
    expect(onDone).toHaveBeenCalledTimes(1);
    // The check circle and Done are ink (text-fg / bg-accent: black in light,
    // white in dark), never green.
    const check = host.querySelector('[data-catch-up-end-check]');
    expect(check?.className).toContain('text-fg');
    expect(check?.querySelector('svg')).not.toBeNull();
    const done = host.querySelector('[data-catch-up-done]');
    expect(done?.className).toContain('bg-accent');
    for (const el of [check, done]) {
      expect(el?.className ?? '').not.toMatch(/\b(text|bg)-(good|success|green)/);
    }
  });
});

describe('catch-up screen', () => {
  it('end screen: "See you later." after one Keep unread', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-keep]');
    await settle();
    click('[data-catch-up-read]');
    await settle();
    const end = document.querySelector('[data-catch-up-end]');
    expect(end?.textContent).toContain('See you later.');
    expect(end?.querySelector('[data-catch-up-end-line]')?.textContent).toBe(
      '1 update kept unread.',
    );
    expect(end?.textContent).not.toContain("Everything's sorted.");
  });

  it('end screen: "Everything\'s sorted." when all read', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-read]');
    await settle();
    click('[data-catch-up-read]');
    await settle();
    const end = document.querySelector('[data-catch-up-end]');
    expect(end?.textContent).toContain("Everything's sorted.");
    expect(end?.querySelector('[data-catch-up-end-line]')?.textContent).toBe(endLine(2));
  });

  it('one card per item: counts what is left, keeps unread without a write', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(2));
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'post:p1',
    );
    click('[data-catch-up-keep]');
    expect(writes.markCatchUpRead).not.toHaveBeenCalled();
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(1));
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'post:p2',
    );
  });

  it('only the current and next card are read, in one batched call', async () => {
    render([card('p1'), card('p2'), card('p3')]);
    await settle();
    expect(reads.readCatchUpBodies).toHaveBeenCalledTimes(1);
    const input = reads.readCatchUpBodies.mock.calls[0]?.[1] as { items: CatchUpItem[] };
    expect(input.items.map((i) => i.key)).toEqual(['post:p1', 'post:p2']);
  });

  it('Mark as read is the ink Main (never green) and marks every entry of the item read', async () => {
    const { onRead } = render([card('p1')]);
    await settle();
    const read = document.querySelector('[data-catch-up-read]');
    expect(read?.className).toContain('bg-accent');
    expect(read?.className).not.toMatch(/\bbg-good/);
    click('[data-catch-up-read]');
    expect(writes.markCatchUpRead).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledWith(['p1-1', 'p1-2']);
    await settle();
    expect(document.querySelector('[data-catch-up-end]')).not.toBeNull();
  });

  it('Undo brings the card back and restores every entry', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-read]');
    await settle();
    click('[data-catch-up-undo]');
    expect(writes.undoCatchUpRead).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'post:p1',
    );
  });

  it('a gone card is skipped silently (marked read, never shown empty, no Undo)', async () => {
    reads.readCatchUpBodies.mockImplementation(
      async (_client: unknown, input: { items: CatchUpItem[] }) =>
        new Map(
          input.items.map((i) => [i.key, i.entityId === 'p1' ? 'skip' : bodyFor(i.entityId)]),
        ),
    );
    render([card('p1'), card('p2')]);
    await settle();
    expect(writes.markCatchUpSkipped).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'post:p2',
    );
    expect(document.querySelector('[data-catch-up-undo]')?.className).toContain('invisible');
  });

  it('a failed read shows the error state; the reply box and buttons stay', async () => {
    reads.readCatchUpBodies.mockImplementation(
      async (_client: unknown, input: { items: CatchUpItem[] }) =>
        new Map(input.items.map((i) => [i.key, 'error'])),
    );
    render([card('p1')]);
    await settle();
    expect(document.querySelector('[data-catch-up-error]')?.textContent).toContain(
      "Couldn't load this card.",
    );
    expect(document.querySelector('[data-catch-up-reply]')).not.toBeNull();
    expect(document.querySelector('[data-catch-up-read]')).not.toBeNull();
  });

  it('the name row shows the title with a chevron, no Mute or Star', async () => {
    render([card('p1')]);
    await settle();
    const row = document.querySelector('[data-catch-up-name-row]');
    expect(row?.textContent).toContain('p1');
    expect(document.body.textContent).not.toMatch(/Mute|Star/);
  });

  it('Back closes', async () => {
    const { onClose } = render([card('p1')]);
    await settle();
    click('[data-catch-up-back]');
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function undoState(): { visible: boolean; focusable: boolean; disabled: boolean } {
  const undo = document.querySelector<HTMLButtonElement>('[data-catch-up-undo]');
  if (undo === null) throw new Error('missing undo');
  return {
    visible:
      !undo.className.split(/\s+/).includes('invisible') &&
      undo.getAttribute('aria-hidden') !== 'true',
    focusable: undo.tabIndex >= 0,
    disabled: undo.disabled,
  };
}

describe('catch-up Undo visibility (addendum B)', () => {
  it('fresh open: hidden, not focusable, disabled (the slot stays so the count is centred)', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    expect(undoState()).toEqual({ visible: false, focusable: false, disabled: true });
    expect(document.querySelector('[data-catch-up-undo]')).not.toBeNull();
  });

  it('after one decision: visible; after undoing the only decision: hidden again', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-keep]');
    expect(undoState()).toEqual({ visible: true, focusable: true, disabled: false });
    click('[data-catch-up-undo]');
    expect(undoState()).toEqual({ visible: false, focusable: false, disabled: true });
  });

  it('after the undo window runs out: hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-keep]');
    expect(undoState().visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CATCH_UP_UNDO_MS + 1);
    });
    expect(undoState()).toEqual({ visible: false, focusable: false, disabled: true });
  });

  it('hidden while typing', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    click('[data-catch-up-keep]');
    const input = document.querySelector<HTMLTextAreaElement>('[data-catch-up-reply-input]');
    act(() => input?.focus());
    expect(undoState().visible).toBe(false);
  });
});

describe('catch-up ink, never green (addendum C)', () => {
  it('typing: Hide keyboard (keyboard glyph, 48 round) and the ink tick (bg-accent)', async () => {
    render([card('p1')]);
    await settle();
    const input = document.querySelector<HTMLTextAreaElement>('[data-catch-up-reply-input]');
    act(() => input?.focus());
    const hide = document.querySelector<HTMLButtonElement>('[data-catch-up-hide-keyboard]');
    expect(hide?.getAttribute('aria-label')).toBe('Hide keyboard');
    expect(hide?.className).toContain('h-12 w-12');
    expect(hide?.className).toContain('rounded-full');
    expect(hide?.querySelector('svg rect')).not.toBeNull();
    const tick = document.querySelector<HTMLButtonElement>('[data-catch-up-typing-read]');
    expect(tick?.className).toContain('bg-accent');
    expect(tick?.className).toContain('h-12 w-12');
    expect(tick?.className).not.toMatch(/\b(bg|text)-(good|success|green)/);
  });

  it('the swipe-read tint is the accent ink, never green', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/catch-up/CatchUpCard.tsx'),
      'utf8',
    );
    expect(src).toContain("props.tint === 'read' ? 'bg-accent text-accent-fg'");
    expect(src).not.toMatch(/good-solid|bg-good|text-good|variant="success"/);
  });

  it('the accent ink is defined in light and dark (black in light, white in dark)', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const light = /:root\s*\{[\s\S]*?--accent:\s*([^;]+);/.exec(css)?.[1]?.trim();
    const dark = /\n\.dark\s*\{[\s\S]*?--accent:\s*([^;]+);/.exec(css)?.[1]?.trim();
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    expect(light).not.toBe(dark);
  });
});

describe('catch up thread sheet (10 Nov 2026)', () => {
  const message = (id: string, createdAt: string, rootId?: string): CatchUpMessageRow => ({
    kind: 'message',
    id,
    author: { id: 'u2', name: 'Ana', avatarUrl: null },
    createdAt,
    text: id,
    replyCount: 0,
    ...(rootId !== undefined ? { threadRoot: message(rootId, '2026-11-08T08:00:00Z') } : {}),
  });
  const withRows = (rows: CatchUpMessageRow[]): CatchUpBody => ({
    title: 'Post',
    context: null,
    rows,
    firstNewId: null,
    hasOlder: false,
    threads: true,
    latestReplyId: null,
  });

  it("the card box posts into the newest thread-reply row's thread", () => {
    const item = card('p1');
    const body = withRows([
      message('c1', '2026-11-08T09:00:00Z'),
      message('r1', '2026-11-08T10:00:00Z', 'root-a'),
      message('r2', '2026-11-08T11:00:00Z', 'root-b'),
    ]);
    expect(cardThreadTarget(item, body)).toEqual({
      kind: 'comment',
      entityType: 'post',
      entityId: 'p1',
      parentCommentId: 'root-b',
    });
    expect(cardThreadTarget(item, withRows([message('c1', '2026-11-08T09:00:00Z')]))).toBeNull();
    expect(cardThreadTarget(item, null)).toBeNull();
  });

  it('the draft moves into the sheet box while it is open and back when it closes', () => {
    const draft = { text: 'Looks good @ana', picks: [{ userId: 'u2', name: 'ana' }] };
    // Open: the sheet box holds it, the card box is empty.
    expect(boxDraft(true, true, draft)).toBe(draft);
    expect(boxDraft(false, true, draft)).toEqual(EMPTY_DRAFT);
    // Closed without sending: back in the card box.
    expect(boxDraft(false, false, draft)).toBe(draft);
    expect(boxDraft(true, false, draft)).toEqual(EMPTY_DRAFT);
  });

  it('the fill rule never leaves a half-cut row at the top', () => {
    const tops = [0, 72, 144, 216, 288];
    expect(snapToRowTop(100, tops)).toBe(72);
    expect(snapToRowTop(144, tops)).toBe(144);
    expect(snapToRowTop(0, tops)).toBe(0);
    expect(snapToRowTop(40, [])).toBe(40);
  });
});

describe('catch up swipe never swallows the next tap (12 Nov 2026)', () => {
  // A touch press that slips sideways locks as a swipe; on touch no click
  // follows it. The next clean tap must still open the thread.
  function pointer(el: Element, type: string, clientX: number): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    act(() => {
      el.dispatchEvent(event);
    });
  }

  it('a locked swipe with no click, then pointerdown and a click, opens the thread', async () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 390,
    });
    try {
      render([card('p1')]);
      await settle();
      const open = document.querySelector<HTMLElement>('[data-catch-up-open-thread]');
      if (open === null) throw new Error('missing [data-catch-up-open-thread]');
      const text = open.querySelector('span') ?? open;
      pointer(text, 'pointerdown', 100);
      pointer(text, 'pointermove', 106);
      pointer(text, 'pointermove', 114);
      pointer(text, 'pointerup', 114);
      await settle();
      expect(document.querySelector('[data-catch-up-thread-window]')).toBeNull();
      // The next clean tap: pointerdown, then its click.
      pointer(open, 'pointerdown', 100);
      pointer(open, 'pointerup', 100);
      act(() => open.click());
      await settle();
      expect(document.querySelector('[data-catch-up-thread-window]')).not.toBeNull();
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
    }
  });
});
