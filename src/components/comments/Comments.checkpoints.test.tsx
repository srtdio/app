// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentRow, CommentResult } from '@srtdio/comments';
import type { ToastOptions } from '@/components/ui/toast/types';

// Checkpoints in the post comments panel (locked design, 7 Nov 2026):
// - the author shows ONCE per group ("{n} checkpoints · {time}"), then a
//   numbered list; the number circle is the only state;
// - an agency member resolves an open point in ONE tap (the bar's Resolve,
//   no note, no Send back), Undo for 4s; the point then folds to one line at
//   the bottom ("{n} · {first line}", ⌄ opens it inline); numbers never change;
// - a client gets Confirm on a resolved, unconfirmed point, never Resolve; the
//   circle alone says a point is open;
// - every row's actions sit on its bar (8 Nov 2026): Reply, Resolve, To-do,
//   Edit, | Delete; no line under the body, no Copy, no role label;
// - everyone can reply inside a checkpoint, clients included; a reply to a
//   reply posts to the checkpoint root with the @Name of the person replied to;
// - replies fold to the latest ("View {n} earlier replies").

type ListResult = CommentResult<CommentRow[]>;

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const RESOLVED = '2026-02-01T00:00:00.000Z';

const { pageRows, checkpointRows, viewer, toasts, rpcSpy, createSpy } = vi.hoisted(() => ({
  pageRows: { current: [] as CommentRow[] },
  checkpointRows: { current: [] as CommentRow[] },
  viewer: { id: '' },
  toasts: [] as ToastOptions[],
  rpcSpy: vi.fn(),
  createSpy: vi.fn(),
}));

vi.mock('@srtdio/comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/comments')>();
  return {
    ...actual,
    listComments: vi.fn(async (): Promise<ListResult> => ({ ok: true, data: pageRows.current })),
  };
});
vi.mock('@srtdio/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/rpc')>();
  return {
    ...actual,
    commentResolve: vi.fn(async (...args: unknown[]) => rpcSpy(...args)),
    commentCreate: vi.fn(async (...args: unknown[]) => createSpy(...args)),
  };
});
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      toasts.push(options);
      return `toast-${toasts.length}`;
    },
    dismiss: () => undefined,
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: viewer.id } } } }) },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        // createComment validates mentions against active members.
        in: async () => ({
          data:
            table === 'workspace_members'
              ? [{ user_id: AUTHOR }, { user_id: OTHER }, { user_id: CLIENT }]
              : [],
          error: null,
        }),
        order: async () => ({ data: checkpointRows.current, error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/people-names', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/people-names')>();
  return { ...actual, resolvePeople: async () => true };
});
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useHoverPointer: () => false,
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({
    canAttach: false,
    presignEnabled: false,
    presignCache: null,
    uploadFile: async () => ({ ok: false, message: 'off' }),
  }),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useMentionCandidates: () => ({
    candidates: [
      { id: AUTHOR, name: 'Ada Author', username: 'ada', role: 'agency', avatarUrl: null },
      { id: OTHER, name: 'Omar Other', username: 'omar', role: 'agency', avatarUrl: null },
      { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
    ],
  }),
}));

import { Comments } from '@/components/comments/Comments';
import { UNDO_MS } from '@/lib/undo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function row(id: string, body: string, extra: Partial<CommentRow> = {}): CommentRow {
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: null,
    author_user_id: AUTHOR,
    body,
    closed_at: null,
    closed_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    edited_at: null,
    entity_id: 'post-1',
    entity_type: 'post',
    id,
    ledger_batch_id: null,
    ledger_seq: null,
    legacy_author_name: null,
    legacy_author_email: null,
    mentions: null,
    parent_comment_id: null,
    resolution_note: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    sent_back_at: null,
    sent_back_by: null,
    task_state: null,
    unaccepted_at: null,
    unaccepted_by: null,
    workspace_id: 'ws-1',
    ...extra,
  };
}

