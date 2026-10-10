// A pending own bubble's time: the estimated server time of the Send tap
// (device clock + the server offset), never another message's time and never
// epoch; its day pill shows at send; it is placed among recorded rows by that
// time, so neither a failed bubble, a Retry nor the record moves it past a
// neighbour; the recorded row replaces it in place with the same id.

import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the real agora-chat browser SDK; mock it
// so importing the module in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import {
  rowToThreadMessage,
  upsertMessage,
  withOutboxBubbles,
  type ChatMessageRow,
  type ThreadMessage,
  type UnrecordedSend,
} from '@/lib/chat/thread';
import { withDaySeparators } from '@/components/chat/day-separators';
import { bubbleMeta, messageTimeSource } from '@/components/chat/MessageThread';
import { formatClockTime } from '@/lib/chat/time-format';
import {
  applyServerClock,
  initialState,
  outboxRecorded,
  serverNowMs,
  readPersistedOutbox,
  stampMissingCreatedMs,
  writePersistedOutbox,
  type OutboxEntry,
  type OutboxStorage,
} from '@/lib/chat/chat-store';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const TZ = 'UTC';

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'r',
    channel_id: 'c1',
    workspace_id: 'ws',
    sender_user_id: PEER,
    body: 'hello',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    shared_plan_ids: null,
    reply_to_message_id: null,
    thread_root_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-29T21:00:00+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function send(id: string, createdMs: number): UnrecordedSend {
  return {
    id,
    text: `body ${id}`,
    local: { attachments: [], sharedPostIds: [], reply: null },
    state: 'sending',
    createdMs,
  };
}

const YESTERDAY_ROW = rowToThreadMessage(row({ id: 'y1' }), ME);
const TAP = Date.parse('2026-09-30T09:15:00Z');

function recordedAt(id: string, ms: number, sender = ME): ThreadMessage {
  return rowToThreadMessage(
    row({ id, sender_user_id: sender, created_at: new Date(ms).toISOString() }),
    ME,
  );
}

const ids = (list: readonly ThreadMessage[]): string[] => list.map((m) => m.id);

describe('pending bubble time', () => {
  it('the optimistic time is the estimated tap time, not the previous message time + 1ms', () => {
    const [, pending] = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP)], ME);
    expect(pending?.estimatedMs).toBe(TAP);
    expect(pending?.time).toBe(TAP);
    expect(messageTimeSource(pending as ThreadMessage)).toBe(TAP);
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: true }).time).toBe(
      formatClockTime(TAP, TZ),
    );
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: true }).time).not.toBe(
      formatClockTime(YESTERDAY_ROW.time + 1, TZ),
    );
  });

  it('an empty chat never shows epoch', () => {
    const [pending] = withOutboxBubbles([], [send('p1', TAP)], ME);
    expect(pending?.time).toBe(TAP);
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: false }).time).toBe(
      formatClockTime(TAP, TZ),
    );
  });

  it('a first-of-day send shows the "Today" pill before its row lands', () => {
    const list = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP)], ME);
    const items = withDaySeparators(list, TAP + 60_000, TZ);
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.message.id))).toEqual([
      'Yesterday',
      'y1',
      'Today',
      'p1',
    ]);
  });

  it('the recorded row replaces the bubble in place with the same id', () => {
    const list = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP), send('p2', TAP + 1)], ME);
    // p2 was tapped before p1's row landed (TAP + 400): the sender re-stamps
    // what was queued behind p1 to just after it, and the thread lays it back.
    const outbox = outboxRecorded(
      { c1: [send('p1', TAP), send('p2', TAP + 1)] },
      'c1',
      'p1',
      TAP + 400,
    );
    expect(outbox.c1?.map((e) => [e.id, e.createdMs])).toEqual([['p2', TAP + 401]]);
    const next = withOutboxBubbles(
      upsertMessage(list, recordedAt('p1', TAP + 400)),
      outbox.c1 ?? [],
      ME,
    );
    expect(ids(next)).toEqual(['y1', 'p1', 'p2']);
    expect(next[1]?.state).toBe('sent');
    expect(bubbleMeta(next[1] as ThreadMessage, TZ, { showTicks: true }).time).toBe(
      bubbleMeta(list[1] as ThreadMessage, TZ, { showTicks: true }).time,
    );
  });
});

