import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { messageMenuItems, runMenuItem } from '@/components/chat/MessageActionMenu';
import { ICON_SIZE, IconUser } from '@/components/ui/icons';
import { REPLY_PRIVATELY } from '@/lib/chat/private-reply';

type ItemProps = Parameters<typeof messageMenuItems>[0];

function itemProps(over: Partial<ItemProps> = {}): ItemProps {
  return {
    canCopy: true,
    onReply: () => {},
    onCopy: () => {},
    canForward: true,
    onForward: () => {},
    ...over,
  };
}

describe('Reply privately row', () => {
  it('sits directly under Reply, before Copy, with the sender first name as its grey hint', () => {
    const items = messageMenuItems(
      itemProps({ canReplyPrivately: true, replyPrivatelyName: 'Asha Rao' }),
    );
    expect(items.map((i) => i.label).slice(0, 3)).toEqual(['Reply', REPLY_PRIVATELY, 'Copy']);
    const row = items[1];
    expect(row?.kind === 'action' && row.hint).toBe('to Asha');
    expect(row?.kind === 'action' && row.key).toBe('reply-privately');
  });

  it('uses IconUser at the menu size', () => {
    const row = messageMenuItems(
      itemProps({ canReplyPrivately: true, replyPrivatelyName: 'Asha' }),
    ).find((i) => i.key === 'reply-privately');
    const icon = row?.kind === 'action' ? (row.icon as ReactElement) : null;
    expect(icon?.type).toBe(IconUser);
    expect(icon?.props).toMatchObject({ size: ICON_SIZE.tray });
  });

  it('is absent unless offered (own, DM, notes, a removed member)', () => {
    expect(messageMenuItems(itemProps()).map((i) => i.label)).not.toContain(REPLY_PRIVATELY);
    expect(
      messageMenuItems(itemProps({ canReplyPrivately: false })).map((i) => i.label),
    ).not.toContain(REPLY_PRIVATELY);
  });

  it('runs its action then closes the menu', () => {
    const onReplyPrivately = vi.fn();
    const close = vi.fn();
    const row = messageMenuItems(
      itemProps({ canReplyPrivately: true, replyPrivatelyName: 'Asha', onReplyPrivately }),
    ).find((i) => i.key === 'reply-privately');
    expect(row).toBeDefined();
    if (row === undefined) return;
    runMenuItem(row, { close });
    expect(onReplyPrivately).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('a blank name shows no hint', () => {
    const row = messageMenuItems(
      itemProps({ canReplyPrivately: true, replyPrivatelyName: '  ' }),
    ).find((i) => i.key === 'reply-privately');
    expect(row?.kind === 'action' && row.hint).toBeUndefined();
  });
});
