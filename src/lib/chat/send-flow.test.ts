import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutboxSender,
  LIVE_PUBLISH_TIMEOUT_MS,
  runSend,
  UPLOAD_CANCELLED,
  uploadWithSessionRetry,
  type SendFlowDeps,
  type SendInput,
  type SendOutcome,
} from '@/lib/chat/send-flow';
import {
  readPersistedOutbox,
  writePersistedOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxEvent,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import { buildAttachmentMeta, toLibraryAttachment, uploadRing } from '@/lib/chat/attachments';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const ID = '019935a0-0000-7000-8000-000000000001';

function row(over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: ID,
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
    created_at: '2026-09-22T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function input(over: Partial<SendInput> = {}): SendInput {
  return {
    id: ID,
    channelId: CHANNEL,
    currentUserId: ME,
    traceId: 'trace-1',
    text: 'hello',
    local: { attachments: [], sharedPostIds: [], reply: null },
    ...over,
  };
}

function deps(over: Partial<SendFlowDeps> = {}): SendFlowDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    recordMessage: vi.fn(async () => {
      order.push('record');
      return { ok: true as const, row: row() };
    }),
    publishLive: vi.fn(async () => {
      order.push('publish');
      return {};
    }),
    onLiveWarning: vi.fn(),
    ...over,
  };
}

describe('runSend', () => {
  it('records through chat_message_send BEFORE the Agora publish and renders the returned row', async () => {
    const d = deps();
    const outcome = await runSend(d, input());

    expect(d.order).toEqual(['record', 'publish']);
    expect(d.recordMessage).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hello',
      mentions: [],
      attachmentAssetIds: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      replyToMessageId: null,
      attachmentMeta: {},
    });
    expect(d.publishLive).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      text: 'hello',
      local: { attachments: [], sharedPostIds: [], reply: null },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(true);
    // The bubble shows the SERVER created_at, never a local clock.
    expect(outcome.message.createdAt).toBe('2026-09-22T10:00:00.123456+00:00');
    expect(outcome.message.provisionalTime).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(outcome.message.mine).toBe(true);
  });

  it('passes attachment version ids to the record', async () => {
    const d = deps();
    await runSend(
      d,
      input({
        text: '',
        local: {
          attachments: [{ assetId: 'v1', name: 'p.png', mime: 'image/png' }],
          sharedPostIds: [],
          reply: null,
        },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', attachmentAssetIds: ['v1'] }),
    );
  });

  it('keeps the message sent when the live publish fails, and only warns', async () => {
    const d = deps({ publishLive: vi.fn().mockRejectedValue(new Error('agora down')) });
    const outcome = await runSend(d, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: 'trace-1', message_id: ID, error: 'Error: agora down' }),
    );
  });

  it('still sends with no live connection at all', async () => {
    const d = deps({ publishLive: undefined });
    const outcome = await runSend(d, input());
    expect(outcome.ok && outcome.livePublished).toBe(false);
    expect(outcome.ok && outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledOnce();
  });

  it('reports failed (and never publishes) when the record write fails or times out', async () => {
    const failing = deps({
      recordMessage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'timeout', message: 'aborted' }),
    });
    const outcome = await runSend(failing, input());
    expect(outcome).toEqual({
      ok: false,
      reason: 'timeout',
      error: 'aborted',
      errorClass: 'transient',
    });
    expect(failing.publishLive).not.toHaveBeenCalled();
  });

  it('retries with the SAME message id so the idempotent proc returns the one row', async () => {
    const recordMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout', message: 'aborted' })
      .mockResolvedValueOnce({ ok: true, row: row() });
    const d = deps({ recordMessage });

    const first = await runSend(d, input({ traceId: 'trace-1' }));
    const second = await runSend(d, input({ traceId: 'trace-2' }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(recordMessage.mock.calls[0]?.[0].id).toBe(ID);
    expect(recordMessage.mock.calls[1]?.[0].id).toBe(ID);
    // Each attempt is its own user action with its own trace id.
    expect(recordMessage.mock.calls[1]?.[0].traceId).toBe('trace-2');
  });

  it('persists shared posts, the reply target and attachment meta, never a transcript (shared-posts-only, no body)', async () => {
    const d = deps();
    await runSend(
      d,
      input({
        text: '',
        local: {
          attachments: [
            { assetId: 'v1', name: 'p.png', mime: 'image/png', size: 120 },
            {
              assetId: 'v2',
              name: 'voice.webm',
              mime: 'audio/webm',
              size: 900,
              durationMs: 4000,
              transcript: 'hello there',
            },
          ],
          sharedPostIds: ['post-1'],
          reply: { id: 'quoted-1', authorUserId: ME, preview: 'hi' },
        },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '',
        sharedPostIds: ['post-1'],
        replyToMessageId: 'quoted-1',
        attachmentMeta: {
          v1: { mime: 'image/png', name: 'p.png', size: 120 },
          v2: {
            mime: 'audio/webm',
            name: 'voice.webm',
            size: 900,
            duration_ms: 4000,
          },
        },
      }),
    );
  });
});

