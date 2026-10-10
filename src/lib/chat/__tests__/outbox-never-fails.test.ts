// The outbox never shows a network problem: transient failures keep the entry
// pending (clock) and retry with no end, a kick retries at once, and only a
// permanent refusal turns it 'failed' ("Not sent" + Retry). Same id on every
// attempt, per-chat order held. Also the upload stall watch and voice notes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutboxSender,
  UPLOAD_STALL_MS,
  watchUploadStall,
  type OutboxSenderDeps,
  type SendOutcome,
} from '@/lib/chat/send-flow';
import type { Outbox, OutboxEntry, OutboxEvent } from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChatAttachmentUpload, MessageAttachment } from '@/lib/chat/attachments';
import { uploadErrorMessage, xhrPost } from '@/lib/asset-upload';
import { logger } from '@/lib/logger';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';

function row(id: string): ChatMessageRow {
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
    created_at: '2026-09-30T10:00:00+00:00',
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

type Step = 'ok' | 'transient' | 'permanent' | 'pending' | 'reject';

const TRANSIENT: SendOutcome = {
  ok: false,
  reason: 'error',
  error: 'TypeError: Failed to fetch',
  errorClass: 'transient',
};
const PERMANENT: SendOutcome = {
  ok: false,
  reason: 'error',
  error: 'not a member',
  errorClass: 'permanent',
};

/** A sender whose record attempts follow `script` per message id (then succeed). */
function harness(
  opts: {
    script?: Record<string, Step[]>;
    initial?: Outbox;
    deps?: Partial<OutboxSenderDeps>;
  } = {},
) {
  const script: Record<string, Step[]> = {};
  for (const [id, steps] of Object.entries(opts.script ?? {})) script[id] = [...steps];
  const calls: { id: string; traceId: string; entry: OutboxEntry }[] = [];
  const recordedIds: string[] = [];
  const events: OutboxEvent[] = [];
  const release = new Map<string, () => void>();
  let traceSeq = 0;
  const sender = createOutboxSender(
    {
      deliver: async (channelId, e, traceId, onRecorded) => {
        calls.push({ id: e.id, traceId, entry: e });
        const step = script[e.id]?.shift() ?? 'ok';
        if (step === 'transient') return TRANSIENT;
        if (step === 'permanent') return PERMANENT;
        if (step === 'reject') throw new Error('network down');
        if (step === 'pending') {
          await new Promise<void>((resolve) => release.set(e.id, resolve));
        }
        const message = rowToThreadMessage({ ...row(e.id), channel_id: channelId }, ME);
        recordedIds.push(e.id);
        onRecorded(message);
        return { ok: true, message, livePublished: true };
      },
      newTraceId: () => `trace-${(traceSeq += 1)}`,
      onEvent: (event) => events.push(event),
      onChange: () => {},
      onAttemptFailed: () => {},
      ...opts.deps,
    },
    opts.initial,
  );
  return { sender, calls, recordedIds, events, release };
}

function failedEvents(events: OutboxEvent[]): OutboxEvent[] {
  return events.filter((e) => e.type === 'state' && e.state === 'failed');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('outbox: transient never fails, permanent does', () => {
  it('transient failures past 120s stay pending with the clock, retrying every 30s', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({
      script: { m1: Array<Step>(40).fill('transient') },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    expect(failedEvents(events)).toEqual([]);
    expect(calls.length).toBeGreaterThan(30);
    sender.dispose();
  });

  it('a rejecting deliver (thrown network error) is transient too', async () => {
    vi.useFakeTimers();
    const { sender, events } = harness({ script: { m1: Array<Step>(40).fill('reject') } });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    expect(failedEvents(events)).toEqual([]);
    sender.dispose();
  });

  it('a failure with no class is treated as transient', async () => {
    vi.useFakeTimers();
    const { sender } = harness({
      deps: {
        deliver: async () => ({ ok: false, reason: 'timeout', error: 'rpc timed out' }),
      },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    sender.dispose();
  });

  it('a permanent failure marks failed at once, and the queue moves on to the next', async () => {
    vi.useFakeTimers();
    const { sender, calls, events, recordedIds } = harness({ script: { m1: ['permanent'] } });
    sender.enqueue(CHANNEL, entry('m1'));
    sender.enqueue(CHANNEL, entry('m2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: 'state', channelId: CHANNEL, id: 'm1', state: 'failed' });
    expect(sender.entries(CHANNEL).map((e) => [e.id, e.state])).toEqual([['m1', 'failed']]);
    expect(recordedIds).toEqual(['m2']);
    // Not retried on its own, not revived by a new send.
    sender.enqueue(CHANNEL, entry('m3'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.filter((c) => c.id === 'm1')).toHaveLength(1);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('failed');
  });

  it('manual Retry re-queues a failed entry with the same id', async () => {
    vi.useFakeTimers();
    const { sender, calls, recordedIds, events } = harness({ script: { m1: ['permanent'] } });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('failed');
    sender.retry(CHANNEL, 'm1');
    // Back to the clock at once, and attempted at once.
    expect(events.at(-2)).toEqual({
      type: 'state',
      channelId: CHANNEL,
      id: 'm1',
      state: 'sending',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordedIds).toEqual(['m1']);
    expect(calls.map((c) => c.id)).toEqual(['m1', 'm1']);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('kick on online / visible / connected retries at once instead of waiting out the backoff', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({
      script: { m1: ['transient', 'transient', 'transient', 'transient', 'transient'] },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    // Four failures in: the next wait is 30s.
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    expect(calls).toHaveLength(4);
    sender.kick();
    expect(calls).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(0);
    sender.kick();
    expect(calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('the same message id on every attempt, a fresh trace id each time', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({
      script: { m1: ['transient', 'reject', 'transient', 'ok'] },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.map((c) => c.id)).toEqual(['m1', 'm1', 'm1', 'm1']);
    expect(new Set(calls.map((c) => c.traceId)).size).toBe(4);
  });

  it('per-chat order held when the first entry is slow: the second waits', async () => {
    vi.useFakeTimers();
    const { sender, calls, recordedIds, release } = harness({
      script: { m1: ['transient', 'transient', 'pending'] },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    sender.enqueue(CHANNEL, entry('m2'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.every((c) => c.id === 'm1')).toBe(true);
    expect(recordedIds).toEqual([]);
    release.get('m1')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(recordedIds).toEqual(['m1', 'm2']);
  });
});

/** An attachment still to upload, with its File and an uploader. */
function fileAttachment(
  name: string,
  upload: (file: File, onProgress?: (f: number) => void) => Promise<ChatAttachmentUpload>,
  over: Partial<MessageAttachment> = {},
): MessageAttachment {
  return {
    assetId: '',
    name,
    mime: 'image/png',
    size: 3,
    local: {
      key: `local-${name}`,
      file: new File(['abc'], name, { type: over.mime ?? 'image/png' }),
      previewUrl: null,
      progress: 0,
      upload,
    },
    ...over,
  };
}

describe('upload stall', () => {
  /** A fake XHR: events on itself and on `upload`; abort fires abort + loadend. */
  class FakeXhr extends EventTarget {
    upload = new EventTarget();
    aborted = false;
    status = 0;
    responseText = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open(): void {}
    setRequestHeader(): void {}
    send(): void {
      this.upload.dispatchEvent(new Event('loadstart'));
    }
    abort(): void {
      this.aborted = true;
      this.onabort?.();
      this.dispatchEvent(new Event('loadend'));
    }
  }

  it('no progress for 30s aborts the XHR (a transport failure); progress keeps it alive', async () => {
    vi.useFakeTimers();
    const request = new FakeXhr();
    const watch = watchUploadStall(request);
    const posted = xhrPost('https://upload.test', {}, new FormData(), {
      traceId: 't',
      createRequest: () => request as unknown as XMLHttpRequest,
    });
    const outcome = posted.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    request.upload.dispatchEvent(new Event('progress'));
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    expect(request.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.aborted).toBe(true);
    expect(await outcome).toBe('rejected');
    // Stopped by its own abort: no timer left.
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop clears the timer and listeners', () => {
    vi.useFakeTimers();
    const request = new FakeXhr();
    const watch = watchUploadStall(request);
    expect(vi.getTimerCount()).toBe(1);
    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
    request.upload.dispatchEvent(new Event('progress'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stalled upload retries as transient; the later message in the chat records after it', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    // First attempt stalls: the watch aborts it at 30s and it fails like a network error.
    const upload = vi.fn(async (): Promise<ChatAttachmentUpload> => {
      attempt += 1;
      if (attempt === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, UPLOAD_STALL_MS));
        return { ok: false, message: uploadErrorMessage('network') };
      }
      return { ok: true, reused: false, versionId: 'ver-1' };
    });
    const { sender, recordedIds, events } = harness();
    sender.enqueue(
      CHANNEL,
      entry('m1', {
        local: { attachments: [fileAttachment('a.png', upload)], sharedPostIds: [], reply: null },
      }),
    );
    sender.enqueue(CHANNEL, entry('m2'));
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    expect(recordedIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recordedIds).toEqual(['m1', 'm2']);
    expect(failedEvents(events)).toEqual([]);
  });

  it("a Worker refusal of the file itself is permanent: 'failed', the rest go on", async () => {
    const upload = vi.fn(
      async (): Promise<ChatAttachmentUpload> => ({
        ok: false,
        message: uploadErrorMessage('virus_detected'),
      }),
    );
    const { sender, recordedIds } = harness();
    sender.enqueue(
      CHANNEL,
      entry('m1', {
        local: { attachments: [fileAttachment('a.png', upload)], sharedPostIds: [], reply: null },
      }),
    );
    sender.enqueue(CHANNEL, entry('m2'));
    await vi.waitFor(() => expect(recordedIds).toEqual(['m2']));
    expect(sender.entries(CHANNEL).map((e) => e.state)).toEqual(['failed']);
  });

  it('T4: a permanent upload refusal logs its reason once; a transient one does not', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const refused = vi.fn(
        async (): Promise<ChatAttachmentUpload> =>
          ({ ok: false, message: uploadErrorMessage('unsupported_mime'), status: 415 }) as never,
      );
      const { sender } = harness();
      sender.enqueue(
        CHANNEL,
        entry('m1', {
          local: {
            attachments: [
              fileAttachment('voice-note.m4a', refused, { mime: 'audio/mp4', durationMs: 1000 }),
            ],
            sharedPostIds: [],
            reply: null,
          },
        }),
      );
      await vi.waitFor(() => expect(sender.entries(CHANNEL)[0]?.state).toBe('failed'));
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      const [msg, context] = warn.mock.calls[0] ?? [];
      expect(msg).toBe('chat: upload refused');
      expect(context).toMatchObject({ status: 415, code: 'unsupported_mime' });
      expect(Object.keys(context ?? {}).sort()).toEqual(
        ['code', 'header_hex', 'mime', 'recorder_mime', 'size', 'status', 'user_agent'].sort(),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('voice notes in the outbox', () => {
  function voice(upload: (file: File) => Promise<ChatAttachmentUpload>): OutboxEntry {
    return entry('v1', {
      text: '',
      local: {
        attachments: [
          fileAttachment('voice-note.webm', upload, { mime: 'audio/webm', durationMs: 3000 }),
        ],
        sharedPostIds: [],
        reply: null,
      },
    });
  }

  it('enqueued pending at once; uploaded and recorded without any transcript', async () => {
    const upload = vi.fn(
      async (): Promise<ChatAttachmentUpload> => ({ ok: true, reused: false, versionId: 'ver-v' }),
    );
    const { sender, calls } = harness();
    sender.enqueue(CHANNEL, voice(upload));
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.entry.local.attachments[0]).toMatchObject({
      assetId: 'ver-v',
      durationMs: 3000,
    });
    expect(calls[0]?.entry.local.attachments[0]?.transcript).toBeUndefined();
  });

  it('records the moment the upload is done: no transcript wait', async () => {
    vi.useFakeTimers();
    const upload = vi.fn(async (): Promise<ChatAttachmentUpload> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 4_000));
      return { ok: true, reused: false, versionId: 'ver-v' };
    });
    const { sender, calls } = harness();
    sender.enqueue(CHANNEL, voice(upload));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entry.local.attachments[0]?.assetId).toBe('ver-v');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a transient upload failure keeps it pending, then records', async () => {
    vi.useFakeTimers();
    const upload = vi
      .fn<(file: File) => Promise<ChatAttachmentUpload>>()
      .mockResolvedValueOnce({ ok: false, message: uploadErrorMessage('network') })
      .mockResolvedValueOnce({ ok: false, message: uploadErrorMessage('network') })
      .mockResolvedValue({ ok: true, reused: false, versionId: 'ver-v' });
    const { sender, calls, events } = harness();
    sender.enqueue(CHANNEL, voice(upload));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(2_000 + 4_000);
    expect(failedEvents(events)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entry.local.attachments[0]).toMatchObject({ assetId: 'ver-v' });
  });
});

describe('restoring entries (files read back after a reload)', () => {
  it('holds its place without running, then resumes when its files are back', async () => {
    const upload = vi.fn(
      async (): Promise<ChatAttachmentUpload> => ({ ok: true, reused: false, versionId: 'ver-r' }),
    );
    const waiting = entry('r1', {
      local: {
        attachments: [{ assetId: '', name: 'a.png', mime: 'image/png', size: 3 }],
        sharedPostIds: [],
        reply: null,
      },
      restoring: true,
    });
    const { sender, calls, recordedIds } = harness({
      initial: { [CHANNEL]: [waiting, entry('m2')] },
      deps: { upload },
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    const restored: MessageAttachment[] = [
      {
        assetId: '',
        name: 'a.png',
        mime: 'image/png',
        size: 3,
        local: {
          key: 'restored-r1:0',
          file: new File(['abc'], 'a.png', { type: 'image/png' }),
          previewUrl: null,
          progress: 0,
        },
      },
    ];
    sender.restoreFiles(CHANNEL, 'r1', restored);
    // The sender's fallback uploader handles a restored file.
    await vi.waitFor(() => expect(recordedIds).toEqual(['r1', 'm2']));
    expect(upload).toHaveBeenCalledOnce();
  });

  it('files gone: filesMissing (failed, Remove only), the queue moves on', async () => {
    const waiting = entry('r1', {
      local: {
        attachments: [{ assetId: '', name: 'a.png', mime: 'image/png', size: 3 }],
        sharedPostIds: [],
        reply: null,
      },
      restoring: true,
    });
    const { sender, recordedIds, events } = harness({
      initial: { [CHANNEL]: [waiting, entry('m2')] },
    });
    sender.restoreFiles(CHANNEL, 'r1', null);
    await vi.waitFor(() => expect(recordedIds).toEqual(['m2']));
    expect(sender.entries(CHANNEL)).toEqual([
      { ...entry('r1', { local: waiting.local }), state: 'failed', filesMissing: true },
    ]);
    expect(events).toContainEqual({ type: 'state', channelId: CHANNEL, id: 'r1', state: 'failed' });
  });
});
