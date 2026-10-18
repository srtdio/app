import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// W7 chat messages and notes: the shorter menu, direct delete, failed sends,
// the notes copy and the group info icon. One regression test per fix.

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));

import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  menuMaxHeight,
  messageMenuItems,
  moreMenuItems,
  ownMessageActions,
  runMenuItem,
  scrollFromMenu,
} from '@/components/chat/MessageActionMenu';
import {
  FailedActions,
  InfoGlyph,
  canDiscardFailed,
  withoutDiscarded,
} from '@/components/chat/MessageThread';
import { deleteMessagesConfirm, deleteOneConfirm } from '@/components/chat/SelectionBar';
import { deleteConfirmCopy } from '@/lib/chat/delete-flow';
import type { ThreadMessage } from '@/lib/chat/thread';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const MIN = 60_000;
const noop = (): void => undefined;

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = new Date(NOW - 5 * MIN).toISOString();
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'hello',
    createdAt,
    time: Date.parse(createdAt),
    provisionalTime: false,
    mine: true,
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

type DialogProps = { title: string; message: string; confirmLabel: string };

function dialog(el: ReactElement | null): DialogProps {
  expect(el?.type).toBe(ConfirmDialog);
  return el?.props as DialogProps;
}

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const everything = {
  canCopy: true,
  onReply: noop,
  onCopy: noop,
  canForward: true,
  canEdit: true,
  canStar: true,
  canDelete: true,
  canTranscribe: true,
  canSelectText: true,
  canSaveToNotes: true,
  canRemind: true,
  markOptions: ['commitment' as const],
};

describe('fix 1: the long-press menu top level', () => {
  it('reads Reply, Copy, Forward, Edit, Star, More, Delete; the rest sits under More', () => {
    expect(messageMenuItems(everything).map((i) => i.key)).toEqual([
      'reply',
      'copy',
      'forward',
      'edit',
      'star',
      'more',
      'delete',
    ]);
    expect(moreMenuItems(everything).map((i) => i.key)).toEqual([
      'transcribe',
      'select-text',
      'save-notes',
      'remind',
      'mark',
    ]);
    const del = messageMenuItems(everything).at(-1);
    expect(del?.kind === 'action' && del.danger).toBe(true);
  });

  it('hides rows that do not apply, More included when nothing sits under it', () => {
    const keys = messageMenuItems({ canCopy: false, onReply: noop, onCopy: noop }).map(
      (i) => i.key,
    );
    expect(keys).toEqual(['reply']);
  });

  it('More opens its submenu without closing; the menu caps at the viewport less 16px', () => {
    const more = messageMenuItems(everything).find((i) => i.key === 'more');
    const openMore = vi.fn();
    const close = vi.fn();
    if (more !== undefined) runMenuItem(more, { openMark: noop, openMore, close });
    expect(openMore).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(menuMaxHeight(568)).toBe(552);
    const inside = {} as Node;
    expect(scrollFromMenu({ contains: (n) => n === inside }, null)).toBe(false);
  });
});

describe('fix 2: menu Delete opens the single-message confirm', () => {
  it('wires onDeleteMessage to the confirm, never to selection mode', () => {
    const thread = source('../MessageThread.tsx');
    expect(thread).not.toContain('onDeleteMessage: enterSelection');
    expect(thread).toContain('setDeleteOneFor(message)');
    expect(thread).toContain('deleteOneConfirm({');
  });

  it('keeps the files copy for a message with a file', () => {
    const withFile = msg({
      attachments: [{ assetId: 'a1', name: 'brief.pdf', mime: 'application/pdf' }],
    });
    const copy = deleteConfirmCopy([withFile]);
    const props = dialog(
      deleteOneConfirm({ open: true, busy: false, copy, onCancel: noop, onConfirm: noop }),
    );
    expect(props.title).toBe(copy?.title);
  });
});

describe('fix 3: a failed text message', () => {
  it('shows "Not sent" with Retry and Delete beside it', () => {
    const html = renderToStaticMarkup(<FailedActions onRetry={noop} onDelete={noop} />);
    expect(html).toContain('Not sent');
    expect(html).toContain('data-failed-line-retry');
    expect(html).toContain('data-failed-delete');
    expect(html).toContain('min-h-[44px]');
  });

  it('offers Delete in its menu, with no window hint, and the row leaves the thread', () => {
    const failed = msg({ state: 'failed', status: 'failed' });
    expect(canDiscardFailed(failed)).toBe(true);
    expect(canDiscardFailed({ ...failed, filesMissing: true })).toBe(false);
    expect(canDiscardFailed({ ...failed, mine: false })).toBe(false);
    const del = messageMenuItems({
      canCopy: true,
      onReply: noop,
      onCopy: noop,
      canDelete: true,
      failedSend: true,
    }).find((i) => i.key === 'delete');
    expect(del?.kind === 'action' && del.hint).toBeUndefined();
    expect(withoutDiscarded([failed, msg({ id: 'm2' })], new Set(['m1'])).map((m) => m.id)).toEqual(
      ['m2'],
    );
  });
});

describe('fix 4: personal notes', () => {
  it('delete copy is "Delete note? This can\'t be undone." with no "for everyone"', () => {
    const one = dialog(
      deleteOneConfirm({ open: true, busy: false, notes: true, onCancel: noop, onConfirm: noop }),
    );
    expect(one).toMatchObject({ title: 'Delete note?', message: "This can't be undone." });
    const many = dialog(
      deleteMessagesConfirm({
        open: true,
        count: 2,
        notes: true,
        busy: false,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    for (const p of [one, many]) {
      expect(`${p.title} ${p.message} ${p.confirmLabel}`).not.toMatch(/for everyone/i);
    }
  });

  it('notes have no edit time limit', () => {
    const old = msg({ createdAt: new Date(NOW - 5 * 60 * MIN).toISOString() });
    expect(ownMessageActions(old, undefined, NOW, true).canEdit).toBe(true);
    expect(ownMessageActions(old, undefined, NOW, false).canEdit).toBe(false);
    const edit = messageMenuItems({ ...everything, notes: true }).find((i) => i.key === 'edit');
    expect(edit?.kind === 'action' && edit.hint).toBeUndefined();
  });
});

describe('fix 5: the group info header icon', () => {
  it('uses the info icon, not the gear', () => {
    expect(renderToStaticMarkup(<InfoGlyph />)).toContain('data-info-glyph');
    const thread = source('../MessageThread.tsx');
    expect(thread).not.toContain('IconSettings');
    expect(thread).toMatch(/label="Group info" onClick=\{props\.onOpenInfo\}>\s*<InfoGlyph/);
  });
});
