import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatStatus } from '@/lib/chat/types';
import type { ChannelSummary } from '@/lib/chat-reads';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const chat = vi.hoisted(() => ({ status: 'connecting' as ChatStatus }));
vi.mock('@/lib/chat', () => ({
  useChat: () => ({ status: chat.status, client: null }),
}));

import {
  CONVERSATION_BODY_PX,
  CONVERSATION_SKELETON_ROWS,
  ConversationPicker,
  conversationPickerBody,
} from '@/components/pages/pcs/ConversationPicker';

function channel(channelId: string, title: string): ChannelSummary {
  return {
    channelId,
    channelType: 'dm',
    title,
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: 'p',
    createdAt: '2026-09-29T10:00:00Z',
  };
}

const READY = {
  status: 'ready' as const,
  channels: [channel('c1', 'Asha'), channel('c2', 'Ravi')],
};

describe('R12: the conversation picker is never connection-gated', () => {
  it.each<ChatStatus>(['connecting', 'reconnecting', 'unavailable', 'kicked'])(
    'first paint while chat is %s: skeleton rows, never connection or loading text',
    (status) => {
      chat.status = status;
      const html = renderToStaticMarkup(
        <ConversationPicker
          postId="post"
          workspaceId="w"
          currentUserId="me"
          onToast={vi.fn()}
          onSent={vi.fn()}
        />,
      );
      expect(html.match(/data-conversation-skeleton/g)).toHaveLength(CONVERSATION_SKELETON_ROWS);
      expect(html).not.toMatch(/>[^<]*(Loading|Connecting|Reconnecting|Offline)[^<]*</);
    },
  );

  it('the loaded list renders from its data, whatever the connection', () => {
    const html = renderToStaticMarkup(conversationPickerBody(READY, null, vi.fn()));
    expect(html).toContain('Asha');
    expect(html).toContain('Ravi');
    expect(html).not.toContain('data-conversation-skeleton');
  });

  it('skeleton rows hold the final row box (44px min, same padding and line boxes)', () => {
    const skeleton = renderToStaticMarkup(
      conversationPickerBody({ status: 'loading' }, null, vi.fn()),
    );
    const rows = renderToStaticMarkup(conversationPickerBody(READY, null, vi.fn()));
    for (const cls of [
      'min-h-[44px]',
      'px-3',
      'py-2',
      'gap-3',
      'text-base font-medium leading-snug',
      'text-sm leading-snug',
    ]) {
      expect(skeleton).toContain(cls);
      expect(rows).toContain(cls);
    }
    expect(skeleton).toContain('bg-panel-2');
    expect(skeleton).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('a tap sends to that conversation', () => {
    const onSend = vi.fn();
    const body = conversationPickerBody(READY, null, onSend);
    const list = (body.props as { children: { props: unknown } }).children;
    const children = (list.props as { children: { props: { onClick: () => void } }[] }).children;
    children[1]?.props.onClick();
    expect(onSend).toHaveBeenCalledWith(READY.channels[1]);
  });

  it('the body keeps one fixed height in all four states; skeleton rows fill it', () => {
    const states = [
      conversationPickerBody({ status: 'loading' }, null, vi.fn()),
      conversationPickerBody(READY, null, vi.fn()),
      conversationPickerBody({ status: 'ready', channels: [] }, null, vi.fn()),
      conversationPickerBody({ status: 'error' }, null, vi.fn()),
    ];
    const boxes = states.map((el) => (el.props as { className: string }).className);
    for (const box of boxes) expect(box).toBe(`h-[${CONVERSATION_BODY_PX}px] overflow-y-auto`);
    // 51.75px rows with a 4px gap cover the whole body.
    expect(
      CONVERSATION_SKELETON_ROWS * 51.75 + (CONVERSATION_SKELETON_ROWS - 1) * 4,
    ).toBeGreaterThanOrEqual(CONVERSATION_BODY_PX);
    const loading = renderToStaticMarkup(
      conversationPickerBody({ status: 'loading' }, null, vi.fn()),
    );
    expect(loading).toMatch(/role="status"[^>]*aria-label="Loading conversations"/);
  });
});
