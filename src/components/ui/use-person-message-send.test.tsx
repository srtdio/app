// @vitest-environment jsdom
// The person card's inline send. queuePersonMessage: a held DM queues through
// the outbox at once; a missing one is ensured (startDmChannel) in the
// background after the card closed, retried, and the text given back on a
// final failure; a source rides as local.privateReply (recorded through
// chat_private_reply_send with its kind and source id); no source is a plain
// send. usePersonMessageSend: the "Sent to <first name>" toast and its
// "Open chat" action.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  roster: [] as unknown[],
  enqueue: vi.fn(),
  reloadRoster: vi.fn(async () => null),
  toast: vi.fn((options: unknown): string => {
    void options;
    return 'toast-1';
  }),
  navigate: vi.fn(),
  startDmChannel: vi.fn(),
  hasStore: true,
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => {
    if (!h.hasStore) throw new Error('useChatStore must be used within a ChatStoreProvider');
    return {
      roster: h.roster,
      outbox: { enqueue: h.enqueue },
      reloadRoster: h.reloadRoster,
    };
  },
}));
vi.mock('@/components/chat/chat-actions', () => ({
  startDmChannel: h.startDmChannel,
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ show: h.toast, dismiss: vi.fn() }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: ME } } }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WS }),
}));

import {
  DM_ENSURE_ATTEMPTS,
  personMessageEntry,
  queuePersonMessage,
  usePersonMessageSend,
  type PersonMessage,
  type PersonSendDeps,
} from '@/components/ui/use-person-message-send';
import { privateReplyFromDraft, type PrivateReplyDraft } from '@/lib/chat/private-reply';
import { notesChannelId } from '@/lib/chat/notes';
import { runSend, type SendFlowDeps } from '@/lib/chat/send-flow';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { MENTION_DM_FAILED, OPEN_CHAT, sentToTitle } from '@/lib/person-card';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { OutboxEntry } from '@/lib/chat/chat-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const WS = 'ws-1';
const DM = 'dm-held';

const ROSTER = [
  { channelId: DM, channelType: 'dm', peerUserId: PEER },
] as unknown as ChannelSummary[];

const SOURCES: Record<'chat' | 'comment' | 'plan_comment', PrivateReplyDraft> = {
  chat: {
    kind: 'chat',
    sourceId: 'msg-1',
    authorUserId: PEER,
    authorName: 'Asha Rao',
    excerpt: 'Can we move the shoot to Friday',
    whereLabel: 'Spring team',
    link: { kind: 'chat', channelId: 'grp-1', messageId: 'msg-1' },
  },
  comment: {
    kind: 'comment',
    sourceId: 'c-1',
    authorUserId: PEER,
    authorName: 'Asha Rao',
    excerpt: 'Swap the hero shot',
    whereLabel: 'Monday carousel',
    link: { kind: 'comment', entityType: 'post', entityId: 'post-1', commentId: 'c-1' },
  },
  plan_comment: {
    kind: 'plan_comment',
    sourceId: 'pc-1',
    authorUserId: PEER,
    authorName: 'Asha Rao',
    excerpt: 'Reel first',
    whereLabel: 'Reel idea',
    link: { kind: 'plan_comment', planId: 'plan-1', itemId: 'item-1', commentId: 'pc-1' },
  },
};

function message(over: Partial<PersonMessage> = {}): PersonMessage {
  return { userId: PEER, firstName: 'Asha', text: 'On it', source: null, ...over };
}

