import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { MessageBubble } from '@/components/chat/MessageBubble';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ThreadCommentRow } from '@/components/chat/ThreadCommentRow';
import { commentMessage, localCommentRow } from '@/components/comments/Comments';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ReactionsApi } from '@/lib/reactions/use-reactions';

// Guard 2 (11 Nov 2026): a comment and a chat message with the same content
// draw the same DOM, the same classes, row and bubble. The comment row is
// chat's ThreadCommentRow over chat's MessageBubble; the only difference is
// the list's gutter (the page's PAGE_BLEED, outside the row).

const ME = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const PROFILES: Map<string, ChatProfile> = new Map([
  [ANA, { userId: ANA, displayName: 'Ana', avatarUrl: null }],
]);
const AT = '2026-11-11T10:00:00.000Z';
const NO_REACTIONS: ReactionsApi = {
  of: () => [],
  rowsOf: () => [],
  toggle: () => undefined,
  pick: () => undefined,
  me: ME,
};

function comment(): ThreadMessage {
  const row = localCommentRow({
    id: 'c1',
    workspaceId: 'w1',
    entityType: 'post',
    entityId: 'p1',
    authorUserId: ANA,
    body: 'Can we try a warmer crop?',
    attachmentVersionIds: [],
    parentCommentId: null,
    nowIso: AT,
  });
  return commentMessage(row, ME, new Map());
}

function chatRow(message: ThreadMessage, threadPlace?: 'root' | 'reply'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MessageBubble
        message={message}
        profiles={PROFILES}
        cache={sharedCardPresignCache()}
        presignEnabled={PRESIGN_ENABLED}
        showTicks={false}
        isGroup
        head
        tail
        layout="touch"
        workspaceId="w1"
        threadPlace={threadPlace}
        // Chat's MessageRow always hands its row the swipe core and the press wiring.
        swipe={{
          iconRef: { current: null },
          deleteIconRef: { current: null },
          handlers: {
            onPointerDown: () => undefined,
            onPointerMove: () => undefined,
            onPointerUp: () => undefined,
            onPointerCancel: () => undefined,
          },
          consumeClick: () => false,
        }}
        press={{
          handlers: {
            onPointerDown: () => undefined,
            onPointerMove: () => undefined,
            onPointerUp: () => undefined,
            onPointerCancel: () => undefined,
          },
          onContextMenu: () => undefined,
          consumeClick: () => false,
          coarse: true,
          onKeyOpen: () => undefined,
        }}
        onTapOpen={() => undefined}
      />
    </MemoryRouter>,
  );
}

function commentRow(message: ThreadMessage, threadPlace?: 'root' | 'reply'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ThreadCommentRow
        message={message}
        head
        tail
        afterLabel={false}
        profiles={PROFILES}
        workspaceId="w1"
        me={ME}
        layout="touch"
        highlighted={false}
        hoverMenu={false}
        coarsePointer
        reducedMotion
        personSource={() => null}
        mentions={{ peerUserId: null, onOpen: () => undefined }}
        onOpenMenu={() => undefined}
        onReply={() => undefined}
        onTapOpen={() => undefined}
        onRetry={undefined}
        onDiscard={undefined}
        reactions={NO_REACTIONS}
        threadPlace={threadPlace}
      />
    </MemoryRouter>,
  );
}

const classOf = (html: string, hook: RegExp): string | undefined =>
  new RegExp(`<[a-z]+[^>]*${hook.source}[^>]*class="([^"]*)"`).exec(html)?.[1] ??
  new RegExp(`<[a-z]+[^>]*class="([^"]*)"[^>]*${hook.source}`).exec(html)?.[1];

describe('Guard 2: a comment draws exactly as a chat message', () => {
  for (const place of [undefined, 'root', 'reply'] as const) {
    it(`same row, bubble, name line and body classes (${place ?? 'main list'})`, () => {
      const chat = chatRow(comment(), place);
      const mine = commentRow(comment(), place);
      for (const hook of [/data-msg-id="c1"/, /data-bubble=""/, /data-bubble-content=""/]) {
        expect(classOf(mine, hook), hook.source).toBe(classOf(chat, hook));
      }
      // The same visible text, in the same order.
      const text = (html: string): string => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
      expect(text(mine)).toBe(text(chat));
    });
  }
});

// Thread polish 2 (11 Nov 2026): a thread's main message always carries the
// add-reaction key; nothing else gains one.
describe("Guard: the add-reaction key on a thread's main message", () => {
  it('a root that can be reacted to shows the key with zero reactions', () => {
    const root = commentRow(comment(), 'root');
    expect(root).toContain('data-reaction-chips');
    expect(root.split('data-reaction-add').length - 1).toBe(1);
  });

  it('a reply and a main-list row with zero reactions show no chips row and no key', () => {
    for (const place of ['reply', undefined] as const) {
      const row = commentRow(comment(), place);
      expect(row).not.toContain('data-reaction-chips');
      expect(row).not.toContain('data-reaction-add');
    }
  });

  it('a root that cannot be reacted to (no chip wiring) shows none', () => {
    expect(chatRow(comment(), 'root')).not.toContain('data-reaction-add');
  });
});