describe('runSend library attachments', () => {
  it('records library version ids with meta equal to an upload-sent file of the same shape', async () => {
    const d = deps();
    const library = toLibraryAttachment(
      { id: 'ver-lib', mime_type: 'image/png', size_bytes: 1234, duration_ms: null },
      'Hero.png',
    );
    // The same file sent through an upload: what toMessageAttachment builds.
    const uploaded = { assetId: 'ver-lib', name: 'Hero.png', mime: 'image/png', size: 1234 };
    await runSend(d, input({ local: { attachments: [library], sharedPostIds: [], reply: null } }));
    const args = vi.mocked(d.recordMessage).mock.calls[0]?.[0];
    expect(args?.attachmentAssetIds).toEqual(['ver-lib']);
    expect(args?.attachmentMeta).toEqual(buildAttachmentMeta([uploaded]));
    expect(args?.attachmentMeta).toEqual({
      'ver-lib': { mime: 'image/png', name: 'Hero.png', size: 1234 },
    });
  });
});

describe('runSend shared briefs', () => {
  it('passes shared brief ids to the record; a briefs-only send is valid', async () => {
    const d = deps();
    const outcome = await runSend(
      d,
      input({
        text: '',
        local: { attachments: [], sharedPostIds: [], sharedBriefIds: ['brief-1'], reply: null },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', sharedBriefIds: ['brief-1'], sharedPostIds: [] }),
    );
    expect(outcome.ok && outcome.message.sharedBriefIds).toEqual(['brief-1']);
  });
});

describe('runSend live publish timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a hung Agora publish after 5s: warns, bubble stays sent, send resolves', async () => {
    vi.useFakeTimers();
    const onRecorded = vi.fn();
    const d = deps({ publishLive: vi.fn(() => new Promise<unknown>(() => {})), onRecorded });
    const pending = runSend(d, input());
    await vi.advanceTimersByTimeAsync(0);
    // The row exists: the bubble goes sent before Agora answers.
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'sent' }));
    await vi.advanceTimersByTimeAsync(LIVE_PUBLISH_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.ok && outcome.livePublished).toBe(false);
    expect(outcome.ok && outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: ID, error: 'live publish timed out' }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the publish settles first', async () => {
    vi.useFakeTimers();
    const d = deps();
    const outcome = await runSend(d, input());
    expect(outcome.ok && outcome.livePublished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createOutboxSender (background send, retries, persistence)', () => {
  const OTHER = 'group__ws__g2';
  const SCOPE = { workspaceId: 'ws', userId: ME };

  afterEach(() => {
    vi.useRealTimers();
  });

  function entry(id: string): OutboxEntry {
    return {
      id,
      text: `body ${id}`,
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'sending',
    };
  }

  type Script = ('ok' | 'fail' | 'pending')[];

  /** A sender whose record attempts follow `script` (then succeed). */
  function harness(
    opts: {
      script?: Script;
      initial?: Outbox;
      storage?: OutboxStorage;
      onCancelled?: (channelId: string, entry: OutboxEntry) => void;
    } = {},
  ) {
    const script = [...(opts.script ?? [])];
    const calls: { channelId: string; id: string; traceId: string; entry: OutboxEntry }[] = [];
    const events: OutboxEvent[] = [];
    let traceSeq = 0;
    const sender = createOutboxSender(
      {
        deliver: async (channelId, e, traceId, onRecorded) => {
          calls.push({ channelId, id: e.id, traceId, entry: e });
          const step = script.shift() ?? 'ok';
          if (step === 'pending') return new Promise<SendOutcome>(() => {});
          if (step === 'fail') return { ok: false, reason: 'timeout', error: 'rpc timed out' };
          const message = rowToThreadMessage(row({ id: e.id, channel_id: channelId }), ME);
          onRecorded(message);
          return { ok: true, message, livePublished: true };
        },
        newTraceId: () => `trace-${(traceSeq += 1)}`,
        onEvent: (event) => events.push(event),
        onChange: (next) => writePersistedOutbox(opts.storage ?? null, SCOPE, next),
        onAttemptFailed: () => {},
        ...(opts.onCancelled !== undefined ? { onCancelled: opts.onCancelled } : {}),
      },
      opts.initial,
    );
    return { sender, calls, events };
  }

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

  it('enqueue returns before the record resolves; the entry is sending at once', () => {
    const { sender, calls } = harness({ script: ['pending'] });
    sender.enqueue(CHANNEL, entry('m1'));
    expect(sender.entries(CHANNEL)).toEqual([entry('m1')]);
    expect(calls).toHaveLength(1);
  });

  it('RPC rejects 3 times then resolves: sending throughout, then sent; one id, a new trace each attempt', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: ['fail', 'fail', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(3);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(4);
    expect(sender.entries(CHANNEL)).toEqual([]);
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['m1']));
    expect(new Set(calls.map((c) => c.traceId)).size).toBe(4);
    expect(events.some((e) => e.type === 'state' && e.state === 'failed')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'recorded', channelId: CHANNEL });
  });

  it('backs off 2s, 4s, 8s, 16s, 30s, then every 30s', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: Array<'fail'>(8).fill('fail') });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    const at: number[] = [];
    for (const wait of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      at.push(calls.length);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(at).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls).toHaveLength(7);
  });

  it('transient failures never turn failed: still sending (clock) long past 120s, same id', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: Array<'fail'>(50).fill('fail') });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    expect(events.some((e) => e.type === 'state' && e.state === 'failed')).toBe(false);
    // Still trying every 30s.
    const attempts = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(attempts + 1);
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['m1']));
    sender.dispose();
  });

  it('keeps FIFO per channel under retries; other channels are independent', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail', 'ok', 'ok', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    sender.enqueue(CHANNEL, entry('m2'));
    sender.enqueue(OTHER, entry('o1'));
    await vi.advanceTimersByTimeAsync(0);
    // m1 failed; o1 went ahead in its own channel; m2 waits behind m1.
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1']);
    await vi.advanceTimersByTimeAsync(2_000);
    // m1 recorded, then m2 attempted (and failed), retried after 2s.
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1', 'm1', 'm2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1', 'm1', 'm2', 'm2']);
    expect(sender.entries(CHANNEL)).toEqual([]);
    expect(sender.entries(OTHER)).toEqual([]);
  });

  it('kick (reconnect / tab visible) retries at once instead of waiting out the backoff', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    sender.kick();
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('a row read back by catch-up settles the entry and no duplicate is sent', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    sender.settle(CHANNEL, 'm1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('reload: persisted, restored for the same workspace and user only, and resumed', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = harness({ script: ['pending'], storage });
    first.sender.enqueue(CHANNEL, entry('m1'));
    first.sender.dispose();

    const elsewhere = readPersistedOutbox(storage, { workspaceId: 'other', userId: ME });
    expect(elsewhere).toEqual({});
    const reloaded = harness({ initial: readPersistedOutbox(storage, SCOPE), storage });
    // Same scope: the entry comes back as sending and its send resumes, same id.
    expect(reloaded.calls.map((c) => c.id)).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(reloaded.sender.entries(CHANNEL)).toEqual([]);
    expect(readPersistedOutbox(storage, SCOPE)).toEqual({});
  });

  it('a throwing localStorage never prevents the send', async () => {
    vi.useFakeTimers();
    const boom = (): never => {
      throw new Error('QuotaExceededError');
    };
    const { sender, calls } = harness({
      storage: { getItem: boom, setItem: boom, removeItem: boom },
    });
    expect(() => sender.enqueue(CHANNEL, entry('m1'))).not.toThrow();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('dispose clears every timer and ignores answers still in flight', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: ['fail'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
  });

  describe('instant attachment sends (upload in the outbox, then record once)', () => {
    type Step = 'ok' | 'fail' | 'pending';

    /** An uploader following `steps` per call (then ok), reporting 50% then done. */
    function uploader(steps: Step[] = []) {
      const queue = [...steps];
      const files: string[] = [];
      let seq = 0;
      const upload = vi.fn(async (file: File, onProgress?: (f: number) => void) => {
        files.push(file.name);
        const step = queue.shift() ?? 'ok';
        if (step === 'pending') return new Promise<never>(() => {});
        onProgress?.(0.5);
        if (step === 'fail') return { ok: false as const, message: 'Upload failed' };
        seq += 1;
        return { ok: true as const, reused: false, versionId: `ver-${file.name}-${seq}` };
      });
      return { upload, files };
    }

    function withFiles(id: string, names: string[], upload: ReturnType<typeof uploader>['upload']) {
      const base = entry(id);
      return {
        ...base,
        local: {
          ...base.local,
          attachments: names.map((name, i) => ({
            assetId: '',
            name,
            mime: 'image/png',
            size: 3,
            local: {
              key: `local-${id}-${i}`,
              file: new File(['abc'], name, { type: 'image/png' }),
              previewUrl: `blob:${name}`,
              progress: 0,
              upload,
            },
          })),
        },
      };
    }

    it('uploads each file in order, then records ONCE with the version ids; the bubble shows at once', async () => {
      const { upload, files } = uploader();
      const { sender, calls, events } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      // Queued synchronously: the entry (and so the bubble) exists before any upload settles.
      expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
      expect(calls).toHaveLength(0);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(files).toEqual(['a.png', 'b.png']);
      const recorded = calls[0]?.entry.local.attachments ?? [];
      expect(recorded.map((a) => a.assetId)).toEqual(['ver-a.png-1', 'ver-b.png-2']);
      // The local previews ride along to the recorded bubble (no swap to a presigned url).
      expect(recorded.map((a) => a.local?.previewUrl)).toEqual(['blob:a.png', 'blob:b.png']);
      expect(recorded.map((a) => a.local?.progress)).toEqual([1, 1]);
      expect(sender.entries(CHANNEL)).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'recorded', channelId: CHANNEL });
    });

    it('library picks (version id, no local half) are never uploaded; a mixed send uploads only the picked file', async () => {
      const { upload, files } = uploader();
      const { sender, calls } = harness();
      const mixed = withFiles('m1', ['roll.png'], upload);
      const libraryImage = toLibraryAttachment(
        { id: 'ver-lib-img', mime_type: 'image/png', size_bytes: 3, duration_ms: null },
        'Hero.png',
      );
      const libraryPdf = toLibraryAttachment(
        { id: 'ver-lib-pdf', mime_type: 'application/pdf', size_bytes: 9, duration_ms: null },
        'Deck.pdf',
      );
      sender.enqueue(CHANNEL, {
        ...mixed,
        local: {
          ...mixed.local,
          attachments: [...mixed.local.attachments, libraryImage, libraryPdf],
        },
      });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(files).toEqual(['roll.png']);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(calls[0]?.entry.local.attachments.map((a) => a.assetId)).toEqual([
        'ver-roll.png-1',
        'ver-lib-img',
        'ver-lib-pdf',
      ]);
    });

    it('a library-only send records at once with no upload call', async () => {
      const { upload } = uploader();
      const { sender, calls } = harness();
      const base = withFiles('m2', [], upload);
      sender.enqueue(CHANNEL, {
        ...base,
        local: {
          ...base.local,
          attachments: [
            toLibraryAttachment(
              { id: 'ver-lib-img', mime_type: 'image/png', size_bytes: 3, duration_ms: null },
              'Hero.png',
            ),
          ],
        },
      });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(upload).not.toHaveBeenCalled();
      expect(calls[0]?.entry.local.attachments.map((a) => a.assetId)).toEqual(['ver-lib-img']);
    });

    it('progress callbacks update the outbox entry and reach the thread as progress events', async () => {
      const { upload } = uploader(['ok', 'pending']);
      const { sender, calls, events } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
      const progress = events.filter((e) => e.type === 'progress');
      expect(
        progress.map((e) =>
          e.type === 'progress' ? e.attachments.map((a) => a.local?.progress) : [],
        ),
      ).toEqual([
        // a.png starts (the ring turns determinate), ticks, lands; then b.png starts.
        [0, 0],
        [0.5, 0],
        [1, 0],
        [1, 0],
      ]);
      expect(
        progress.map((e) =>
          e.type === 'progress' ? e.attachments.map((a) => a.local?.uploading === true) : [],
        ),
      ).toEqual([
        [true, false],
        [true, false],
        [false, false],
        [false, true],
      ]);
      const held = sender.entries(CHANNEL)[0]?.local.attachments ?? [];
      expect(held.map((a) => a.assetId)).toEqual(['ver-a.png-1', '']);
      expect(held.map((a) => a.local?.progress)).toEqual([1, 0]);
      expect(calls).toHaveLength(0);
    });

    it('an upload failure backs off like a record failure; the retry uploads only the files with no version id', async () => {
      vi.useFakeTimers();
      const { upload, files } = uploader(['ok', 'fail']);
      const { sender, calls } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      await vi.advanceTimersByTimeAsync(0);
      expect(files).toEqual(['a.png', 'b.png']);
      expect(calls).toHaveLength(0);
      expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(files).toEqual(['a.png', 'b.png', 'b.png']);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.id).toBe('m1');
      expect(calls[0]?.entry.local.attachments.map((a) => a.assetId)).toEqual([
        'ver-a.png-1',
        'ver-b.png-2',
      ]);
    });

    it('failing uploads never turn failed; a kick re-uploads only what is missing, same id', async () => {
      vi.useFakeTimers();
      const { upload, files } = uploader(['ok', ...Array<Step>(40).fill('fail')]);
      const { sender, calls, events } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
      expect(events.some((e) => e.type === 'state' && e.state === 'failed')).toBe(false);
      expect(files.filter((f) => f === 'a.png')).toHaveLength(1);
      upload.mockImplementation(async (file: File) => {
        files.push(file.name);
        return { ok: true as const, reused: false, versionId: 'ver-b-final' };
      });
      sender.kick();
      await vi.advanceTimersByTimeAsync(0);
      expect(files.filter((f) => f === 'a.png')).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.id).toBe('m1');
      expect(calls[0]?.entry.local.attachments.map((a) => a.assetId)).toEqual([
        'ver-a.png-1',
        'ver-b-final',
      ]);
    });

    /** An uploader that hangs until aborted; records every signal it was handed. */
    function abortableUploader() {
      const signals: AbortSignal[] = [];
      const aborted: string[] = [];
      const files: string[] = [];
      const finishers: (() => void)[] = [];
      const upload = vi.fn(
        (file: File, onProgress?: (f: number) => void, signal?: AbortSignal) =>
          new Promise<
            { ok: true; reused: boolean; versionId: string } | { ok: false; message: string }
          >((resolve) => {
            files.push(file.name);
            if (signal !== undefined) signals.push(signal);
            onProgress?.(0.3);
            signal?.addEventListener('abort', () => {
              aborted.push(file.name);
              // The XHR abort surfaces as a transport failure.
              resolve({ ok: false, message: 'Upload failed. Try again' });
            });
            finishers.push(() => resolve({ ok: true, reused: false, versionId: `v-${file.name}` }));
          }),
      );
      return { upload, signals, aborted, files, finishers };
    }

    it('T7: cancel mid-upload aborts the request, drops the entry and frees the lane at once', async () => {
      const { upload, aborted, files } = abortableUploader();
      const cancelled: OutboxEntry[] = [];
      const { sender, calls, events } = harness({ onCancelled: (_c, e) => cancelled.push(e) });
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      sender.enqueue(CHANNEL, entry('m2'));
      await vi.waitFor(() => expect(files).toEqual(['a.png']));
      expect(sender.cancel(CHANNEL, 'm1')).toBe(true);
      // Aborted, gone, and the next send ran without waiting for the upload.
      expect(aborted).toEqual(['a.png']);
      expect(sender.entries(CHANNEL).map((e) => e.id)).not.toContain('m1');
      expect(cancelled.map((e) => e.id)).toEqual(['m1']);
      expect(events).toContainEqual({ type: 'cancelled', channelId: CHANNEL, id: 'm1' });
      await vi.waitFor(() => expect(calls.map((c) => c.id)).toEqual(['m2']));
      // The remaining upload of m1 (b.png) never ran; m1 never recorded.
      await new Promise((r) => setTimeout(r, 0));
      expect(files).toEqual(['a.png']);
      expect(calls.map((c) => c.id)).not.toContain('m1');
    });

    it('T7: the next queued upload starts immediately after a cancel', async () => {
      const first = abortableUploader();
      const second = abortableUploader();
      const { sender } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], first.upload));
      sender.enqueue(CHANNEL, withFiles('m2', ['b.png'], second.upload));
      await vi.waitFor(() => expect(first.files).toEqual(['a.png']));
      expect(second.files).toEqual([]);
      sender.cancel(CHANNEL, 'm1');
      await vi.waitFor(() => expect(second.files).toEqual(['b.png']));
    });

    it('T8: an abort is not a failure: no Not sent, no retry, no backoff, no failure log', async () => {
      vi.useFakeTimers();
      const { upload, files } = abortableUploader();
      const failures: Record<string, unknown>[] = [];
      const events: OutboxEvent[] = [];
      const sender = createOutboxSender({
        deliver: async () => ({ ok: false, reason: 'error', error: 'x' }),
        newTraceId: () => 't',
        onEvent: (event) => events.push(event),
        onChange: () => {},
        onAttemptFailed: (context) => failures.push(context),
      });
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], upload));
      await vi.advanceTimersByTimeAsync(0);
      sender.cancel(CHANNEL, 'm1');
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(failures).toEqual([]);
      expect(events.some((e) => e.type === 'state' && e.state === 'failed')).toBe(false);
      // Never uploaded again (no retry after a backoff).
      expect(files).toEqual(['a.png']);
      expect(sender.entries(CHANNEL)).toEqual([]);
    });

    it('T8: the lane stays free when the aborted upload answers late', async () => {
      let late: (() => void) | undefined;
      const upload = vi.fn(
        () =>
          new Promise<{ ok: true; reused: boolean; versionId: string }>((resolve) => {
            late = () => resolve({ ok: true, reused: false, versionId: 'v' });
          }),
      );
      const second = abortableUploader();
      const { sender, calls } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], upload));
      sender.enqueue(CHANNEL, withFiles('m2', ['b.png'], second.upload));
      await vi.waitFor(() => expect(upload).toHaveBeenCalled());
      sender.cancel(CHANNEL, 'm1');
      await vi.waitFor(() => expect(second.files).toEqual(['b.png']));
      // m1's upload answers after the cancel: ignored, m2 keeps its run.
      late?.();
      second.finishers[0]?.();
      await vi.waitFor(() => expect(calls.map((c) => c.id)).toEqual(['m2']));
    });

    it('T8: cancelling a send waiting in backoff clears its timer and runs the next', async () => {
      vi.useFakeTimers();
      const { upload } = uploader(['fail']);
      const { sender, calls } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], upload));
      sender.enqueue(CHANNEL, entry('m2'));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(0);
      expect(sender.cancel(CHANNEL, 'm1')).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.id)).toEqual(['m2']);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(upload).toHaveBeenCalledTimes(1);
    });

    it('T9: once every upload resolved and the record call fired, a cancel is ignored', async () => {
      const { upload } = uploader();
      const { sender, calls } = harness({ script: ['pending'] });
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], upload));
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(sender.cancel(CHANNEL, 'm1')).toBe(false);
      expect(sender.entries(CHANNEL).map((e) => e.id)).toEqual(['m1']);
    });

    it('T9: the X hides the moment the last upload resolves (no attachment awaits upload)', async () => {
      const { upload } = uploader();
      const { sender, events } = harness({ script: ['pending'] });
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png', 'b.png'], upload));
      await vi.waitFor(() =>
        expect(
          events.some((e) => e.type === 'progress' && e.attachments.every((a) => a.assetId !== '')),
        ).toBe(true),
      );
      const last = [...events].reverse().find((e) => e.type === 'progress');
      expect(last?.type === 'progress' && uploadRing(last.attachments)).toBe(null);
    });

    it('T9: deliver re-checks the cancel synchronously right before the record call', async () => {
      // An upload that resolves ok while the cancel lands in the same tick.
      const holder: { resolve?: () => void } = {};
      const upload = vi.fn(
        (_file: File, _p?: (f: number) => void, signal?: AbortSignal) =>
          new Promise<{ ok: true; reused: boolean; versionId: string }>((resolve) => {
            holder.resolve = () => resolve({ ok: true, reused: false, versionId: 'v' });
            void signal;
          }),
      );
      const { sender, calls } = harness();
      sender.enqueue(CHANNEL, withFiles('m1', ['a.png'], upload));
      await vi.waitFor(() => expect(upload).toHaveBeenCalled());
      holder.resolve?.();
      sender.cancel(CHANNEL, 'm1');
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toEqual([]);
    });

    it('a restored entry whose files were lost stays failed, never runs, and does not hold up the queue', async () => {
      const lost: OutboxEntry = {
        ...entry('m1'),
        local: {
          ...entry('m1').local,
          attachments: [{ assetId: '', name: 'a.png', mime: 'image/png', size: 3 }],
        },
        state: 'failed',
        filesMissing: true,
      };
      const { sender, calls } = harness({ initial: { [CHANNEL]: [lost, entry('m2')] } });
      await vi.waitFor(() => expect(calls.map((c) => c.id)).toEqual(['m2']));
      sender.retry(CHANNEL, 'm1');
      sender.enqueue(CHANNEL, entry('m3'));
      await vi.waitFor(() => expect(calls.map((c) => c.id)).toEqual(['m2', 'm3']));
      expect(sender.entries(CHANNEL)).toEqual([lost]);
      // Remove (settle) drops it.
      sender.settle(CHANNEL, 'm1');
      expect(sender.entries(CHANNEL)).toEqual([]);
    });
  });
});

