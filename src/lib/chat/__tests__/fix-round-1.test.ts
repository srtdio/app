// Fix round 1 on "sends never visibly fail": upload refusals are permanent
// (F1), the stall watch switches to one response wait after the last byte
// (F2), Retry re-stamps and recorded sends keep what is queued behind them in
// place (F3), no backoff attempt while offline (F5), a restore that hangs
// gives up at 5s (F7a) and PGRST202 is transient (F7b).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutboxSender,
  UPLOAD_RESPONSE_WAIT_MS,
  UPLOAD_STALL_MS,
  uploadWithSessionRetry,
  watchUploadStall,
  type OutboxSenderDeps,
  type SessionRefresh,
  type UploadAttemptResult,
} from '@/lib/chat/send-flow';
import {
  classifyRecordFailure,
  classifyUploadFailure,
  uploadFailureStatus,
} from '@/lib/chat/send-errors';
import type { Outbox, OutboxEntry, OutboxEvent } from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import type { ChatAttachmentUpload } from '@/lib/chat/attachments';
import { uploadErrorMessage } from '@/lib/asset-upload';
import {
  RESTORE_TIMEOUT_MS,
  restoreOutboxFiles,
  type OutboxFileAdapter,
} from '@/lib/chat/outbox-files';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const NETWORK = uploadErrorMessage('network');

afterEach(() => {
  vi.useRealTimers();
});

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

function withFile(id: string, upload: (file: File) => Promise<ChatAttachmentUpload>): OutboxEntry {
  return entry(id, {
    local: {
      attachments: [
        {
          assetId: '',
          name: 'a.png',
          mime: 'image/png',
          size: 3,
          local: {
            key: `local-${id}`,
            file: new File(['abc'], 'a.png', { type: 'image/png' }),
            previewUrl: null,
            progress: 0,
            upload,
          },
        },
      ],
      sharedPostIds: [],
      reply: null,
    },
  });
}

/** A sender recording each attempt; `record` decides the outcome per id (default ok at 1000). */
function harness(
  opts: {
    initial?: Outbox;
    deps?: Partial<OutboxSenderDeps>;
    fail?: (id: string) => boolean;
    recordedMs?: (id: string) => number;
  } = {},
) {
  const calls: string[] = [];
  const recorded: string[] = [];
  const events: OutboxEvent[] = [];
  const sender = createOutboxSender(
    {
      deliver: async (_channelId, e, _traceId, onRecorded) => {
        calls.push(e.id);
        if (opts.fail?.(e.id) === true) {
          return { ok: false, reason: 'error', error: 'Failed to fetch', errorClass: 'transient' };
        }
        const message = rowToThreadMessage(row(e.id, opts.recordedMs?.(e.id) ?? 1_000), ME);
        recorded.push(e.id);
        onRecorded(message);
        return { ok: true, message, livePublished: false };
      },
      newTraceId: () => 't',
      onEvent: (event) => events.push(event),
      onChange: () => {},
      onAttemptFailed: () => {},
      ...opts.deps,
    },
    opts.initial,
  );
  return { sender, calls, recorded, events };
}

