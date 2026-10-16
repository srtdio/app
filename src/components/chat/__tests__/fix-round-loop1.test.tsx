import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ROSTER_READ_BUDGET_MS,
  editedPreviewLine,
  loadChatList,
  type ChatListReaders,
} from '@/components/chat/ChatStoreProvider';
import { READ_TIMEOUT_MS, type ChannelSummary, type MentionProfile } from '@/lib/chat-reads';
import { beginLoad, initialState, loadScope, type ChatStoreState } from '@/lib/chat/chat-store';
import { resetMentionNames } from '@/lib/chat/mentions';
import type { ChatMessageRow } from '@/lib/chat/thread';

afterEach(() => {
  vi.useRealTimers();
});

const SCOPE = loadScope('w1', 'me');
const ok = <T,>(data: T): Promise<Result<T>> => Promise.resolve({ ok: true, data });

describe('the roster reader has its own 5s; a late roster still wins', () => {
  it('a roster answering at 6s: the error at 5s, then the list replaces it', async () => {
    vi.useFakeTimers();
    const roster: ChannelSummary[] = [
      {
        channelId: 'g1',
        channelType: 'group',
        title: 'g1',
        avatarUrl: null,
        agoraGroupId: null,
        groupId: 'g',
        peerUserId: null,
        createdAt: '2026-09-01T00:00:00Z',
      },
    ];
    const readers: ChatListReaders = {
      roster: () => new Promise((r) => setTimeout(() => r({ ok: true, data: roster }), 6_000)),
      clears: () => ok([]),
      previews: () => ok([]),
      counts: () => ok([]),
    };
    const states: string[] = [];
    let state: ChatStoreState = beginLoad(initialState(), SCOPE);
    const apply = (t: (s: ChatStoreState) => ChatStoreState): void => {
      state = t(state);
      states.push(state.status);
    };
    void loadChatList(readers, SCOPE, 'me', undefined, { onLate: apply }).then(apply);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(states).toEqual(['error']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states).toEqual(['error', 'ready']);
    expect(ROSTER_READ_BUDGET_MS).toBe(2 * READ_TIMEOUT_MS);
  });
});

describe('an edit whose new mention cannot be named keeps the line', () => {
  it('a failed name read returns null (never "@Former member" for a member)', async () => {
    resetMentionNames();
    const id = '11111111-1111-4111-8111-111111111111';
    const failed = async (): Promise<Result<MentionProfile[]>> => ({
      ok: false,
      error: { code: 'unknown', message: 'x' },
    });
    const row = {
      id: 'm1',
      channel_id: 'g1',
      workspace_id: 'w1',
      body: `ask @[${id}]`,
      attachment_asset_ids: null,
      attachment_meta: null,
      shared_post_ids: null,
      shared_brief_ids: null,
    } as unknown as ChatMessageRow;
    expect(await editedPreviewLine(row, failed)).toBeNull();
  });
});