function deps(over: Partial<PersonSendDeps> = {}): PersonSendDeps & {
  enqueue: ReturnType<typeof vi.fn>;
  onChannel: ReturnType<typeof vi.fn>;
  onEnsureFailed: ReturnType<typeof vi.fn>;
  ensureDm: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn();
  const onChannel = vi.fn();
  const onEnsureFailed = vi.fn();
  const ensureDm = vi.fn(async () => null);
  return {
    me: ME,
    workspaceId: WS,
    roster: ROSTER,
    outbox: { enqueue },
    ensureDm,
    onChannel,
    onEnsureFailed,
    wait: async () => undefined,
    newId: () => 'm-1',
    enqueue,
    ...over,
  } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('personMessageEntry', () => {
  it('trims; blank text is nothing to send', () => {
    expect(personMessageEntry('m', '   ', null)).toBeNull();
    expect(personMessageEntry('m', ' hi ', null)?.text).toBe('hi');
  });

  it('no source: a plain send with no privateReply key', () => {
    const entry = personMessageEntry('m', 'hi', null);
    expect(entry).toEqual({
      id: 'm',
      text: 'hi',
      local: { attachments: [], sharedPostIds: [], sharedBriefIds: [], reply: null },
      state: 'sending',
    });
    expect(entry !== null && 'privateReply' in entry.local).toBe(false);
  });

  for (const kind of ['chat', 'comment', 'plan_comment'] as const) {
    it(`a ${kind} source rides as local.privateReply`, () => {
      const entry = personMessageEntry('m', 'hi', SOURCES[kind]);
      expect(entry?.local.privateReply).toEqual(privateReplyFromDraft(SOURCES[kind]));
      expect(entry?.local.privateReply?.kind).toBe(kind);
    });
  }
});

describe('queuePersonMessage', () => {
  it('a held DM queues at once through the outbox', () => {
    const d = deps();
    expect(queuePersonMessage(message(), d)).toBe(true);
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    const [channelId, entry] = d.enqueue.mock.calls[0] as [string, OutboxEntry];
    expect(channelId).toBe(DM);
    expect(entry).toMatchObject({ id: 'm-1', text: 'On it', state: 'sending' });
    expect(d.onChannel).toHaveBeenCalledWith(DM);
    expect(d.ensureDm).not.toHaveBeenCalled();
  });

  it('blank text queues nothing and reads nothing', () => {
    const d = deps();
    expect(queuePersonMessage(message({ text: ' \n ' }), d)).toBe(false);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.ensureDm).not.toHaveBeenCalled();
  });

  it('no workspace: nowhere to send', () => {
    const d = deps({ workspaceId: null });
    expect(queuePersonMessage(message(), d)).toBe(false);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('me: the send goes to my notes', () => {
    const d = deps();
    queuePersonMessage(message({ userId: ME }), d);
    expect(d.enqueue.mock.calls[0]?.[0]).toBe(notesChannelId(WS, ME));
  });

  it('no DM held: returns before the ensure answers, then queues on its answer', async () => {
    let answer: (() => void) | null = null;
    const ensureDm = vi.fn(
      (_p: unknown, onOpen: (id: string) => void) =>
        new Promise<null>((resolve) => {
          answer = () => {
            onOpen('dm-new');
            resolve(null);
          };
        }),
    );
    const d = deps({ roster: [], ensureDm });
    expect(queuePersonMessage(message(), d)).toBe(true);
    // The caller (the card) has already closed; nothing is queued yet.
    expect(d.enqueue).not.toHaveBeenCalled();
    await flush();
    expect(ensureDm).toHaveBeenCalledTimes(1);
    expect(ensureDm.mock.calls[0]?.[0]).toMatchObject({ workspaceId: WS, peerUserId: PEER });
    (answer as (() => void) | null)?.();
    await flush();
    expect(d.enqueue).toHaveBeenCalledWith('dm-new', expect.objectContaining({ id: 'm-1' }));
    expect(d.onChannel).toHaveBeenCalledWith('dm-new');
    expect(d.onEnsureFailed).not.toHaveBeenCalled();
  });

  it('a failed ensure retries, then queues on a later success', async () => {
    let calls = 0;
    const ensureDm = vi.fn(async (_p: unknown, onOpen: (id: string) => void) => {
      calls += 1;
      if (calls < 3) return { message: 'network' };
      onOpen('dm-new');
      return null;
    });
    const d = deps({ roster: [], ensureDm });
    queuePersonMessage(message(), d);
    await flush();
    expect(ensureDm).toHaveBeenCalledTimes(3);
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.onEnsureFailed).not.toHaveBeenCalled();
  });

  it(`every ensure failing (${DM_ENSURE_ATTEMPTS} attempts) gives the text back`, async () => {
    const ensureDm = vi.fn(async () => ({ message: 'refused' }));
    const d = deps({ roster: [], ensureDm });
    queuePersonMessage(message(), d);
    await flush();
    expect(ensureDm).toHaveBeenCalledTimes(DM_ENSURE_ATTEMPTS);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.onEnsureFailed).toHaveBeenCalledTimes(1);
    expect(d.onEnsureFailed.mock.calls[0]?.[1]).toBe('refused');
  });

  it('a source queues the quote; the record goes through chat_private_reply_send', async () => {
    const d = deps();
    queuePersonMessage(message({ source: SOURCES.comment }), d);
    const entry = d.enqueue.mock.calls[0]?.[1] as OutboxEntry;
    expect(entry.local.privateReply).toEqual(privateReplyFromDraft(SOURCES.comment));
    // The send flow hands kind + source id to the record (chat_private_reply_send).
    const recordMessage = vi.fn(() => new Promise<never>(() => undefined));
    const flow: SendFlowDeps = {
      recordMessage,
      publishLive: vi.fn(async () => ({})),
      onLiveWarning: vi.fn(),
    } as unknown as SendFlowDeps;
    void runSend(flow, {
      id: entry.id,
      channelId: DM,
      currentUserId: ME,
      traceId: 'trace-1',
      text: entry.text,
      local: entry.local,
      channelType: 'dm',
    });
    await flush();
    expect(recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ privateReply: { kind: 'comment', sourceId: 'c-1' } }),
    );
  });

  it('no source: the record carries no privateReply (plain chat send)', async () => {
    const d = deps();
    queuePersonMessage(message(), d);
    const entry = d.enqueue.mock.calls[0]?.[1] as OutboxEntry;
    const recordMessage = vi.fn(() => new Promise<never>(() => undefined));
    const flow = {
      recordMessage,
      publishLive: vi.fn(async () => ({})),
      onLiveWarning: vi.fn(),
    } as unknown as SendFlowDeps;
    void runSend(flow, {
      id: entry.id,
      channelId: DM,
      currentUserId: ME,
      traceId: 'trace-1',
      text: entry.text,
      local: entry.local,
      channelType: 'dm',
    });
    await flush();
    expect(recordMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ privateReply: expect.anything() }),
    );
  });
});