describe('F1 upload refusals are permanent', () => {
  const failed = (status: number | null): UploadAttemptResult => ({
    result: { ok: false, message: NETWORK },
    status,
  });
  const ok: UploadAttemptResult = {
    result: { ok: true, reused: false, versionId: 'ver-1' },
    status: 200,
  };

  /** Run the adapter over scripted attempts; the class of what comes back. */
  async function outcome(
    attempts: UploadAttemptResult[],
    refresh: SessionRefresh = 'refreshed',
  ): Promise<{ result: ChatAttachmentUpload; attempts: number; refreshes: number }> {
    const queue = [...attempts];
    let used = 0;
    let refreshes = 0;
    const result = await uploadWithSessionRetry(
      async () => {
        used += 1;
        return queue.shift() ?? ok;
      },
      async () => {
        refreshes += 1;
        return refresh;
      },
    );
    return { result, attempts: used, refreshes };
  }

  function classOf(result: ChatAttachmentUpload): string {
    if (result.ok) return 'ok';
    return classifyUploadFailure(result.message, uploadFailureStatus(result));
  }

  it.each([
    [0, 'transient'],
    [400, 'permanent'],
    [403, 'permanent'],
    [404, 'permanent'],
    [408, 'transient'],
    [413, 'permanent'],
    [415, 'permanent'],
    [429, 'transient'],
    [500, 'transient'],
    [503, 'transient'],
  ])('status %i is %s, whatever the body', async (status, expected) => {
    const { result, attempts } = await outcome([failed(status)]);
    expect(attempts).toBe(1);
    expect(uploadFailureStatus(result as { ok: false; message: string })).toBe(status);
    expect(classOf(result)).toBe(expected);
  });

  it('401 then ok: one session refresh, one retry, uploaded', async () => {
    const { result, attempts, refreshes } = await outcome([failed(401), ok]);
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true, reused: false, versionId: 'ver-1' });
  });

  it('401 twice: permanent, no second refresh', async () => {
    const { result, attempts, refreshes } = await outcome([failed(401), failed(401)]);
    expect(refreshes).toBe(1);
    expect(attempts).toBe(2);
    expect(classOf(result)).toBe('permanent');
  });

  it('401 and the refresh is refused: permanent; the refresh cannot reach the server: transient', async () => {
    expect(classOf((await outcome([failed(401)], 'rejected')).result)).toBe('permanent');
    expect(classOf((await outcome([failed(401)], 'unreachable')).result)).toBe('transient');
  });

  it('a stall abort (status 0) is transient; a refusal copy stays permanent on any status', () => {
    expect(classifyUploadFailure(NETWORK, 0)).toBe('transient');
    expect(classifyUploadFailure(uploadErrorMessage('virus_detected'), 500)).toBe('permanent');
    expect(classifyUploadFailure(uploadErrorMessage('file_too_large'))).toBe('permanent');
    expect(classifyUploadFailure(NETWORK)).toBe('transient');
  });

  it("the queue turns a 403 upload 'failed' at once and moves on", async () => {
    const upload = vi.fn(
      async (): Promise<ChatAttachmentUpload> =>
        uploadWithSessionRetry(
          async () => failed(403),
          async () => 'refreshed',
        ),
    );
    const { sender, recorded, events } = harness();
    sender.enqueue(CHANNEL, withFile('m1', upload));
    sender.enqueue(CHANNEL, entry('m2'));
    await vi.waitFor(() => expect(recorded).toEqual(['m2']));
    expect(sender.entries(CHANNEL).map((e) => [e.id, e.state])).toEqual([['m1', 'failed']]);
    expect(events).toContainEqual({ type: 'state', channelId: CHANNEL, id: 'm1', state: 'failed' });
    expect(upload).toHaveBeenCalledOnce();
  });
});

describe('F2 the stall watch stops at the last byte', () => {
  class FakeXhr extends EventTarget {
    upload = new EventTarget();
    aborted = false;
    abort(): void {
      this.aborted = true;
      this.dispatchEvent(new Event('loadend'));
    }
  }

  it('a response 60s after the last byte succeeds (no abort)', async () => {
    vi.useFakeTimers();
    const request = new FakeXhr();
    watchUploadStall(request);
    request.upload.dispatchEvent(new Event('progress'));
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS - 1);
    request.upload.dispatchEvent(new Event('load'));
    // Past the 30s stall window, well within the response wait.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request.aborted).toBe(false);
    request.dispatchEvent(new Event('loadend'));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(UPLOAD_RESPONSE_WAIT_MS);
    expect(request.aborted).toBe(false);
  });

  it('no response 120s after the last byte aborts (transient); response events do not extend it', async () => {
    vi.useFakeTimers();
    const request = new FakeXhr();
    watchUploadStall(request);
    request.upload.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(60_000);
    request.dispatchEvent(new Event('readystatechange'));
    await vi.advanceTimersByTimeAsync(UPLOAD_RESPONSE_WAIT_MS - 60_000 - 1);
    expect(request.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // The abort surfaces as status 0: transient.
    expect(classifyUploadFailure(NETWORK, 0)).toBe('transient');
  });

  it('before the last byte, 30s without progress still aborts', async () => {
    vi.useFakeTimers();
    const request = new FakeXhr();
    watchUploadStall(request);
    await vi.advanceTimersByTimeAsync(UPLOAD_STALL_MS);
    expect(request.aborted).toBe(true);
  });
});