describe('mentions on send', () => {
  const ANA = '22222222-2222-4222-8222-222222222222';
  const BEN = '33333333-3333-4333-8333-333333333333';
  const body = `@[${ANA}] and @[${BEN}] and @[${ANA}] again`;

  it('the body carries @[uuid] tokens and p_mentions carries the unique uuids', async () => {
    const d = deps();
    await runSend(d, input({ text: body }));
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body, mentions: [ANA, BEN] }),
    );
  });

  it('a persisted outbox entry keeps its mentions, so every retry resends them', async () => {
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
    const queued: OutboxEntry = {
      id: ID,
      text: body,
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'failed',
    };
    writePersistedOutbox(storage, scope, { [CHANNEL]: [queued] });
    const restored = readPersistedOutbox(storage, scope)[CHANNEL]?.[0];
    expect(restored?.text).toBe(body);
    const failing = deps({
      recordMessage: vi.fn(async () => ({
        ok: false as const,
        reason: 'error' as const,
        message: 'x',
      })),
    });
    const retry = input({ text: restored?.text ?? '' });
    await runSend(failing, retry);
    await runSend(failing, retry);
    expect(failing.recordMessage).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(failing.recordMessage).mock.calls) {
      expect(call[0].mentions).toEqual([ANA, BEN]);
    }
  });
});

