// Fix round 2 on "sends never visibly fail": one clock offset (G1), the
// guarded sampler's serverClockOffsetMs, stamps every pending send, and a
// replayed record never moves it; a record never re-stamps a refused send
// queued behind it (G2).

import { describe, expect, it } from 'vitest';
import {
  applyServerClock,
  createClockSampler,
  initialState,
  outboxRecorded,
  recordWithClockSample,
  serverNowMs,
  stampMissingCreatedMs,
  type ChatStoreState,
  type OutboxEntry,
} from '@/lib/chat/chat-store';
import { createOutboxSender } from '@/lib/chat/send-flow';
import {
  rowToThreadMessage,
  upsertMessage,
  withOutboxBubbles,
  type ChatMessageRow,
} from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'c1';
const HOUR = 60 * 60_000;

function row(id: string, createdMs: number): ChatMessageRow {
  return {
    id,
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: ME,
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
    created_at: new Date(createdMs).toISOString(),
    edited_at: null,
    deleted_at: null,
  };
}

function entry(id: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    text: `body ${id}`,
    local: { attachments: [], sharedPostIds: [], reply: null },
    state: 'sending',
    ...over,
  };
}

/** The provider's record wiring: sample through the guarded sampler into the store state. */
function recorder(deviceNow: () => number) {
  const sampler = createClockSampler(deviceNow);
  let state: ChatStoreState = initialState();
  const record = (id: string, serverCreatedMs: number) =>
    recordWithClockSample(
      sampler,
      id,
      async () => ({ ok: true as const, row: row(id, serverCreatedMs) }),
      (createdAt, sentAt) => {
        state = applyServerClock(state, createdAt, sentAt);
      },
    );
  return { sampler, record, state: () => state };
}

describe('G1 one guarded clock offset', () => {
  it('a replayed record (same id, created_at 1h earlier) does not change the offset the next send uses', async () => {
    let device = Date.parse('2026-09-30T10:00:00Z');
    const clock = recorder(() => device);
    // A fresh send samples: server is 2s behind the device.
    clock.sampler.fresh('m1');
    await clock.record('m1', device - 2_000);
    expect(clock.state().serverClockOffsetMs).toBe(-2_000);
    // m0 was committed an hour ago; its ack was lost and it replays now
    // (a persisted entry is never fresh), getting the original created_at.
    device += 60_000;
    await clock.record('m0', device - HOUR);
    // A lost-ack retry of a fresh id: the first attempt settled it, so the retry cannot sample.
    clock.sampler.fresh('m2');
    await recordWithClockSample(
      clock.sampler,
      'm2',
      async () => ({ ok: false as const }),
      () => {
        throw new Error('a failed attempt never samples');
      },
    );
    await clock.record('m2', device - HOUR);
    expect(clock.state().serverClockOffsetMs).toBe(-2_000);
    // The next send is stamped device time + the guarded offset.
    expect(serverNowMs(clock.state(), device)).toBe(device - 2_000);
  });

  it('a fresh load with a sampler value places the first send at device time + that offset', () => {
    const device = Date.parse('2026-09-30T10:00:00Z');
    const state = { ...initialState(), serverClockOffsetMs: -90_000 };
    const stamped = serverNowMs(state, device);
    expect(stamped).toBe(device - 90_000);
    const [bubble] = withOutboxBubbles([], [entry('p1', { createdMs: stamped })], ME);
    expect(bubble?.time).toBe(device - 90_000);
    // The restore stamp (F7c) and the Retry re-stamp read the same clock.
    const legacy = stampMissingCreatedMs({ [CHANNEL]: [entry('old')] }, serverNowMs(state, device));
    expect(legacy[CHANNEL]?.[0]?.createdMs).toBe(device - 90_000);
    const sender = createOutboxSender(
      {
        deliver: async () => ({
          ok: false,
          reason: 'error',
          error: 'refused',
          errorClass: 'permanent',
        }),
        newTraceId: () => 't',
        onEvent: () => {},
        onChange: () => {},
        onAttemptFailed: () => {},
        now: () => serverNowMs(state, device + 5_000),
      },
      { [CHANNEL]: [entry('f1', { state: 'failed', createdMs: 1 })] },
    );
    sender.retry(CHANNEL, 'f1');
    expect(sender.entries(CHANNEL)[0]?.createdMs).toBe(device + 5_000 - 90_000);
    sender.dispose();
  });

  it('no sampler value: the first send is stamped at device time', () => {
    const device = Date.parse('2026-09-30T10:00:00Z');
    expect(initialState().serverClockOffsetMs).toBe(0);
    expect(serverNowMs(initialState(), device)).toBe(device);
  });
});

describe('G2 a record never re-stamps a refused send', () => {
  it('two failed, Retry the first, record it: the second keeps its createdMs and position', () => {
    const m1 = entry('m1', { state: 'failed', createdMs: 1_000 });
    const m2 = entry('m2', { state: 'failed', createdMs: 2_000 });
    // Retry re-stamps m1 to the bottom; it stays first in queue order.
    const retried = { ...m1, state: 'sending' as const, createdMs: 9_000 };
    let list = withOutboxBubbles([], [retried, m2], ME);
    expect(list.map((m) => m.id)).toEqual(['m2', 'm1']);
    const after = outboxRecorded({ [CHANNEL]: [retried, m2] }, CHANNEL, 'm1', 9_300);
    expect(after[CHANNEL]).toEqual([m2]);
    list = withOutboxBubbles(
      upsertMessage(list, rowToThreadMessage(row('m1', 9_300), ME)),
      after[CHANNEL] ?? [],
      ME,
    );
    expect(list.map((m) => [m.id, m.state])).toEqual([
      ['m2', 'failed'],
      ['m1', 'sent'],
    ]);
    expect(list[0]?.time).toBe(2_000);
  });

  it('a pending send behind the recorded one is still kept after it', () => {
    const after = outboxRecorded(
      { [CHANNEL]: [entry('p1', { createdMs: 1_000 }), entry('p2', { createdMs: 1_001 })] },
      CHANNEL,
      'p1',
      1_400,
    );
    expect(after[CHANNEL]?.map((e) => [e.id, e.createdMs])).toEqual([['p2', 1_401]]);
  });
});