describe('F3 positions never jump', () => {
  const failed = (id: string, createdMs: number): UnrecordedSend => ({
    ...send(id, createdMs),
    state: 'failed',
  });

  it('a failed m1 stays above m2 and m3 as they record', () => {
    let list = withOutboxBubbles(
      [YESTERDAY_ROW],
      [failed('m1', TAP), send('m2', TAP + 1_000), send('m3', TAP + 2_000)],
      ME,
    );
    expect(ids(list)).toEqual(['y1', 'm1', 'm2', 'm3']);
    list = upsertMessage(list, recordedAt('m2', TAP + 1_150));
    list = upsertMessage(list, recordedAt('m3', TAP + 2_150));
    expect(ids(list)).toEqual(['y1', 'm1', 'm2', 'm3']);
    expect(list[1]?.state).toBe('failed');
    // A later fold (catch-up) lays the outbox over the same list: still in place.
    list = withOutboxBubbles(list, [failed('m1', TAP)], ME, TAP + 99_000);
    expect(ids(list)).toEqual(['y1', 'm1', 'm2', 'm3']);
  });

  it('Retry moves it to the bottom at the tap; its record does not move it', () => {
    let list = withOutboxBubbles([YESTERDAY_ROW], [failed('m1', TAP)], ME);
    list = upsertMessage(list, recordedAt('m2', TAP + 1_150));
    list = upsertMessage(list, recordedAt('m3', TAP + 2_150));
    // The Retry tap re-stamps m1 with the estimated time now.
    const retryAt = TAP + 60_000;
    list = withOutboxBubbles(list, [send('m1', retryAt)], ME);
    expect(ids(list)).toEqual(['y1', 'm2', 'm3', 'm1']);
    list = upsertMessage(list, recordedAt('m1', retryAt + 350));
    expect(ids(list)).toEqual(['y1', 'm2', 'm3', 'm1']);
    expect(list[3]?.state).toBe('sent');
  });

  it('a peer row recorded after my tap stays below my bubble when my server time is earlier', () => {
    let list = withOutboxBubbles([YESTERDAY_ROW], [send('mine', TAP)], ME);
    list = upsertMessage(list, recordedAt('peer', TAP + 30_000, PEER));
    expect(ids(list)).toEqual(['y1', 'mine', 'peer']);
    list = upsertMessage(list, recordedAt('mine', TAP + 400));
    expect(ids(list)).toEqual(['y1', 'mine', 'peer']);
  });
});

describe('F4 clock skew', () => {
  it('device clock 7 min fast: once the offset is sampled the label is within a minute of the record', () => {
    const SKEW = 7 * 60_000;
    // The first send of the session samples: sent at device time server + 7min.
    const firstServer = Date.parse('2026-09-30T09:00:00.000Z');
    const state = applyServerClock(
      initialState(),
      new Date(firstServer).toISOString(),
      firstServer + SKEW,
    );
    expect(state.serverClockOffsetMs).toBe(-SKEW);
    // The next tap at device time D is stamped D + offset.
    const deviceTap = firstServer + SKEW + 90_000;
    const [pending] = withOutboxBubbles([], [send('p1', serverNowMs(state, deviceTap))], ME);
    const serverCreated = firstServer + 90_000 + 300;
    const [recorded] = upsertMessage([pending as ThreadMessage], recordedAt('p1', serverCreated));
    expect(Math.abs(serverCreated - (pending?.time ?? 0))).toBeLessThan(60_000);
    expect(
      Math.abs(
        Date.parse(recorded?.createdAt ?? '') - Number(messageTimeSource(pending as ThreadMessage)),
      ),
    ).toBeLessThan(60_000);
    // Without the offset the label would read 7 minutes off.
    expect(Math.abs(serverCreated - deviceTap)).toBeGreaterThan(6 * 60_000);
  });
});

describe('F7c legacy entries get a time once', () => {
  it('a restored entry without createdMs is stamped at restore, persisted, and stable across folds', () => {
    const data = new Map<string, string>();
    const storage: OutboxStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
    const scope = { workspaceId: 'ws', userId: ME };
    const legacy: OutboxEntry = {
      id: 'old',
      text: 'queued before tap times',
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'sending',
    };
    writePersistedOutbox(storage, scope, { c1: [legacy] });
    const read = readPersistedOutbox(storage, scope);
    expect(read.c1?.[0]?.createdMs).toBeUndefined();
    const stamped = stampMissingCreatedMs(read, TAP);
    expect(stamped.c1?.[0]?.createdMs).toBe(TAP);
    expect(stampMissingCreatedMs(stamped, TAP + 5)).toBe(stamped);
    writePersistedOutbox(storage, scope, stamped);
    const entries = readPersistedOutbox(storage, scope).c1 ?? [];
    const first = withOutboxBubbles([YESTERDAY_ROW], entries, ME, TAP + 60_000);
    const second = withOutboxBubbles(first, entries, ME, TAP + 120_000);
    expect(first[1]?.time).toBe(TAP);
    expect(second[1]?.time).toBe(TAP);
    expect(messageTimeSource(second[1] as ThreadMessage)).toBe(TAP);
  });
});
