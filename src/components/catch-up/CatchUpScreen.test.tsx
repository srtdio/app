// @vitest-environment jsdom
// Catch up's screen: the end screen's count wording, Keep unread writes
// nothing, Mark as read calls the write and moves on, Undo puts the card back
// and calls the undo write, the reply box shows only on cards that take one,
// and the top bar counts "<N> left".

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
}));
vi.mock('@/lib/catch-up/writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catch-up/writes')>()),
  ...writes,
}));
vi.mock('@/lib/catch-up/reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catch-up/reads')>()),
  readCatchUpChat: vi.fn(async () => new Map()),
}));

import { CatchUpScreen } from '@/components/catch-up/CatchUpScreen';
import { CatchUpEnd } from '@/components/catch-up/CatchUpEnd';
import { mapEntry, type ActivityItem } from '@/components/pages/activity/data';
import { endLine, leftLabel } from '@/lib/catch-up/copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = '0190a000-0000-7000-8000-0000000000aa';
const ME = '0190a000-0000-7000-8000-0000000000bb';

function entry(id: string, over: Partial<ActivityItem> = {}): ActivityItem {
  const item = mapEntry({
    id,
    workspace_id: WS,
    user_id: ME,
    event_type: 'stage_change',
    entity_type: 'post',
    entity_id: `post-${id}`,
    scope: 'posts',
    scope_key: null,
    tier: 'active',
    created_at: '2026-11-08T10:00:00Z',
    read_at: null,
    snoozed_until: null,
    deleted_at: null,
    email_sent_at: null,
    payload: { to_stage: 'approved' },
    actor_user_id: null,
  });
  return { ...item, title: `Post ${id}`, ...over };
}

let root: Root | null = null;
let host: HTMLDivElement;

function render(queue: ActivityItem[]): { onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CatchUpScreen
        queue={queue}
        workspaceId={WS}
        currentUserId={ME}
        selfName={null}
        onClose={onClose}
        onRead={vi.fn()}
        onUnread={vi.fn()}
        onAllRead={vi.fn()}
      />,
    ),
  );
  return { onClose };
}

function click(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  act(() => el.click());
}

beforeEach(() => {
  writes.markCatchUpRead.mockClear();
  writes.undoCatchUpRead.mockClear();
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
    expect(host.textContent).toContain('You went through 1 update.');
    click('[data-catch-up-done]');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('catch-up screen', () => {
  it('counts what is left and keeps unread without a write', () => {
    render([entry('a'), entry('b')]);
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(2));
    click('[data-catch-up-keep]');
    expect(writes.markCatchUpRead).not.toHaveBeenCalled();
    expect(document.querySelector('[data-catch-up-left]')?.textContent).toBe(leftLabel(1));
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'b',
    );
  });

  it('marks read through the write, then ends with the count', async () => {
    render([entry('a')]);
    click('[data-catch-up-read]');
    expect(writes.markCatchUpRead).toHaveBeenCalledTimes(1);
    await act(async () => Promise.resolve());
    expect(document.querySelector('[data-catch-up-end]')).not.toBeNull();
    expect(document.body.textContent).toContain('You went through 1 update.');
  });

  it('Undo brings the last card back and calls the undo write for a read card', async () => {
    render([entry('a'), entry('b')]);
    click('[data-catch-up-read]');
    await act(async () => Promise.resolve());
    click('[data-catch-up-undo]');
    expect(writes.undoCatchUpRead).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-catch-up-card]')?.getAttribute('data-catch-up-card')).toBe(
      'a',
    );
  });

  it('shows no reply box on a card that takes none, and one on a comment card', () => {
    render([entry('a')]);
    expect(document.querySelector('[data-catch-up-reply]')).toBeNull();
    act(() => root?.unmount());
    document.body.innerHTML = '';
    render([entry('c', { eventType: 'comment', commentId: 'cm-1', body: 'Looks good' })]);
    const input = document.querySelector<HTMLTextAreaElement>('[data-catch-up-reply-input]');
    expect(input?.getAttribute('placeholder')).toBe('Reply');
  });

  it('Back closes', () => {
    const { onClose } = render([entry('a')]);
    click('[data-catch-up-back]');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