describe('F3 Retry re-stamps; a record keeps what is queued behind it in place', () => {
  it('Retry stamps the entry with the clock at the tap', async () => {
    let clock = 5_000;
    const { sender } = harness({
      deps: {
        now: () => clock,
        deliver: async () => ({
          ok: false,
          reason: 'error',
          error: 'not a member',
          errorClass: 'permanent',
        }),
      },
    });
    sender.enqueue(CHANNEL, entry('m1', { createdMs: 1_000 }));
    await vi.waitFor(() => expect(sender.entries(CHANNEL)[0]?.state).toBe('failed'));
    expect(sender.entries(CHANNEL)[0]?.createdMs).toBe(1_000);
    clock = 9_000;
    sender.retry(CHANNEL, 'm1');
    expect(sender.entries(CHANNEL)[0]?.createdMs).toBe(9_000);
    sender.dispose();
  });

  it('sends tapped before the row landed are re-stamped just after its server time', async () => {
    let release: (() => void) | undefined;
    const { sender, recorded } = harness({
      deps: {
        deliver: async (_c, e, _t, onRecorded) => {
          if (e.id === 'p1') await new Promise<void>((resolve) => (release = resolve));
          // p2 stays in flight so its stamp can be read.
          else await new Promise<void>(() => {});
          const message = rowToThreadMessage(row(e.id, 1_400), ME);
          recorded.push(e.id);
          onRecorded(message);
          return { ok: true, message, livePublished: false };
        },
      },
    });
    sender.enqueue(CHANNEL, entry('p1', { createdMs: 1_000 }));
    sender.enqueue(CHANNEL, entry('p2', { createdMs: 1_001 }));
    sender.enqueue(CHANNEL, entry('p3', { createdMs: 5_000 }));
    release?.();
    await vi.waitFor(() => expect(recorded).toContain('p1'));
    // p2 (tapped before p1's row) now reads just after it; p3 was already later.
    const stamps = new Map(sender.entries(CHANNEL).map((e) => [e.id, e.createdMs]));
    expect(stamps.get('p1')).toBeUndefined();
    expect(stamps.get('p2')).toBe(1_401);
    expect(stamps.get('p3')).toBe(5_000);
    sender.dispose();
  });
});

describe('F5 no attempts while offline', () => {
  it('backoff attempts are skipped offline; the online kick fires at once', async () => {
    vi.useFakeTimers();
    let online = true;
    let failing = true;
    const { sender, calls, recorded } = harness({
      fail: () => failing,
      deps: { isOnline: () => online },
    });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    online = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toHaveLength(1);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    expect(vi.getTimerCount()).toBe(0);
    online = true;
    failing = false;
    sender.kick();
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded).toEqual(['m1']);
  });
});

describe('F7a a restore that hangs gives up at 5s', () => {
  it('filesMissing at 5s, and the next entry proceeds', async () => {
    vi.useFakeTimers();
    const hanging: OutboxFileAdapter = {
      put: async () => {},
      get: () => new Promise(() => {}),
      keys: async () => [],
      delete: async () => {},
      clear: async () => {},
      close: () => {},
    };
    const waiting = entry('r1', {
      local: {
        attachments: [{ assetId: '', name: 'a.png', mime: 'image/png', size: 3 }],
        sharedPostIds: [],
        reply: null,
      },
      restoring: true,
    });
    const { sender, recorded } = harness({ initial: { [CHANNEL]: [waiting, entry('m2')] } });
    const previews = vi.fn(() => 'blob:x');
    void restoreOutboxFiles(hanging, waiting, previews).then((attachments) =>
      sender.restoreFiles(CHANNEL, 'r1', attachments),
    );
    await vi.advanceTimersByTimeAsync(RESTORE_TIMEOUT_MS - 1);
    expect(recorded).toEqual([]);
    expect(sender.entries(CHANNEL)[0]?.restoring).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(sender.entries(CHANNEL)[0]).toMatchObject({
      id: 'r1',
      state: 'failed',
      filesMissing: true,
    });
    expect(recorded).toEqual(['m2']);
    expect(previews).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('F7b PGRST202', () => {
  it('a function missing from the schema cache (deploy) is transient', () => {
    expect(
      classifyRecordFailure({
        status: 404,
        code: 'PGRST202',
        message: 'Could not find the function',
      }),
    ).toBe('transient');
    expect(classifyRecordFailure({ status: 400, code: 'PGRST204', message: 'x' })).toBe(
      'permanent',
    );
  });
});