describe('H2 a refused mention never fails the send', () => {
  const ANA = '22222222-2222-4222-8222-222222222222';
  const EX = '44444444-4444-4444-8444-444444444444';
  const body = `@[${ANA}] and @[${EX}]`;
  const refused = {
    ok: false as const,
    reason: 'error' as const,
    message: 'mentioned people must be in this chat',
  };

  it('H2 server rejection re-reads members once, drops only the non-member and succeeds', async () => {
    const recordMessage = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, row: row() });
    const recheckMentions = vi.fn(async () => ({ ok: true as const, data: [ME, ANA] }));
    const outcome = await runSend(deps({ recordMessage, recheckMentions }), input({ text: body }));
    expect(outcome.ok).toBe(true);
    expect(recheckMentions).toHaveBeenCalledTimes(1);
    expect(recheckMentions).toHaveBeenCalledWith(CHANNEL);
    expect(recordMessage).toHaveBeenCalledTimes(2);
    expect(recordMessage.mock.calls[0]?.[0].mentions).toEqual([ANA, EX]);
    expect(recordMessage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ body, mentions: [ANA] }),
    );
  });

  it('H2 double failure (refused, then the re-read fails) sends without mentions, no visible failure', async () => {
    const recordMessage = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, row: row() });
    const recheckMentions = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'unknown' as const, message: 'timed out' },
    }));
    const outcome = await runSend(deps({ recordMessage, recheckMentions }), input({ text: body }));
    expect(outcome.ok).toBe(true);
    expect(recordMessage).toHaveBeenCalledTimes(2);
    expect(recordMessage.mock.calls[1]?.[0].mentions).toEqual([]);
    // A throwing re-read counts as failed too.
    const again = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, row: row() });
    const throwing = await runSend(
      deps({ recordMessage: again, recheckMentions: () => Promise.reject(new Error('x')) }),
      input({ text: body }),
    );
    expect(throwing.ok).toBe(true);
    expect(again.mock.calls[1]?.[0].mentions).toEqual([]);
  });

  it('J2 second refusal steps down to no mentions and succeeds; "@[all]" typed in a DM sends without "all"', async () => {
    const recordMessage = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({
        ok: false,
        reason: 'error',
        message: 'everyone mention works only in groups',
      })
      .mockResolvedValueOnce({ ok: true, row: row() });
    const recheckMentions = vi.fn(async () => ({ ok: true as const, data: [ANA, EX] }));
    const outcome = await runSend(
      deps({ recordMessage, recheckMentions }),
      input({ text: `@[all] ${body}` }),
    );
    expect(outcome.ok).toBe(true);
    expect(recheckMentions).toHaveBeenCalledTimes(1);
    expect(recordMessage).toHaveBeenCalledTimes(3);
    expect(recordMessage.mock.calls[1]?.[0].mentions).toEqual([ANA, EX, 'all']);
    expect(recordMessage.mock.calls[2]?.[0].mentions).toEqual([]);

    const dm = deps();
    await runSend(dm, input({ text: `@[all] and @[${ANA}]`, channelType: 'dm' }));
    expect(dm.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: `@[all] and @[${ANA}]`, mentions: [ANA] }),
    );
  });

  it('B3 send with unknown channel type and the everyone refusal keeps the peer mention', async () => {
    const recordMessage = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'error',
        message: 'everyone mention works only in groups',
      })
      .mockResolvedValueOnce({ ok: true, row: row() });
    const recheckMentions = vi.fn(async () => ({ ok: true as const, data: [ME, ANA] }));
    // No channelType: the summary was missing at send.
    const outcome = await runSend(
      deps({ recordMessage, recheckMentions }),
      input({ text: `@[all] and @[${ANA}]` }),
    );
    expect(outcome.ok).toBe(true);
    expect(recordMessage).toHaveBeenCalledTimes(2);
    expect(recordMessage.mock.calls[0]?.[0].mentions).toEqual([ANA, 'all']);
    // Only "all" drops; the peer mention is kept and no re-read was needed.
    expect(recordMessage.mock.calls[1]?.[0].mentions).toEqual([ANA]);
    expect(recheckMentions).not.toHaveBeenCalled();

    // A further refusal takes the existing ladder: re-read, then [].
    const further = vi
      .fn<SendFlowDeps['recordMessage']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'error',
        message: 'everyone mention works only in groups',
      })
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, row: row() });
    const reread = vi.fn(async () => ({ ok: true as const, data: [ME, ANA] }));
    const again = await runSend(
      deps({ recordMessage: further, recheckMentions: reread }),
      input({ text: `@[all] and @[${ANA}]` }),
    );
    expect(again.ok).toBe(true);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(further.mock.calls.map((c) => c[0].mentions)).toEqual([[ANA, 'all'], [ANA], [ANA], []]);
  });

  it('A2 p_mentions carries "all" alongside uuids', async () => {
    const d = deps();
    await runSend(d, input({ text: `@[all] and @[${ANA}]` }));
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [ANA, 'all'] }),
    );
  });
});

