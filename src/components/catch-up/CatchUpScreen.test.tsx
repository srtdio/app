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
  CatchUpReply: (props: { hint: string }) => <form data-catch-up-reply="" aria-label={props.hint} />,
}));

import { CatchUpScreen } from '@/components/catch-up/CatchUpScreen';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';
import type { CatchUpBodyResult } from '@/lib/catch-up/body';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import { cardOf, entry } from '@/lib/catch-up/test-fixtures';
import { endLine, leftLabel } from '@/lib/catch-up/copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function card(id: string): CatchUpItem {
  return cardOf(
    entry({ id: `${id}-1`, entity_id: id, payload: { comment_id: `${id}-c` } }, { title: `Post ${id}` }),
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

function render(queue: CatchUpItem[]): { onClose: ReturnType<typeof vi.fn>; onRead: ReturnType<typeof vi.fn> } {
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
    act(() => root?.render(<CatchUpEnd wentThrough={1} onDone={onDone} />));
    expect(host.textContent).toContain("Everything's sorted.");
    click('[data-catch-up-done]');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('catch-up screen', () => {
  it('one card per item: counts what is left, keeps unread without a write', async () => {
    render([card('p1'), card('p2')]);
    await settle();
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(2));
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe('post:p1');
    click('[data-catch-up-keep]');
    expect(writes.markCatchUpRead).not.toHaveBeenCalled();
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(1));
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe('post:p2');
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
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe('post:p1');
  });

  it('a gone card is skipped silently (marked read, never shown empty, no Undo)', async () => {
    reads.readCatchUpBodies.mockImplementation(
      async (_client: unknown, input: { items: CatchUpItem[] }) =>
        new Map(input.items.map((i) => [i.key, i.entityId === 'p1' ? 'skip' : bodyFor(i.entityId)])),
    );
    render([card('p1'), card('p2')]);
    await settle();
    expect(writes.markCatchUpSkipped).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe('post:p2');
    expect(document.querySelector('[data-catch-up-undo]')?.className).toContain('invisible');
  });

  it('a failed read shows the error state; the reply box and buttons stay', async () => {
    reads.readCatchUpBodies.mockImplementation(
      async (_client: unknown, input: { items: CatchUpItem[] }) =>
        new Map(input.items.map((i) => [i.key, 'error'])),
    );
    render([card('p1')]);
    await settle();
    expect(document.querySelector('[data-catch-up-error]')?.textContent).toContain("Couldn't load this card.");
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