function checkpoint(id: string, seq: number, extra: Partial<CommentRow> = {}): CommentRow {
  return row(id, `checkpoint ${seq}`, { ledger_seq: seq, ledger_batch_id: 'b1', ...extra });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function mount(viewerIsClient: boolean): Promise<void> {
  act(() => {
    root?.render(
      <Comments
        workspaceId="ws-1"
        entityType="post"
        entityId="post-1"
        viewerIsClient={viewerIsClient}
        showHeader
      />,
    );
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(host?.querySelectorAll('button') ?? []);
}
function byAria(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.getAttribute('aria-label') === label);
}
function rowEl(id: string): HTMLElement | null {
  return host?.querySelector(`#comment-${id}`) ?? null;
}
/** The checkpoint row's own Reply on its bar (not a reply's, not the composer's submit). */
function checkpointReply(id: string): HTMLButtonElement | undefined {
  return (
    rowEl(id)?.querySelector<HTMLButtonElement>(
      '[data-comment-row="root"] [data-comment-bar] [data-bar-action="reply"]',
    ) ?? undefined
  );
}
/** The open reply composer's submit: the round Send named "Reply" (the last such button). */
function composerSubmit(): HTMLButtonElement | undefined {
  const all = buttons().filter((b) => b.getAttribute('aria-label') === 'Reply');
  return all[all.length - 1];
}
function editor(): HTMLElement | null {
  return host?.querySelector('[contenteditable="true"]') ?? null;
}
function createArgs(call = 0): Record<string, unknown> {
  return (createSpy.mock.calls[call]?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  pageRows.current = [];
  checkpointRows.current = [];
  viewer.id = AUTHOR;
  toasts.length = 0;
  rpcSpy.mockReset();
  createSpy.mockReset();
  rpcSpy.mockResolvedValue({ ok: true, data: undefined });
  createSpy.mockResolvedValue({ ok: true, data: 'new-reply' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('checkpoint Resolve on the bar', () => {
  it("resolves in one tap: the bar's Resolve, no note, Undo for 4s, then folds", async () => {
    checkpointRows.current = [checkpoint('p-1', 1)];
    await mount(false);

    const box = byAria('Resolve checkpoint 1');
    expect(box).toBeDefined();
    expect(box?.closest('[data-comment-bar]')).toBeTruthy();
    expect(box?.hasAttribute('data-checkpoint-box')).toBe(true);
    expect(box?.className).toContain('min-h-11');
    expect(box?.className).toContain('min-w-11');
    // Icon only (the circle with a tick); its name is the accessible label.
    expect(box?.textContent).toBe('');
    expect(box?.querySelector('svg')).toBeTruthy();

    act(() => box?.click());

    // One tap: no textarea, note, sheet or dialog, and no Send back anywhere.
    expect(host?.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host?.textContent ?? '').not.toContain('Send back');
    // The point is resolved and folds to its one line (good outline, tick).
    expect(byAria('Resolve checkpoint 1')).toBeUndefined();
    expect(rowEl('p-1')?.getAttribute('data-point-state')).toBe('resolved');
    expect(rowEl('p-1')?.querySelector('[data-point-fold]')).toBeTruthy();
    expect(
      rowEl('p-1')
        ?.querySelector('[data-checkpoint-circle]')
        ?.getAttribute('data-checkpoint-circle'),
    ).toBe('resolved');

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    // No resolution note rides along.
    expect(rpcSpy.mock.calls[0]?.[1]).toEqual({
      p_comment_id: 'p-1',
      p_resolved: true,
      p_trace_id: 'trace-1',
    });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('Resolved');
    expect(toasts[0]?.action?.label).toBe('Undo');
    expect(toasts[0]?.durationMs).toBe(UNDO_MS);
    expect(UNDO_MS).toBe(4000);
  });

  it('a client gets Confirm on a resolved, unconfirmed point and never Resolve', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1, { resolved_at: RESOLVED })];
    await mount(true);

    // A point waiting on this approver's Confirm stays whole (never folded).
    expect(rowEl('p-1')?.querySelector('[data-point-fold]')).toBeNull();
    expect(byAria('Confirm checkpoint 1')).toBeDefined();
    expect(byAria('Resolve checkpoint 1')).toBeUndefined();
    expect(
      rowEl('p-1')
        ?.querySelector('[data-checkpoint-circle]')
        ?.getAttribute('data-checkpoint-circle'),
    ).toBe('resolved');
    expect(host?.textContent ?? '').not.toContain('Not done');
    expect(host?.textContent ?? '').not.toContain('Send back');
  });

  it('a client on their own open point: the circle says open; Reply, Edit, Delete, never Resolve or To-do', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1, { author_user_id: CLIENT })];
    await mount(true);
    expect(
      rowEl('p-1')
        ?.querySelector('[data-checkpoint-circle]')
        ?.getAttribute('data-checkpoint-circle'),
    ).toBe('open');
    expect(byAria('Resolve checkpoint 1')).toBeUndefined();
    const bar = rowEl('p-1')?.querySelector('[data-comment-row="root"] [data-comment-bar]');
    expect(
      Array.from(bar?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Reply', 'Edit', 'Delete']);
  });
});

describe('checkpoint groups', () => {
  it('shows the author once, "{n} checkpoints · {time}", then numbered circles', async () => {
    checkpointRows.current = [checkpoint('p-2', 2), checkpoint('p-1', 1)];
    await mount(false);
    const groups = host?.querySelectorAll('[data-checkpoint-group]') ?? [];
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.querySelectorAll('[data-comment-author]')).toHaveLength(1);
    expect(group.querySelector('[data-group-meta]')?.textContent).toMatch(/^2 checkpoints · /);
    const circles = Array.from(group.querySelectorAll('[data-checkpoint-circle="open"]'));
    expect(circles.map((c) => c.textContent)).toEqual(['1', '2']);
    // No card per thread: the group is a hairline-split list item.
    expect(group.className).not.toContain('lit-card-muted');
    expect(group.className).not.toContain('rounded-xl');
  });

  it('done points fold to one line at the bottom; numbers stay', async () => {
    checkpointRows.current = [
      checkpoint('p-3', 3),
      checkpoint('p-2', 2, { resolved_at: RESOLVED, body: '*Logo* too small\nsecond line' }),
      checkpoint('p-1', 1),
    ];
    await mount(false);
    const order = Array.from(host?.querySelectorAll('[data-point-state]') ?? []).map(
      (el) => `${el.id}:${el.getAttribute('data-point-state')}`,
    );
    expect(order).toEqual(['comment-p-1:open', 'comment-p-3:open', 'comment-p-2:resolved']);
    const fold = rowEl('p-2')?.querySelector<HTMLButtonElement>('[data-point-fold]');
    expect(fold?.getAttribute('aria-expanded')).toBe('false');
    expect(fold?.textContent).toContain('2 · Logo too small');
    expect(fold?.textContent).not.toContain('second line');
    // ⌄ opens the full point inline; its circle folds it again.
    act(() => fold?.click());
    expect(rowEl('p-2')?.querySelector('[data-point-fold]')).toBeNull();
    expect(rowEl('p-2')?.textContent).toContain('second line');
    act(() => byAria('Fold checkpoint 2')?.click());
    expect(rowEl('p-2')?.querySelector('[data-point-fold]')).toBeTruthy();
  });

  it('numbering is stable: resolving point 1 keeps 2 and 3 as they are', async () => {
    checkpointRows.current = [checkpoint('p-3', 3), checkpoint('p-2', 2), checkpoint('p-1', 1)];
    await mount(false);
    act(() => byAria('Resolve checkpoint 1')?.click());
    const open = Array.from(host?.querySelectorAll('[data-checkpoint-circle="open"]') ?? []);
    expect(open.map((c) => c.textContent)).toEqual(['2', '3']);
    expect(rowEl('p-1')?.querySelector('[data-point-fold]')?.textContent).toContain('1 · ');
  });
});

describe('replies inside a checkpoint', () => {
  it('a client can reply on a checkpoint; it posts to the checkpoint', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1)];
    await mount(true);

    const reply = checkpointReply('p-1');
    expect(reply).toBeDefined();
    act(() => reply?.click());
    await settle();

    // Nothing pre-filled except the @Name of the checkpoint's author.
    expect(editor()?.textContent?.trim()).toBe('@ada');

    act(() => composerSubmit()?.click());
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createArgs();
    expect(args['p_parent_comment_id']).toBe('p-1');
    expect(args['p_entity_id']).toBe('post-1');
    expect(args['p_mentions']).toEqual([AUTHOR]);
    expect(args['p_trace_id']).toBe('trace-1');
  });

  it('a reply to a reply posts to the checkpoint root with an @mention of that person', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1)];
    pageRows.current = [
      row('r-1', 'on it', {
        author_user_id: OTHER,
        parent_comment_id: 'p-1',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ];
    await mount(true);

    const replyToReply = rowEl('r-1')?.querySelector<HTMLButtonElement>('[data-reply-to-reply]');
    expect(replyToReply).toBeTruthy();
    expect(replyToReply?.className).toContain('min-h-11');
    act(() => replyToReply?.click());
    await settle();

    // The composer opens with the replied-to person's @Name, nothing else.
    const chip = editor()?.querySelector('[data-mention-id]');
    expect(chip?.getAttribute('data-mention-id')).toBe(OTHER);
    expect(editor()?.textContent?.trim()).toBe('@omar');

    act(() => composerSubmit()?.click());
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createArgs();
    // One reply level on the server: the parent is the checkpoint root, never r-1.
    expect(args['p_parent_comment_id']).toBe('p-1');
    expect(args['p_mentions']).toEqual(expect.arrayContaining([OTHER]));
    expect(String(args['p_body'])).toContain(`@[${OTHER}]`);
  });

  it('a reply in a plain comment thread has its own Reply that posts to the root', async () => {
    viewer.id = CLIENT;
    pageRows.current = [
      row('c-1', 'plain note', { created_at: '2026-01-01T00:00:00.000Z' }),
      row('r-1', 'on it', {
        author_user_id: OTHER,
        parent_comment_id: 'c-1',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ];
    await mount(true);

    const replyToReply = rowEl('r-1')?.querySelector<HTMLButtonElement>('[data-reply-to-reply]');
    expect(replyToReply).toBeTruthy();
    expect(replyToReply?.className).toContain('min-h-11');
    act(() => replyToReply?.click());
    await settle();

    expect(editor()?.querySelector('[data-mention-id]')?.getAttribute('data-mention-id')).toBe(
      OTHER,
    );
    expect(editor()?.textContent?.trim()).toBe('@omar');

    act(() => composerSubmit()?.click());
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const args = createArgs();
    expect(args['p_parent_comment_id']).toBe('c-1');
    expect(args['p_mentions']).toEqual(expect.arrayContaining([OTHER]));
  });

  it('replying to your own reply in a plain thread does not @mention yourself', async () => {
    viewer.id = OTHER;
    pageRows.current = [
      row('c-1', 'plain note', { created_at: '2026-01-01T00:00:00.000Z' }),
      row('r-1', 'on it', {
        author_user_id: OTHER,
        parent_comment_id: 'c-1',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ];
    await mount(false);

    const replyToReply = rowEl('r-1')?.querySelector<HTMLButtonElement>('[data-reply-to-reply]');
    expect(replyToReply).toBeTruthy();
    act(() => replyToReply?.click());
    await settle();

    expect(editor()).toBeTruthy();
    expect(editor()?.querySelector('[data-mention-id]')).toBeNull();
  });
});

describe('one row template for checkpoints and comments', () => {
  function barWords(rowId: string): string[] {
    const bar = rowEl(rowId)?.querySelector('[data-comment-row="root"] [data-comment-bar]');
    return Array.from(bar?.querySelectorAll('button') ?? []).map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
  }

  it('a point and a plain comment share the body and one action bar', async () => {
    checkpointRows.current = [checkpoint('p-1', 2, { author_user_id: OTHER })];
    pageRows.current = [
      row('c-1', 'plain note', { author_user_id: OTHER, created_at: '2026-01-03T00:00:00.000Z' }),
    ];
    await mount(false);

    for (const id of ['p-1', 'c-1']) {
      const el = rowEl(id);
      expect(el?.querySelector('[data-comment-row="root"]')).toBeTruthy();
      // No line under the body any more.
      expect(el?.querySelector('[data-comment-actions]')).toBeNull();
      // Every bar control a 44 icon box with no visible word.
      for (const control of Array.from(el?.querySelectorAll('[data-comment-bar] button') ?? [])) {
        expect(control.className).toContain('h-11');
        expect(control.className).toContain('min-w-11');
        expect(control.textContent).toBe('');
      }
      expect(el?.querySelector('[data-row-action="copy"]')).toBeNull();
    }
    // A plain root's header: name and time (meta role: mono, tabular); no role label.
    const header = rowEl('c-1')?.querySelector('[data-comment-header]');
    expect(header?.querySelector('[data-comment-author]')).toBeTruthy();
    const time = header?.querySelector('[data-comment-time]');
    expect(time?.className).toContain('font-mono');
    expect(time?.className).toContain('text-sm');
    expect(rowEl('c-1')?.textContent ?? '').not.toMatch(/Agency|Creator|Approver/);
    // A point shows its author on the group: no head line, the bar rides the row.
    expect(rowEl('p-1')?.querySelector('[data-comment-header]')).toBeNull();
    expect(rowEl('p-1')?.querySelector('[data-point-head]')).toBeNull();
    expect(
      rowEl('p-1')?.querySelector('[data-comment-row="root"] > [data-comment-bar]'),
    ).toBeTruthy();
    // The point's number is its circle, never a "#2".
    expect(rowEl('p-1')?.querySelector('[data-checkpoint-circle]')?.textContent).toBe('2');
    expect(rowEl('p-1')?.textContent ?? '').not.toContain('#2');

    // Agency viewer, someone else's rows: Reply, Resolve, To-do.
    expect(barWords('p-1')).toEqual(['Reply', 'Resolve checkpoint 2', 'To-do']);
    expect(barWords('c-1')).toEqual(['Reply', 'Resolve', 'To-do']);
    // No card per thread.
    expect(rowEl('c-1')?.className).not.toContain('lit-card-muted');
  });

  it("the viewer's own rows add Edit, the hairline and Delete, in that order", async () => {
    pageRows.current = [row('c-1', 'mine')];
    await mount(false);
    expect(barWords('c-1')).toEqual(['Reply', 'Resolve', 'To-do', 'Edit', 'Delete']);
    const bar = rowEl('c-1')?.querySelector('[data-comment-bar]');
    const divider = bar?.querySelector('[data-bar-divider]');
    expect(divider).toBeTruthy();
    expect(divider?.nextElementSibling?.getAttribute('aria-label')).toBe('Delete');
  });

  it('a client gets no Resolve on a plain thread', async () => {
    viewer.id = CLIENT;
    pageRows.current = [row('c-1', 'plain note')];
    await mount(true);
    expect(rowEl('c-1')?.querySelector('[data-comment-resolve]')).toBeNull();
  });

  it('a reply puts avatar 20 and name on one line, with no rule or indent', async () => {
    viewer.id = CLIENT;
    checkpointRows.current = [checkpoint('p-1', 1)];
    pageRows.current = [
      row('r-1', 'on it', {
        author_user_id: OTHER,
        parent_comment_id: 'p-1',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    ];
    await mount(true);

    const reply = rowEl('r-1')?.querySelector('[data-comment-row="reply"]');
    expect(reply).toBeTruthy();
    const header = reply?.querySelector('[data-comment-header]');
    expect(header?.querySelector('[data-comment-author]')).toBeTruthy();
    expect(header?.className).toContain('items-center');
    // Avatar, name and time at the top left; the bar off the name's line, on the row.
    expect(header?.querySelector('[data-comment-time]')).toBeTruthy();
    expect(header?.querySelector('[data-comment-bar]')).toBeNull();
    expect(reply?.querySelector(':scope > [data-comment-bar]')).toBeTruthy();
    expect(reply?.querySelector('[data-comment-actions]')).toBeNull();
    const list = rowEl('r-1')?.closest('[data-replies]');
    expect(list?.innerHTML ?? '').not.toContain('border-l');
    expect(list?.className ?? '').not.toContain('pl-4');
  });

  it('titles the section "Checkpoints" with no header count', async () => {
    checkpointRows.current = [
      checkpoint('p-1', 1),
      checkpoint('p-2', 2, { resolved_at: RESOLVED }),
    ];
    await mount(false);

    const header = host?.querySelector('[data-comments-header]');
    expect(header?.querySelector('h3')?.textContent).toBe('Checkpoints');
    expect(header?.textContent ?? '').not.toMatch(/\d+ open/);
    expect(header?.textContent ?? '').not.toContain('resolved');
    expect(host?.querySelector('[data-open-count]')).toBeNull();
  });

  it('reads "Checkpoints show up here." on an empty post', async () => {
    await mount(false);
    expect(host?.querySelector('[data-comments-empty]')?.textContent).toBe(
      'Checkpoints show up here.',
    );
  });
});

describe('folded replies', () => {
  beforeEach(() => {
    // A link scrolls its row into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });

  function replies(): CommentRow[] {
    return [1, 2, 3].map((n) =>
      row(`r-${n}`, `reply ${n}`, {
        author_user_id: OTHER,
        parent_comment_id: 'c-1',
        created_at: `2026-01-0${n + 1}T00:00:00.000Z`,
      }),
    );
  }

  it('shows only the latest reply behind "View 2 earlier replies"; the tap shows all', async () => {
    pageRows.current = [row('c-1', 'plain note'), ...replies()];
    await mount(false);
    expect(rowEl('r-3')).toBeTruthy();
    expect(rowEl('r-1')).toBeNull();
    expect(rowEl('r-2')).toBeNull();
    const more = host?.querySelector<HTMLButtonElement>('[data-replies-more]');
    expect(more?.textContent).toBe('View 2 earlier replies');
    act(() => more?.click());
    expect(rowEl('r-1')).toBeTruthy();
    expect(rowEl('r-2')).toBeTruthy();
    expect(host?.querySelector('[data-replies-more]')).toBeNull();
  });

  it('one hidden reply reads "View 1 earlier reply"', async () => {
    pageRows.current = [row('c-1', 'plain note'), ...replies().slice(0, 2)];
    await mount(false);
    expect(host?.querySelector('[data-replies-more]')?.textContent).toBe('View 1 earlier reply');
  });

  it('a deep link to a folded reply unfolds its thread', async () => {
    pageRows.current = [row('c-1', 'plain note'), ...replies()];
    act(() => {
      root?.render(
        <Comments
          workspaceId="ws-1"
          entityType="post"
          entityId="post-1"
          viewerIsClient={false}
          focusCommentId="r-1"
          showHeader
        />,
      );
    });
    await settle();
    expect(rowEl('r-1')).toBeTruthy();
    expect(host?.querySelector('[data-replies-more]')).toBeNull();
  });

  it('a deep link to a resolved point opens it from its fold', async () => {
    checkpointRows.current = [checkpoint('p-1', 1, { resolved_at: RESOLVED })];
    act(() => {
      root?.render(
        <Comments
          workspaceId="ws-1"
          entityType="post"
          entityId="post-1"
          viewerIsClient={false}
          focusCommentId="p-1"
          showHeader
        />,
      );
    });
    await settle();
    expect(rowEl('p-1')?.querySelector('[data-point-fold]')).toBeNull();
    expect(rowEl('p-1')?.querySelector('[data-comment-bar]')).toBeTruthy();
  });
});

describe('no Copy on a comment row (comment action bar, 8 Nov 2026)', () => {
  it('neither a point nor a plain comment offers Copy', async () => {
    checkpointRows.current = [checkpoint('p-1', 1)];
    pageRows.current = [row('c-1', 'plain note', { created_at: '2026-01-03T00:00:00.000Z' })];
    await mount(false);
    expect(host?.querySelector('[data-row-action="copy"]')).toBeNull();
    expect(byAria('Copy')).toBeUndefined();
    expect(host?.querySelector('[role="status"]')).toBeNull();
  });
});
