// Remove files, keep the message: the More menu's "Remove file" row. It shows
// only for an own, unmarked message with exactly one file that is not a voice
// note (never on an album of 2+, someone else's message, a voice note or a
// marked message), sits last under More in the danger tone, and is hidden,
// never disabled, everywhere else.
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { messageMenuItems, moreMenuItems } from '@/components/chat/MessageActionMenu';
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

const NO_MARKS = new Set<string>();

function base(over: Record<string, unknown> = {}): Parameters<typeof moreMenuItems>[0] {
  return {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    ...over,
  };
}

describe('canRemoveSingleFile: who gets "Remove file"', () => {
  it('an own, unmarked message with one photo or one file', () => {
    expect(canRemoveSingleFile(msg(), 'me', NO_MARKS)).toBe(true);
    expect(
      canRemoveSingleFile(
        msg({ attachments: [{ assetId: 'a1', name: 'brief.pdf', mime: 'application/pdf' }] }),
        'me',
        NO_MARKS,
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
    expect(canRemoveSingleFile(album, 'me', NO_MARKS)).toBe(false);
  });

  it("never on someone else's message", () => {
    expect(canRemoveSingleFile(msg({ senderUserId: 'peer', mine: false }), 'me', NO_MARKS)).toBe(
      false,
    );
  });

  it('never on a voice note', () => {
    const voice = msg({ attachments: [{ assetId: 'a1', name: 'v.m4a', mime: 'audio/mp4' }] });
    expect(canRemoveSingleFile(voice, 'me', NO_MARKS)).toBe(false);
  });

  it('never on a marked message', () => {
    expect(canRemoveSingleFile(msg(), 'me', new Set(['m1']))).toBe(false);
  });

  it('never on a message still sending or deleted', () => {
    expect(canRemoveSingleFile(msg({ state: 'sending' }), 'me', NO_MARKS)).toBe(false);
    expect(canRemoveSingleFile(msg({ deleted: true }), 'me', NO_MARKS)).toBe(false);
  });
});

describe('moreMenuItems: "Remove file"', () => {
  it('hidden unless the caller offers it', () => {
    expect(moreMenuItems(base()).some((i) => i.key === 'remove-file')).toBe(false);
    expect(moreMenuItems(base({ canRemoveFile: false })).some((i) => i.key === 'remove-file')).toBe(
      false,
    );
  });

  it('last under More, in the danger tone, and it runs onRemoveFile', () => {
    const onRemoveFile = vi.fn();
    const items = moreMenuItems(
      base({
        canSaveToNotes: true,
        onSaveToNotes: () => {},
        markOptions: ['commitment'],
        onMark: () => {},
        canRemoveFile: true,
        onRemoveFile,
      }),
    );
    const last = items[items.length - 1];
    expect(last?.key).toBe('remove-file');
    expect(last?.label).toBe(REMOVE_FILE_MENU_LABEL);
    expect(last?.label).toBe('Remove file');
    expect(last?.kind === 'action' && last.danger === true).toBe(true);
    if (last?.kind === 'action') last.run();
    expect(onRemoveFile).toHaveBeenCalledTimes(1);
  });

  it('alone, it is enough to show More on the main view', () => {
    const main = messageMenuItems(base({ canRemoveFile: true, onRemoveFile: () => {} }));
    expect(main.some((i) => i.key === 'more')).toBe(true);
    expect(main.some((i) => i.key === 'remove-file')).toBe(false);
  });
});
