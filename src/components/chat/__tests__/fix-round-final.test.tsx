import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  editedPreviewLine,
  heldWithPrefix,
  loadChatList,
  namePreviews,
  routeGlobalCmd,
  type ChatListReaders,
} from '@/components/chat/ChatStoreProvider';
import { channelListError } from '@/components/chat/ChannelList';
import { openingChannelId } from '@/components/chat/ChatConnected';
import { threadLoadErrorRow, threadOpeningSkeleton } from '@/components/chat/MessageThread';
import {
  CARD_LOAD_FAILED,
  CouldntLoadCard,
  SharedPostCardList,
  watchCardRetries,
} from '@/components/chat/PostCard';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { READ_TIMEOUT_MS, type ChannelSummary, type MentionProfile } from '@/lib/chat-reads';
import {
  applyEditedPreview,
  beginLoad,
  initialState,
  loadScope,
  updateOwnMessage,
  type ChatStoreState,
} from '@/lib/chat/chat-store';
import { rememberMentionProfiles, resetMentionNames } from '@/lib/chat/mentions';
import type { ConversationPreview } from '@/lib/chat/history';
import { editEventExt, type ChatMessageRow } from '@/lib/chat/thread';

afterEach(() => {
  vi.useRealTimers();
});

const ME = 'me-0000';
const ANA = '11111111-1111-4111-8111-111111111111';
const SCOPE = loadScope('w1', ME);
const never = <T,>(): Promise<T> => new Promise<T>(() => {});
const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data });

