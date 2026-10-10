import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DUE_LIMIT,
  PUBLISH_CHUNK_SIZE,
  PUBLISH_DEADLINE_MS,
  RUN_BUDGET_MS,
  publishTarget,
  runScheduledSend,
  scheduledLiveExt,
  type ChannelRoute,
  type DispatchedRow,
  type ScheduledReader,
  type ScheduledSendDeps,
} from './chat-scheduled-send';
import { AgoraRestError, type AgoraMessageApi, type AgoraTextMessage } from './chat-agora-rest';
import { toAgoraUsername } from './agora-identity';
import {
  rowToThreadMessage,
  sendText,
  setLiveWorkspaceId,
  type ChatMessageRow,
  type CreateTextMessage,
  type ThreadConnection,
} from '@/lib/chat/thread';

const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const SENDER = '22222222-2222-7222-8222-222222222222';
const PEER = '33333333-3333-7333-8333-333333333333';
const DM_CHANNEL = `dm__${SENDER}__${PEER}`;
const GROUP_CHANNEL = 'group__44444444-4444-7444-8444-444444444444__grp';
const UNSYNCED_GROUP = 'group__44444444-4444-7444-8444-444444444444__new';
const AGORA_GROUP_ID = '170000000000000001';
const ASSET = '55555555-5555-7555-8555-555555555555';
const POST = '66666666-6666-7666-8666-666666666666';

function row(id: string, channelId: string, over: Partial<DispatchedRow> = {}): DispatchedRow {
  return {
    agora_event_id: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    body: `body ${id}`,
    channel_id: channelId,
    created_at: '2026-10-03T08:00:00.000000+00:00',
    deleted_at: null,
    edited_at: null,
    forwarded_from_message_id: null,
    id,
    mentions: null,
    reply_to_message_id: null,
    sender_user_id: SENDER,
    shared_brief_ids: null,
    shared_plan_ids: null,
    shared_post_ids: null,
    thread_root_message_id: null,
    workspace_id: WORKSPACE,
    ...over,
  };
}

const ROUTES: ChannelRoute[] = [
  {
    channelId: DM_CHANNEL,
    channelType: 'dm',
    agoraGroupId: null,
    dmUserA: SENDER,
    dmUserB: PEER,
  },
  {
    channelId: GROUP_CHANNEL,
    channelType: 'group',
    agoraGroupId: AGORA_GROUP_ID,
    dmUserA: null,
    dmUserB: null,
  },
  {
    channelId: UNSYNCED_GROUP,
    channelType: 'group',
    agoraGroupId: null,
    dmUserA: null,
    dmUserB: null,
  },
];

interface Harness {
  deps: ScheduledSendDeps;
  listDue: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  getChannels: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function harness(opts: {
  due: string[];
  rows: Record<string, DispatchedRow | null | Error>;
  sendMessage?: (message: AgoraTextMessage, traceId: string) => Promise<void>;
  now?: () => number;
}): Harness {
  const listDue = vi.fn(() => Promise.resolve(opts.due));
  const dispatch = vi.fn((id: string) => {
    const value = opts.rows[id];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? null);
  });
  const getChannels = vi.fn((ids: string[]) =>
    Promise.resolve(
      new Map(ROUTES.filter((r) => ids.includes(r.channelId)).map((r) => [r.channelId, r])),
    ),
  );
  const sendMessage = vi.fn(opts.sendMessage ?? (() => Promise.resolve()));
  const reader: ScheduledReader = { listDue, dispatch, getChannels };
  const agora: AgoraMessageApi = { sendMessage };
  let n = 0;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    deps: {
      reader,
      agora,
      newTraceId: () => `trace-${(n += 1)}`,
      now: opts.now ?? (() => 0),
      log,
    },
    listDue,
    dispatch,
    getChannels,
    sendMessage,
    log,
  };
}

/** Every log context, flattened to one string (no message body may appear). */
function allLogText(log: Harness['log']): string {
  return JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
}

afterEach(() => setLiveWorkspaceId(null));