describe('T10: the 401 retry path after a cancel', () => {
  const unauthorized = {
    result: { ok: false as const, message: 'Upload failed. Try again' },
    status: 401,
  };

  it('a cancel during the first attempt never refreshes or re-uploads', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      return unauthorized;
    });
    const refresh = vi.fn(async () => 'refreshed' as const);
    const result = await uploadWithSessionRetry(attempt, refresh, controller.signal);
    expect(result).toEqual({ ok: false, message: UPLOAD_CANCELLED });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a cancel while the session refreshes skips the second upload', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => unauthorized);
    const refresh = vi.fn(async () => {
      controller.abort();
      return 'refreshed' as const;
    });
    const result = await uploadWithSessionRetry(attempt, refresh, controller.signal);
    expect(result).toEqual({ ok: false, message: UPLOAD_CANCELLED });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('an already-cancelled send never uploads', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => unauthorized);
    await uploadWithSessionRetry(attempt, async () => 'refreshed', controller.signal);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('without a cancel the 401 still refreshes and retries once', async () => {
    const controller = new AbortController();
    const attempt = vi
      .fn<
        () => Promise<
          | typeof unauthorized
          | { result: { ok: true; reused: boolean; versionId: string }; status: number }
        >
      >()
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce({ result: { ok: true, reused: false, versionId: 'v' }, status: 201 });
    const result = await uploadWithSessionRetry(
      attempt,
      async () => 'refreshed',
      controller.signal,
    );
    expect(result).toEqual({ ok: true, reused: false, versionId: 'v' });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