function group(channelId: string): ChannelSummary {
  return {
    channelId,
    channelType: 'group',
    title: channelId,
    avatarUrl: null,
    agoraGroupId: null,
    groupId: `g-${channelId}`,
    peerUserId: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function preview(senderUserId: string, body: string): ConversationPreview {
  return {
    channelId: 'g1',
    messageId: 'm1',
    senderUserId,
    body,
    hasAttachments: false,
    createdAt: '2026-09-30T10:00:00Z',
  };
}

function readers(over: Partial<ChatListReaders> = {}): ChatListReaders {
  return {
    roster: () => ok([group('g1')]),
    clears: () => ok([]),
    previews: () => ok([preview(ANA, 'hi team')]),
    counts: () => ok([]),
    ...over,
  };
}

function walk(node: unknown, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  visit(el);
  walk(el.props?.children, visit);
  walk(el.props?.action, visit);
}

describe('T1: a failed name read never fails the list', () => {
  it('a hung name read: the list is ready, the group line has no sender prefix', async () => {
    vi.useFakeTimers();
    resetMentionNames();
    const hungNames = (): Promise<Result<MentionProfile[]>> => never();
    let state: ChatStoreState = beginLoad(initialState(), SCOPE);
    void loadChatList(
      readers({ names: (p) => namePreviews(p, hungNames, 'w1', ME) }),
      SCOPE,
      ME,
    ).then((t) => {
      state = t(state);
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(state.status).toBe('ready');
    expect(state.conversations.g1?.lastMessageText).toBe('hi team');
    expect(state.conversations.g1?.lastMessagePrefix).toBeUndefined();
  });
});

describe('T2: a list read that lands after 5s wins', () => {
  it('error at 5s, then the late data replaces it; cancel delivers nothing', async () => {
    vi.useFakeTimers();
    let resolveCounts: (r: Result<[]>) => void = () => {};
    const counts = new Promise<Result<[]>>((r) => {
      resolveCounts = r;
    });
    let state: ChatStoreState = beginLoad(initialState(), SCOPE);
    const onLate = vi.fn((t: (s: ChatStoreState) => ChatStoreState) => {
      state = t(state);
    });
    void loadChatList(readers({ counts: () => counts }), SCOPE, ME, undefined, { onLate }).then(
      (t) => {
        state = t(state);
      },
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(state.status).toBe('error');
    resolveCounts({ ok: true, data: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(state.status).toBe('ready');
    expect(state.roster.map((c) => c.channelId)).toEqual(['g1']);

    const cancel = new AbortController();
    const lateAfterCancel = vi.fn();
    void loadChatList(readers({ counts: () => never() }), SCOPE, ME, undefined, {
      onLate: lateAfterCancel,
      cancel: cancel.signal,
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(lateAfterCancel).not.toHaveBeenCalled();
  });
});

describe('T3: list error copy', () => {
  it('"Couldn\'t load chats" + Retry, no connection wording', () => {
    const html = renderToStaticMarkup(channelListError(() => {}));
    expect(html).toMatch(/Couldn.{1,6}t load chats/);
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/connection|network|internet|offline/i);
  });
});

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'm1',
    channel_id: 'g1',
    workspace_id: 'w1',
    sender_user_id: ANA,
    body: 'edited',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-30T10:00:00Z',
    edited_at: '2026-09-30T10:05:00Z',
    deleted_at: null,
    ...over,
  } as ChatMessageRow;
}

describe('T4: live edits in chats that are not open', () => {
  const ext = editEventExt({ messageId: 'm1', body: 'x', editedAt: '2026-09-30T10:05:00Z' });

  it('an edit signal is verified against its row, then reaches the list line', async () => {
    const onEdited = vi.fn();
    const verified = row({});
    const loadByIds = vi.fn(async () => ({ ok: true as const, data: [verified] }));
    await routeGlobalCmd(ext, { loadByIds, onDeleted: vi.fn(), onEdited });
    expect(loadByIds).toHaveBeenCalledWith(['m1']);
    expect(onEdited).toHaveBeenCalledWith(verified);
  });

  it('a deleted, unedited or unreadable row is ignored', async () => {
    const onEdited = vi.fn();
    for (const data of [[row({ deleted_at: 'z' })], [row({ edited_at: null })], []]) {
      await routeGlobalCmd(ext, {
        loadByIds: async () => ({ ok: true, data }),
        onDeleted: vi.fn(),
        onEdited,
      });
    }
    expect(onEdited).not.toHaveBeenCalled();
  });
});

describe('E4: history failure with pending sends', () => {
  it("a Couldn't load messages row with a 44px Retry sits above the bubbles", () => {
    const retry = vi.fn();
    const root = threadLoadErrorRow(retry);
    const html = renderToStaticMarkup(<ul>{root}</ul>);
    expect(html).toMatch(/Couldn.{1,6}t load messages/);
    expect(html).toContain('min-w-[44px]');
    expect(html).toContain('h-11');
    let button: ReactElement<{ onClick: () => void }> | undefined;
    walk(root, (el) => {
      if (el.type === Button) button = el as unknown as ReactElement<{ onClick: () => void }>;
    });
    button?.props.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('E6: an edit that adds a mention names it first', () => {
  it('reads the new name, then the line says "@Ana" (never "@Former member")', async () => {
    resetMentionNames();
    const readNames = vi.fn(async (ids: string[]) => ({
      ok: true as const,
      data: ids.map((userId) => ({ userId, displayName: 'Ana', avatarUrl: null, member: true })),
    }));
    const line = await editedPreviewLine(row({ body: `ask @[${ANA}]` }), readNames);
    expect(readNames).toHaveBeenCalledTimes(1);
    expect(line).toBe('ask @Ana');
  });
});

describe('E7: a held message for a new group gets its sender prefix', () => {
  it('the re-read roster row makes it a group line', () => {
    resetMentionNames();
    rememberMentionProfiles('w1', [{ userId: ANA, displayName: 'Ana Lopez', member: true }]);
    const incoming = { channelId: 'g9', messageId: 'm9', senderIsSelf: false, text: 'hi', ts: 1 };
    const src = { sender_user_id: ANA, workspace_id: 'w1' };
    expect(heldWithPrefix(incoming, src, { channelType: 'group' }, ME).prefix).toBe('Ana');
    expect(heldWithPrefix(incoming, src, { channelType: 'dm' }, ME).prefix).toBeUndefined();
  });
});

describe('E9: a forward line carries its message id', () => {
  it('a later edit of the forwarded message moves the line', () => {
    const state = updateOwnMessage(
      { ...initialState(), scope: SCOPE },
      { channelId: 'g1', messageId: 'fwd-1', text: 'fwd', ts: 1 },
    );
    const next = applyEditedPreview(state, { channelId: 'g1', messageId: 'fwd-1', text: 'fixed' });
    expect(next.conversations.g1?.lastMessageText).toBe('fixed');
  });
});

describe('E11 + T5: card footer and the failed card', () => {
  const post = {
    id: 'p1',
    number: 12,
    title: 'Launch teaser',
    stage: 'review',
    target_date: null,
    approved_by: null,
    approved_at: null,
    stage_entered_at: '2026-09-29T10:00:00Z',
    format: 'carousel',
    thumbnailAssetVersionId: null,
    firstMedia: null,
    mediaCount: 0,
    hasVideo: false,
  };
  const view = {
    kind: 'post' as const,
    postId: 'p1',
    post: post as never,
    approverName: null,
  };

  it('while the viewer side is not known the card paints no footer', () => {
    const unknown = renderToStaticMarkup(
      <SharedPostCardList
        views={[view]}
        side="unknown"
        sideKnown={false}
        timeZone="UTC"
      />,
    );
    expect(unknown).not.toContain('data-card-footer');
    const known = renderToStaticMarkup(
      <SharedPostCardList views={[view]} side="client" timeZone="UTC" />,
    );
    expect(known).toContain('data-card-footer');
  });

  it('an id that failed every try shows "Couldn\'t load" (44px tap), not "not visible"', () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      <SharedPostCardList
        views={[{ kind: 'not_visible', postId: 'p1' }]}
        failed={['p1']}
        onRetry={onRetry}
        side="client"
        timeZone="UTC"
      />,
    );
    expect(html).toMatch(/Couldn.{1,6}t load/);
    expect(CARD_LOAD_FAILED).toBe("Couldn't load");
    expect(html).not.toContain('not visible');
    const card = CouldntLoadCard({ onRetry });
    expect(String((card.props as { className: string }).className)).toContain('min-h-[44px]');
    (card.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('failed cards retry on tab visible and on online', () => {
    const handlers: Record<string, () => void> = {};
    const target = {
      addEventListener: (type: string, fn: () => void) => {
        handlers[type] = fn;
      },
      removeEventListener: vi.fn(),
    };
    const retry = vi.fn();
    const stop = watchCardRetries(
      {
        window: target as never,
        document: { ...target, visibilityState: 'visible' } as never,
      },
      retry,
    );
    handlers.visibilitychange?.();
    handlers.online?.();
    expect(retry).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('E13 + E14: opening skeleton', () => {
  it('has the header back control (44px IconButton) when given one', () => {
    const onBack = vi.fn();
    const root = threadOpeningSkeleton('touch', onBack);
    let back: ReactElement<{ label: string; onClick: () => void }> | undefined;
    walk(root, (el) => {
      if (el.type === IconButton)
        back = el as unknown as ReactElement<{ label: string; onClick: () => void }>;
    });
    expect(back?.props.label).toBe('Back to conversations');
    back?.props.onClick();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('with chat A open, a link to B opens B at once (never another frame of A)', () => {
    expect(
      openingChannelId({
        selectedChannelId: 'A',
        channelParam: 'B',
        pendingOpen: null,
        loadStatus: 'ready',
      }),
    ).toBe('B');
    expect(
      openingChannelId({
        selectedChannelId: 'A',
        channelParam: 'A',
        pendingOpen: null,
        loadStatus: 'ready',
      }),
    ).toBeNull();
  });
});