describe('runScheduledSend', () => {
  it('due -> dispatch -> publish a DM to the other participant as the sender', async () => {
    const h = harness({ due: ['m1'], rows: { m1: row('m1', DM_CHANNEL) } });
    const summary = await runScheduledSend(h.deps);

    expect(h.listDue).toHaveBeenCalledWith(DUE_LIMIT, 'trace-1');
    expect(h.dispatch).toHaveBeenCalledWith('m1', 'trace-2');
    expect(h.getChannels).toHaveBeenCalledWith([DM_CHANNEL], 'trace-1');
    expect(h.sendMessage).toHaveBeenCalledWith(
      {
        from: toAgoraUsername(SENDER),
        to: toAgoraUsername(PEER),
        chatType: 'singleChat',
        msg: 'body m1',
        ext: scheduledLiveExt(row('m1', DM_CHANNEL)),
      },
      'trace-2',
    );
    expect(summary).toMatchObject({ due: 1, sent: 1, published: 1, publish_failures: 0 });
    expect(allLogText(h.log)).not.toContain('body m1');
  });

  it('publishes a group message to the synced Agora group', async () => {
    const h = harness({ due: ['g1'], rows: { g1: row('g1', GROUP_CHANNEL) } });
    await runScheduledSend(h.deps);
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        from: toAgoraUsername(SENDER),
        to: AGORA_GROUP_ID,
        chatType: 'groupChat',
      }),
      'trace-2',
    );
  });

  it('logs and continues when dispatch returns no row', async () => {
    const h = harness({ due: ['gone', 'm2'], rows: { gone: null, m2: row('m2', DM_CHANNEL) } });
    const summary = await runScheduledSend(h.deps);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ due: 2, sent: 1, not_sent: 1, published: 1 });
    expect(h.log.info).toHaveBeenCalledWith(
      'chat_scheduled_send dispatch returned no row',
      expect.objectContaining({ scheduled_id: 'gone', trace_id: 'trace-2' }),
    );
  });

  it('a dispatch error never stops the batch', async () => {
    const h = harness({
      due: ['bad', 'm2'],
      rows: { bad: new Error('boom'), m2: row('m2', DM_CHANNEL) },
    });
    const summary = await runScheduledSend(h.deps);
    expect(summary).toMatchObject({ dispatch_errors: 1, sent: 1, published: 1 });
  });

  it('a publish failure is logged with its trace id and the run continues', async () => {
    const h = harness({
      due: ['m1', 'm2'],
      rows: { m1: row('m1', DM_CHANNEL), m2: row('m2', GROUP_CHANNEL) },
      sendMessage: (message) =>
        message.chatType === 'singleChat'
          ? Promise.reject(new AgoraRestError('send_message', 403, 'forbidden'))
          : Promise.resolve(),
    });
    const summary = await runScheduledSend(h.deps);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ sent: 2, published: 1, publish_failures: 1 });
    expect(h.log.error).toHaveBeenCalledWith(
      'chat_scheduled_send publish failed',
      expect.objectContaining({
        trace_id: 'trace-2',
        message_id: 'm1',
        operation: 'send_message',
        status: 403,
      }),
    );
    // Dispatch is never repeated after a publish failure.
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('skips the publish for a group with no agora_group_id yet', async () => {
    const h = harness({
      due: ['u1', 'm2'],
      rows: { u1: row('u1', UNSYNCED_GROUP), m2: row('m2', DM_CHANNEL) },
    });
    const summary = await runScheduledSend(h.deps);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ sent: 2, published: 1, skipped_groups: 1 });
    expect(h.log.info).toHaveBeenCalledWith(
      'chat_scheduled_send publish skipped (group not synced)',
      expect.objectContaining({ message_id: 'u1', channel_id: UNSYNCED_GROUP }),
    );
  });

  it('stops picking new items once the 45 s budget is spent', async () => {
    let clock = 0;
    const due = ['a', 'b', 'c', 'd'];
    const h = harness({
      due,
      rows: Object.fromEntries(due.map((id) => [id, row(id, DM_CHANNEL)])),
      now: () => clock,
    });
    h.dispatch.mockImplementation((id: string) => {
      clock += RUN_BUDGET_MS / 2;
      return Promise.resolve(row(id, DM_CHANNEL));
    });
    const summary = await runScheduledSend(h.deps);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ due: 4, sent: 2, published: 2, deferred: 2 });
  });

  it('leaves dispatched rows to catch-up once the publish deadline passes', async () => {
    let clock = 0;
    const h = harness({
      due: ['a', 'b'],
      rows: { a: row('a', DM_CHANNEL), b: row('b', DM_CHANNEL) },
      now: () => clock,
      sendMessage: () => {
        clock = PUBLISH_DEADLINE_MS;
        return Promise.resolve();
      },
    });
    const summary = await runScheduledSend(h.deps);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ sent: 2, published: 1, publish_failures: 1 });
    expect(h.log.warn).toHaveBeenCalledWith(
      'chat_scheduled_send publish skipped',
      expect.objectContaining({ message_id: 'b', reason: 'run_deadline' }),
    );
  });

  it('reads channel routes once per chunk and caches them for the run', async () => {
    const due = Array.from({ length: PUBLISH_CHUNK_SIZE + 2 }, (_, i) => `m${i}`);
    const h = harness({
      due,
      rows: Object.fromEntries(
        due.map((id, i) => [id, row(id, i % 2 === 0 ? DM_CHANNEL : GROUP_CHANNEL)]),
      ),
    });
    const summary = await runScheduledSend(h.deps);
    expect(h.getChannels).toHaveBeenCalledTimes(1);
    expect(h.getChannels).toHaveBeenCalledWith([DM_CHANNEL, GROUP_CHANNEL], 'trace-1');
    expect(summary.published).toBe(due.length);
  });

  it('a failed due read ends the run without throwing', async () => {
    const h = harness({ due: [], rows: {} });
    h.listDue.mockRejectedValueOnce(new Error('db down'));
    const summary = await runScheduledSend(h.deps);
    expect(summary.due).toBe(0);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.log.error).toHaveBeenCalledWith(
      'chat_scheduled_send due read failed',
      expect.objectContaining({ trace_id: 'trace-1' }),
    );
  });

  it('logs the run summary under the run trace id', async () => {
    const h = harness({ due: ['m1'], rows: { m1: row('m1', DM_CHANNEL) } });
    await runScheduledSend(h.deps);
    expect(h.log.info).toHaveBeenCalledWith(
      'chat_scheduled_send run complete',
      expect.objectContaining({
        trace_id: 'trace-1',
        due: 1,
        sent: 1,
        publish_failures: 0,
        skipped_groups: 0,
      }),
    );
  });
});