describe('usePersonMessageSend', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let send: ReturnType<typeof usePersonMessageSend> | null = null;

  function Probe(): null {
    send = usePersonMessageSend();
    return null;
  }

  beforeEach(() => {
    h.roster = ROSTER;
    h.hasStore = true;
    h.enqueue.mockReset();
    h.reloadRoster.mockClear();
    h.toast.mockClear();
    h.navigate.mockReset();
    h.startDmChannel.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Probe />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    send = null;
    document.body.innerHTML = '';
  });

  function lastToast(): { title: string; action?: { label: string; onPress: () => void } } {
    return h.toast.mock.calls.at(-1)?.[0] as never;
  }

  it('queues, then toasts "Sent to <first name>" with Open chat to that DM', () => {
    const giveBack = vi.fn();
    expect(send?.(message(), giveBack)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledWith(DM, expect.objectContaining({ text: 'On it' }));
    const toast = lastToast();
    expect(toast.title).toBe(sentToTitle('Asha'));
    expect(toast.title).toBe('Sent to Asha');
    expect(toast.action?.label).toBe(OPEN_CHAT);
    expect(toast.action?.label).toBe('Open chat');
    toast.action?.onPress();
    expect(h.navigate).toHaveBeenCalledWith(chatMessageHref(DM, null));
    expect(giveBack).not.toHaveBeenCalled();
  });

  it('a missing DM is ensured after the send returns; Open chat opens it', async () => {
    h.roster = [];
    act(() => root?.render(<Probe />));
    h.startDmChannel.mockImplementation(
      async (_client: unknown, _params: unknown, onOpen: (id: string) => void) => {
        // The rpc answers later: the send has already returned.
        await Promise.resolve();
        onOpen('dm-new');
        return null;
      },
    );
    expect(send?.(message(), vi.fn())).toBe(true);
    expect(h.enqueue).not.toHaveBeenCalled();
    await act(async () => {
      await flush();
    });
    expect(h.startDmChannel).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: WS, peerUserId: PEER }),
      expect.any(Function),
    );
    expect(h.enqueue).toHaveBeenCalledWith('dm-new', expect.objectContaining({ text: 'On it' }));
    expect(h.reloadRoster).toHaveBeenCalled();
    lastToast().action?.onPress();
    expect(h.navigate).toHaveBeenCalledWith(chatMessageHref('dm-new', null));
  });

  it('an ensure that never succeeds toasts MENTION_DM_FAILED and gives the text back', async () => {
    vi.useFakeTimers();
    try {
      h.roster = [];
      act(() => root?.render(<Probe />));
      h.startDmChannel.mockImplementation(async () => ({ message: 'refused' }));
      const giveBack = vi.fn();
      send?.(message({ text: 'Keep me' }), giveBack);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(h.startDmChannel).toHaveBeenCalledTimes(DM_ENSURE_ATTEMPTS);
      expect(giveBack).toHaveBeenCalledWith('Keep me');
      expect(lastToast().title).toBe(MENTION_DM_FAILED);
      expect(h.enqueue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('outside a chat store nothing sends and no toast shows', () => {
    h.hasStore = false;
    act(() => root?.render(<Probe />));
    expect(send?.(message(), vi.fn())).toBe(false);
    expect(h.toast).not.toHaveBeenCalled();
  });
});
