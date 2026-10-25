// X7 fix 5 (FT39): deleting a single text message goes behind a 4s Undo (the
// row reads as a tombstone at once; the delete for everyone runs after the
// window through the existing delete path); a message with files keeps the
// confirm. The commit is bound to its chat, so a flush after the chat was left
// still deletes in the right one.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The chat modules' import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  MESSAGE_DELETED_UNDO,
  deleteHasUndo,
  withUndoTombstones,
} from '@/components/chat/MessageThread';
import { UNDO_MS } from '@/lib/undo';
import type { ThreadMessage } from '@/lib/chat/thread';

const NOW = Date.parse('2026-10-19T10:00:00.000Z');

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = new Date(NOW - 60_000).toISOString();
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

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('X7 FT39: delete a text message, then Undo', () => {
  it('a text message gets the Undo; a message with files keeps the confirm', () => {
    expect(deleteHasUndo(msg())).toBe(true);
    expect(
      deleteHasUndo(
        msg({ attachments: [{ assetId: 'a1', name: 'photo.jpg', mime: 'image/jpeg' }] }),
      ),
    ).toBe(false);
    expect(UNDO_MS).toBe(4000);
    expect(MESSAGE_DELETED_UNDO).toBe('Message deleted');
  });

  it('inside the window the row is a tombstone; Undo (dropping the id) brings it back', () => {
    const rows = [msg(), msg({ id: 'm2', body: 'second' })];
    const during = withUndoTombstones(rows, new Set(['m1']));
    expect(during[0]?.deleted).toBe(true);
    expect(during[1]?.deleted).not.toBe(true);
    const undone = withUndoTombstones(rows, new Set());
    expect(undone).toBe(rows);
    expect(undone[0]?.body).toBe('hello');
  });

  it('the menu Delete routes text to the Undo path and files to the confirm', () => {
    const thread = source('../MessageThread.tsx');
    expect(thread).toMatch(
      /if \(deleteHasUndo\(message\)\) deleteWithUndo\(message\);\s*else setDeleteOneFor\(message\);/,
    );
    // The commit is the existing delete path, bound to the chat the row is in.
    expect(thread).toContain('await onDeleteMessages([id], forChannel)');
    expect(thread).toContain('label: MESSAGE_DELETED_UNDO');
  });

  it('a delete committed after the chat was left goes to that chat, without a live signal', () => {
    const hook = source('../../../lib/chat/use-chat-thread.ts');
    expect(hook).toContain('const forChannel = channelId ?? channelRef.current;');
    expect(hook).toContain('const open = channelRef.current === forChannel;');
  });
});