describe('publishTarget', () => {
  it('routes a DM to whichever participant is not the sender', () => {
    const route = ROUTES[0] as ChannelRoute;
    expect(publishTarget({ ...route, dmUserA: PEER, dmUserB: SENDER }, SENDER)).toEqual({
      ok: true,
      to: toAgoraUsername(PEER),
      chatType: 'singleChat',
    });
    expect(publishTarget({ ...route, dmUserB: null }, SENDER)).toEqual({
      ok: false,
      reason: 'no_peer',
    });
  });
});

describe('scheduledLiveExt parity with the client sendText', () => {
  /** The ext the client's sendText puts on the wire for the content of `r`. */
  async function clientExt(r: DispatchedRow): Promise<unknown> {
    const message = rowToThreadMessage(r as ChatMessageRow, SENDER);
    const reply =
      message.reply !== null
        ? {
            ...message.reply,
            ...(typeof message.threadRootId === 'string' ? { rootId: message.threadRootId } : {}),
          }
        : null;
    let sent: { ext?: unknown } | undefined;
    const connection = {
      send: (m: unknown) => {
        sent = m as { ext?: unknown };
        return Promise.resolve({});
      },
    } as unknown as ThreadConnection;
    const createMessage = ((options: unknown) => options) as unknown as CreateTextMessage;
    setLiveWorkspaceId(r.workspace_id);
    await sendText({
      connection,
      target: { targetId: toAgoraUsername(PEER), chatType: 'singleChat' },
      text: r.body ?? '',
      attachments: message.attachments,
      sharedPostIds: message.sharedPostIds,
      reply,
      createMessage,
      liveIds: { sorted_message_id: r.id, sorted_channel_id: r.channel_id },
    });
    return sent?.ext;
  }

  it('matches for a plain text row', async () => {
    const r = row('m1', DM_CHANNEL);
    expect(scheduledLiveExt(r)).toEqual(await clientExt(r));
  });

  it('matches for attachments, shared posts and a reply in a thread', async () => {
    const r = row('m2', GROUP_CHANNEL, {
      attachment_asset_ids: [ASSET],
      attachment_meta: {
        [ASSET]: {
          mime: 'audio/webm',
          name: 'voice.webm',
          size: 1200,
          duration_ms: 7000,
          peaks: [1, 50, 100],
        },
      },
      shared_post_ids: [POST],
      shared_brief_ids: ['77777777-7777-7777-8777-777777777777'],
      reply_to_message_id: 'parent-id',
      thread_root_message_id: 'root-id',
      mentions: [PEER],
      body: `hi @[${PEER}]`,
    });
    const ext = scheduledLiveExt(r);
    expect(ext).toEqual(await clientExt(r));
    expect(ext).toMatchObject({
      sorted_message_id: 'm2',
      sorted_channel_id: GROUP_CHANNEL,
      sorted_workspace_id: WORKSPACE,
      sorted_thread_root_id: 'root-id',
      attachment_asset_ids: [ASSET],
      shared_post_ids: [POST],
      reply_to: { id: 'parent-id', author_user_id: null, preview: '' },
    });
  });
});
