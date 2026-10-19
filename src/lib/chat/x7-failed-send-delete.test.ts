// X7 fix 4 (FB5): every failed own send can be deleted, files included. A
// permanent refusal (file_too_large and the other file refusals, other
// non-retryable 4xx) carries its reason in plain words and offers no Retry;
// Delete removes the outbox entry (so its persisted copy and stored files go).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { uploadErrorMessage } from '@/lib/asset-upload';
import {
  outboxSetState,
  readPersistedOutbox,
  writePersistedOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxEvent,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import { createOutboxSender } from '@/lib/chat/send-flow';
import {
  RECORD_REFUSED,
  UPLOAD_REFUSED,
  classifyUploadFailure,
  refusalReason,
} from '@/lib/chat/send-errors';
import { setMessageState, withOutboxBubbles, type ThreadMessage } from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const SCOPE = { workspaceId: 'ws', userId: ME };

function memoryStorage(): OutboxStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function withFile(id: string): OutboxEntry {
  const file = new File([new Uint8Array(8)], 'big.mov', { type: 'video/quicktime' });
  return {
    id,
    text: '',
    local: {
      attachments: [
        {
          assetId: '',
          name: 'big.mov',
          mime: 'video/quicktime',
          local: { key: `k-${id}`, file, previewUrl: null, progress: 0 },
        },
      ],
      sharedPostIds: [],
      reply: null,
    },
    state: 'sending',
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('X7 FB5: refusal reasons', () => {
  it('file refusals keep their own plain words; other refusals read a generic line', () => {
    const tooLarge = uploadErrorMessage('file_too_large');
    expect(classifyUploadFailure(tooLarge, 413)).toBe('permanent');
    expect(refusalReason('upload', tooLarge)).toBe(tooLarge);
    expect(refusalReason('upload', uploadErrorMessage('virus_detected'))).toBe(
      uploadErrorMessage('virus_detected'),
    );
    expect(refusalReason('upload', 'HTTP 403')).toBe(UPLOAD_REFUSED);
    expect(refusalReason('record', 'P0001 whatever')).toBe(RECORD_REFUSED);
    expect(UPLOAD_REFUSED).not.toMatch(/—/);
  });

  it('the refusal rides the failed state and clears on any other state', () => {
    const outbox: Outbox = { [CHANNEL]: [withFile('m1')] };
    const failed = outboxSetState(outbox, CHANNEL, 'm1', 'failed', 'Files up to 100MB only');
    expect(failed[CHANNEL]?.[0]?.refusal).toBe('Files up to 100MB only');
    const again = outboxSetState(failed, CHANNEL, 'm1', 'sending');
    expect(again[CHANNEL]?.[0]?.refusal).toBeUndefined();
    const bubbles = withOutboxBubbles([], failed[CHANNEL] ?? [], ME, 1000);
    expect(bubbles[0]?.refusal).toBe('Files up to 100MB only');
    const msg = bubbles[0] as ThreadMessage;
    expect(setMessageState([msg], 'm1', 'sending')[0]?.refusal).toBeUndefined();
  });
});

describe('X7 FB5: a failed send with a file can be deleted', () => {
  it('a permanent refusal fails the entry with its reason; Delete leaves no outbox entry', async () => {
    const storage = memoryStorage();
    const events: OutboxEvent[] = [];
    const upload = vi.fn(async () => ({
      ok: false as const,
      message: uploadErrorMessage('file_too_large'),
      status: 413,
    }));
    const deliver = vi.fn();
    const sender = createOutboxSender({
      deliver,
      newTraceId: () => 'trace-x7',
      onEvent: (event) => events.push(event),
      onChange: (next) => writePersistedOutbox(storage, SCOPE, next),
      onAttemptFailed: () => {},
      upload,
    });
    sender.enqueue(CHANNEL, withFile('m1'));
    await vi.waitFor(() => expect(sender.entries(CHANNEL)[0]?.state).toBe('failed'));
    expect(deliver).not.toHaveBeenCalled();
    expect(sender.entries(CHANNEL)[0]?.refusal).toBe('Files up to 100MB only');
    const stateEvent = events.find((e) => e.type === 'state' && e.state === 'failed');
    expect(stateEvent).toMatchObject({ refusal: 'Files up to 100MB only' });
    // The persisted copy exists while it is failed.
    expect(readPersistedOutbox(storage, SCOPE)[CHANNEL]?.map((e) => e.id)).toEqual(['m1']);

    sender.settle(CHANNEL, 'm1');
    expect(sender.entries(CHANNEL)).toEqual([]);
    expect(readPersistedOutbox(storage, SCOPE)[CHANNEL] ?? []).toEqual([]);
    // Nothing retries it afterwards.
    await new Promise((r) => setTimeout(r, 20));
    expect(upload).toHaveBeenCalledTimes(1);
    sender.dispose();
  });

  it('Delete on a send still uploading aborts that upload and frees the lane', async () => {
    let seenSignal: AbortSignal | undefined;
    const upload = vi.fn(
      (_file: File, _progress?: (f: number) => void, signal?: AbortSignal) =>
        new Promise<{ ok: false; message: string }>(() => {
          seenSignal = signal;
        }),
    );
    const sender = createOutboxSender({
      deliver: vi.fn(),
      newTraceId: () => 'trace-x7',
      onEvent: () => {},
      onChange: () => {},
      onAttemptFailed: () => {},
      upload,
    });
    sender.enqueue(CHANNEL, withFile('m1'));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    sender.settle(CHANNEL, 'm1');
    expect(seenSignal?.aborted).toBe(true);
    expect(sender.entries(CHANNEL)).toEqual([]);
    sender.dispose();
  });
});
