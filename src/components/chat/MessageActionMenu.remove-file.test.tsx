// Remove files, keep the message: the More menu's "Remove file" row. It shows
// only for an own, unmarked message with exactly one file that is not a voice
// note (never on an album of 2+, someone else's message, a voice note or a
// marked message), sits last under More in the danger tone, and is hidden,
// never disabled, everywhere else.
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { messageMenuItems } from '@/components/chat/MessageActionMenu';
import { canRemoveSingleFile, REMOVE_FILE_MENU_LABEL } from '@/lib/chat/remove-files';
import type { ThreadMessage } from '@/lib/chat/thread';

const AT = '2026-10-25T10:00:00.000Z';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: '',
    createdAt: AT,
    time: Date.parse(AT),
    provisionalTime: false,
    mine: true,
    attachments: [{ assetId: 'a1', name: 'photo.jpg', mime: 'image/jpeg' }],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function base(over: Record<string, unknown> = {}): Parameters<typeof messageMenuItems>[0] {
  return {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    ...over,
  };
}

describe('canRemoveSingleFile: who gets "Remove file"', () => {
  it('an own message with one photo or one file', () => {
    expect(canRemoveSingleFile(msg(), 'me')).toBe(true);
    expect(
      canRemoveSingleFile(
        msg({ attachments: [{ assetId: 'a1', name: 'brief.pdf', mime: 'application/pdf' }] }),
        'me',
      ),
    ).toBe(true);
  });

  it('never on an album of two or more', () => {
    const album = msg({
      attachments: [
        { assetId: 'a1', name: '1.jpg', mime: 'image/jpeg' },
        { assetId: 'a2', name: '2.jpg', mime: 'image/jpeg' },
      ],
    });
    expect(canRemoveSingleFile(album, 'me')).toBe(false);
  });

  it("never on someone else's message", () => {
    expect(canRemoveSingleFile(msg({ senderUserId: 'peer', mine: false }), 'me')).toBe(false);
  });

  it('never on a voice note', () => {
    const voice = msg({ attachments: [{ assetId: 'a1', name: 'v.m4a', mime: 'audio/mp4' }] });
    expect(canRemoveSingleFile(voice, 'me')).toBe(false);
  });

  it('never on a message still sending or deleted', () => {
    expect(canRemoveSingleFile(msg({ state: 'sending' }), 'me')).toBe(false);
    expect(canRemoveSingleFile(msg({ deleted: true }), 'me')).toBe(false);
  });
});

describe('messageMenuItems: "Remove file"', () => {
  it('hidden unless the caller offers it', () => {
    expect(messageMenuItems(base()).some((i) => i.key === 'remove-file')).toBe(false);
    expect(
      messageMenuItems(base({ canRemoveFile: false })).some((i) => i.key === 'remove-file'),
    ).toBe(false);
  });

  it('just before Delete, in the danger tone, and it runs onRemoveFile', () => {
    const onRemoveFile = vi.fn();
    const items = messageMenuItems(
      base({
        canSaveToNotes: true,
        onSaveToNotes: () => {},
        canRemoveFile: true,
        onRemoveFile,
        canDelete: true,
        onDelete: () => {},
      }),
    );
    expect(items.map((i) => i.key).slice(-2)).toEqual(['remove-file', 'delete']);
    const row = items.find((i) => i.key === 'remove-file');
    expect(row?.label).toBe(REMOVE_FILE_MENU_LABEL);
    expect(row?.label).toBe('Remove file');
    expect(row?.danger).toBe(true);
    row?.run();
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
  });

  it('alone, it is the last row (no More)', () => {
    const main = messageMenuItems(base({ canRemoveFile: true, onRemoveFile: () => {} }));
    expect(main.some((i) => i.key === 'more')).toBe(false);
    expect(main[main.length - 1]?.key).toBe('remove-file');
  });
});
