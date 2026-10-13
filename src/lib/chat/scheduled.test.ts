import { describe, expect, it, vi } from 'vitest';
import {
  cancelScheduledMessage,
  customSummary,
  dateInputValue,
  formatClock,
  formatDayTime,
  formatSendLabel,
  fromInputs,
  inSentence,
  isWithinScheduleWindow,
  mapScheduleError,
  MAX_LEAD_MS,
  presetTimes,
  readScheduledMessages,
  rowMentions,
  scheduledCountLabel,
  scheduleMessage,
  sendScheduledNow,
  shortZoneName,
  soonestFirst,
  timeInputValue,
  updateScheduledMessage,
  announceScheduledChanged,
  onScheduledChanged,
  scheduleAttachmentArgs,
  scheduleWithFiles,
  SCHEDULED_CHANGED_EVENT,
  uploadScheduleFiles,
  type ScheduledRow,
} from '@/lib/chat/scheduled';
import type { Client } from '@srtdio/rpc';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildAttachmentMeta,
  parseAttachmentMeta,
  toLocalAttachment,
  withoutLocal,
  type AttachmentUploader,
  rememberThumbnail,
} from '@/lib/chat/attachments';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';

const EM_DASH = String.fromCharCode(0x2014);

/** Local wall-clock time (the device zone, like the app). */
function at(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe('presetTimes', () => {
  it('Saturday: tomorrow is Sunday, Monday is the day after', () => {
    const p = presetTimes(at(2026, 10, 3, 15, 20));
    expect(p.tomorrow).toEqual(at(2026, 10, 4, 9));
    expect(p.monday).toEqual(at(2026, 10, 5, 9));
  });

  it('Sunday: Monday is tomorrow', () => {
    const p = presetTimes(at(2026, 10, 4, 8));
    expect(p.tomorrow).toEqual(at(2026, 10, 5, 9));
    expect(p.monday).toEqual(at(2026, 10, 5, 9));
  });

  it('Monday: the next Monday, a week ahead (never today)', () => {
    const p = presetTimes(at(2026, 10, 5, 7));
    expect(p.tomorrow).toEqual(at(2026, 10, 6, 9));
    expect(p.monday).toEqual(at(2026, 10, 12, 9));
  });

  it('rolls over the month', () => {
    const p = presetTimes(at(2026, 10, 31, 10)); // Saturday
    expect(p.tomorrow).toEqual(at(2026, 11, 1, 9));
    expect(p.monday).toEqual(at(2026, 11, 2, 9));
  });

  it('rolls over the year', () => {
    const p = presetTimes(at(2026, 12, 31, 22)); // Thursday
    expect(p.tomorrow).toEqual(at(2027, 1, 1, 9));
    expect(p.monday).toEqual(at(2027, 1, 4, 9));
  });

  it('always 9:00 AM local', () => {
    const p = presetTimes(at(2026, 3, 10, 23, 59));
    expect(p.tomorrow.getHours()).toBe(9);
    expect(p.tomorrow.getMinutes()).toBe(0);
    expect(p.monday.getHours()).toBe(9);
  });
});

describe('isWithinScheduleWindow', () => {
  const now = at(2026, 10, 3, 12);
  it('1 minute ahead is the earliest', () => {
    expect(isWithinScheduleWindow(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(isWithinScheduleWindow(new Date(now.getTime() + 59_999), now)).toBe(false);
    expect(isWithinScheduleWindow(now, now)).toBe(false);
    expect(isWithinScheduleWindow(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it('365 days ahead is the latest', () => {
    expect(isWithinScheduleWindow(new Date(now.getTime() + MAX_LEAD_MS), now)).toBe(true);
    expect(isWithinScheduleWindow(new Date(now.getTime() + MAX_LEAD_MS + 1), now)).toBe(false);
  });

  it('an invalid date is outside', () => {
    expect(isWithinScheduleWindow(new Date(Number.NaN), now)).toBe(false);
  });
});

describe('labels', () => {
  const now = at(2026, 10, 3, 15);
  it('formatClock', () => {
    expect(formatClock(at(2026, 10, 4, 9))).toBe('9:00 AM');
    expect(formatClock(at(2026, 10, 4, 0, 5))).toBe('12:05 AM');
    expect(formatClock(at(2026, 10, 4, 12, 0))).toBe('12:00 PM');
    expect(formatClock(at(2026, 10, 4, 23, 30))).toBe('11:30 PM');
  });

  it('formatDayTime: the preset row text', () => {
    expect(formatDayTime(at(2026, 10, 4, 9), now)).toBe('Sun 4 Oct, 9:00 AM');
    expect(formatDayTime(at(2027, 1, 4, 9), now)).toBe('Mon 4 Jan 2027, 9:00 AM');
  });

  it('formatSendLabel: today, tomorrow, else the day', () => {
    expect(formatSendLabel(at(2026, 10, 3, 18), now)).toBe('Today 6:00 PM');
    expect(formatSendLabel(at(2026, 10, 4, 9), now)).toBe('Tomorrow 9:00 AM');
    expect(formatSendLabel(at(2026, 10, 7, 11, 30), now)).toBe('Wed 7 Oct, 11:30 AM');
  });

  it('formatSendLabel: tomorrow across a month and a year', () => {
    expect(formatSendLabel(at(2026, 11, 1, 9), at(2026, 10, 31, 20))).toBe('Tomorrow 9:00 AM');
    expect(formatSendLabel(at(2027, 1, 1, 9), at(2026, 12, 31, 20))).toBe('Tomorrow 9:00 AM');
  });

  it('inSentence lowers only today / tomorrow', () => {
    expect(inSentence('Tomorrow 9:00 AM')).toBe('tomorrow 9:00 AM');
    expect(inSentence('Today 6:00 PM')).toBe('today 6:00 PM');
    expect(inSentence('Wed 7 Oct, 11:30 AM')).toBe('Wed 7 Oct, 11:30 AM');
  });

  it('customSummary', () => {
    expect(customSummary(at(2026, 10, 7, 11, 30), now)).toBe('Sends Wed 7 Oct at 11:30 AM');
  });

  it('count label', () => {
    expect(scheduledCountLabel(1)).toBe('1 scheduled message');
    expect(scheduledCountLabel(3)).toBe('3 scheduled messages');
  });

  it('no em-dash in any label', () => {
    for (const s of [
      formatSendLabel(at(2026, 10, 7), now),
      customSummary(at(2026, 10, 7), now),
      formatDayTime(at(2026, 10, 7), now),
    ]) {
      expect(s).not.toContain(EM_DASH);
    }
  });
});

describe('inputs', () => {
  it('round-trips native input values in local time', () => {
    const d = at(2026, 1, 5, 7, 4);
    expect(dateInputValue(d)).toBe('2026-01-05');
    expect(timeInputValue(d)).toBe('07:04');
    expect(fromInputs('2026-01-05', '07:04')).toEqual(d);
  });

  it('an incomplete value is null', () => {
    expect(fromInputs('', '09:00')).toBeNull();
    expect(fromInputs('2026-01-05', '')).toBeNull();
  });
});

describe('shortZoneName', () => {
  it('comes from Intl, never a fixed zone', () => {
    const name = shortZoneName(new Date());
    expect(typeof name).toBe('string');
  });
});

describe('mapScheduleError', () => {
  it('maps the proc messages', () => {
    expect(mapScheduleError('send time must be between 1 minute and 1 year from now')).toBe(
      'Pick a time at least 1 minute from now',
    );
    expect(mapScheduleError('too many scheduled messages')).toBe(
      'You already have 100 scheduled messages',
    );
    expect(mapScheduleError('scheduled message not found')).toBeNull();
    expect(mapScheduleError('TypeError: fetch failed')).toBe("Couldn't schedule. Try again.");
  });
});

describe('rows', () => {
  const row = (id: string, sendAt: string, status = 'scheduled'): ScheduledRow =>
    ({ id, send_at: sendAt, status, mentions: null }) as unknown as ScheduledRow;

  it('soonestFirst keeps scheduled rows only, soonest first', () => {
    const out = soonestFirst([
      row('b', '2026-10-07T06:00:00Z'),
      row('x', '2026-10-04T06:00:00Z', 'cancelled'),
      row('a', '2026-10-04T03:30:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('rowMentions reads a JSON array of ids only', () => {
    expect(rowMentions({ mentions: ['u1', 'all', 3] })).toEqual(['u1', 'all']);
    expect(rowMentions({ mentions: null })).toEqual([]);
  });
});

/** A recording fake of the Supabase client: rpc(name, args).abortSignal(). */
function fakeClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { abortSignal: () => Promise.resolve({ ...answer, status: 200 }) };
    }),
  } as unknown as Client;
  return { client, calls };
}

describe('proc wrappers', () => {
  const sendAt = new Date('2026-10-04T03:30:00.000Z');

  it('chat_message_schedule: trace id explicit, empty parts omitted', async () => {
    const { client, calls } = fakeClient({ data: { id: 'm1' }, error: null });
    const res = await scheduleMessage({
      client,
      id: 'm1',
      channelId: 'c1',
      sendAt,
      traceId: 't1',
      body: '  hi @[u1]  ',
      mentions: ['u1'],
      attachmentAssetIds: [],
      sharedPostIds: ['p1'],
      sharedBriefIds: [],
      replyToMessageId: 'r1',
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      name: 'chat_message_schedule',
      args: {
        p_id: 'm1',
        p_channel_id: 'c1',
        p_send_at: '2026-10-04T03:30:00.000Z',
        p_trace_id: 't1',
        p_body: 'hi @[u1]',
        p_mentions: ['u1'],
        p_shared_post_ids: ['p1'],
        p_reply_to_message_id: 'r1',
      },
    });
  });

  it('an error resolves with the raw message, never throws', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'too many scheduled messages' },
    });
    const res = await scheduleMessage({
      client,
      id: 'm1',
      channelId: 'c1',
      sendAt,
      traceId: 't1',
      body: 'x',
      mentions: [],
      attachmentAssetIds: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      replyToMessageId: null,
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'too many scheduled messages',
    });
  });

  it('update, cancel and send now pass p_id and p_trace_id', async () => {
    const { client, calls } = fakeClient({ data: { id: 'm1' }, error: null });
    await updateScheduledMessage({
      client,
      id: 'm1',
      sendAt,
      body: 'b',
      mentions: [],
      traceId: 't2',
    });
    await cancelScheduledMessage({ client, id: 'm1', channelId: 'c1', traceId: 't3' });
    await sendScheduledNow({ client, id: 'm1', traceId: 't4' });
    expect(calls.map((c) => c.name)).toEqual([
      'chat_scheduled_update',
      'chat_scheduled_cancel',
      'chat_scheduled_send_now',
    ]);
    expect(calls[0]?.args).toEqual({
      p_id: 'm1',
      p_send_at: '2026-10-04T03:30:00.000Z',
      p_body: 'b',
      p_mentions: [],
      p_trace_id: 't2',
    });
    expect(calls[1]?.args).toEqual({ p_id: 'm1', p_trace_id: 't3' });
    expect(calls[2]?.args).toEqual({ p_id: 'm1', p_trace_id: 't4' });
  });

  it('a throw resolves to a failure', async () => {
    const client = {
      rpc: () => {
        throw new Error('boom');
      },
    } as unknown as Client;
    const res = await cancelScheduledMessage({ client, id: 'm1', channelId: 'c1', traceId: 't' });
    expect(res.ok).toBe(false);
  });
});

describe('readScheduledMessages', () => {
  it('filters to the chat and status scheduled, soonest first', async () => {
    const filters: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      order: () =>
        Promise.resolve({
          data: [
            { id: 'b', send_at: '2026-10-07T06:00:00Z', status: 'scheduled' },
            { id: 'a', send_at: '2026-10-04T03:30:00Z', status: 'scheduled' },
          ],
          error: null,
        }),
    };
    const client = { from: () => builder } as unknown as Client;
    const res = await readScheduledMessages(client, { channelId: 'c1' });
    expect(filters).toEqual([
      ['channel_id', 'c1'],
      ['status', 'scheduled'],
    ]);
    expect(res.ok && res.data.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Scheduling with photos and files (UI-3)
// ---------------------------------------------------------------------------

function photo(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
}
function doc(name: string, size = 20): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

/** An uploader that answers each file by name (vN for the Nth call), or fails the named ones. */
function fakeUploader(opts: { fail?: string[]; hold?: Promise<void> } = {}) {
  let n = 0;
  const seen: string[] = [];
  const upload: AttachmentUploader = async (file, onProgress, signal) => {
    seen.push(file.name);
    n += 1;
    const id = `ver-${n}-${file.name}`;
    onProgress?.(0.5);
    if (opts.hold !== undefined) await opts.hold;
    if (signal?.aborted) return { ok: false, message: 'upload cancelled' };
    if (opts.fail?.includes(file.name)) return { ok: false, message: 'Upload failed. Try again' };
    onProgress?.(1);
    return { ok: true, reused: false, versionId: id };
  };
  return { upload, seen };
}

/** What the normal send records for the same files: local attachments, then the version ids. */
function normalSendArgs(files: File[], versionIds: string[]) {
  const sent = files.map((file, i) => ({
    ...withoutLocal(toLocalAttachment(file, null, undefined)),
    assetId: versionIds[i] ?? '',
  }));
  return {
    attachmentAssetIds: sent.map((a) => a.assetId),
    attachmentMeta: buildAttachmentMeta(sent),
  };
}

async function scheduleFiles(
  files: File[],
  upload: AttachmentUploader,
  signal = new AbortController().signal,
) {
  const { client, calls } = fakeClient({ data: { id: 'm1', channel_id: 'c1' }, error: null });
  const outcome = await scheduleWithFiles({
    files: files.map((file, i) => ({ key: `k${i}`, file, versionId: null })),
    upload,
    signal,
    write: (args) =>
      scheduleMessage({
        client,
        id: 'm1',
        channelId: 'c1',
        sendAt: new Date('2026-10-04T03:30:00.000Z'),
        traceId: 't1',
        body: '',
        mentions: [],
        sharedPostIds: [],
        sharedBriefIds: [],
        replyToMessageId: null,
        ...args,
      }),
  });
  return { outcome, calls };
}

describe('UI-3: scheduling with photos and files', () => {
  it('one photo: uploaded, then scheduled with its version id and meta', async () => {
    const { upload } = fakeUploader();
    const files = [photo('a.jpg')];
    const { outcome, calls } = await scheduleFiles(files, upload);
    expect(outcome.kind).toBe('written');
    const expected = normalSendArgs(files, ['ver-1-a.jpg']);
    expect(calls[0]?.args.p_attachment_asset_ids).toEqual(expected.attachmentAssetIds);
    expect(calls[0]?.args.p_attachment_meta).toEqual(expected.attachmentMeta);
    // Empty text with files: no p_body at all (the proc allows it with attachments).
    expect(calls[0]?.args).not.toHaveProperty('p_body');
    expect(calls[0]?.args.p_trace_id).toBe('t1');
  });

  it('five photos: every file uploads, ids in chip order, meta equals a normal send', async () => {
    const { upload, seen } = fakeUploader();
    const files = ['1', '2', '3', '4', '5'].map((n) => photo(`${n}.jpg`, Number(n)));
    const { calls } = await scheduleFiles(files, upload);
    expect(seen).toHaveLength(5);
    const ids = files.map((f, i) => `ver-${i + 1}-${f.name}`);
    expect(calls[0]?.args.p_attachment_asset_ids).toEqual(ids);
    expect(calls[0]?.args.p_attachment_meta).toEqual(normalSendArgs(files, ids).attachmentMeta);
  });

  it('mixed photo and file, and a file alone with empty text', async () => {
    const mixed = [photo('p.jpg'), doc('brief.pdf')];
    const a = await scheduleFiles(mixed, fakeUploader().upload);
    expect(a.calls[0]?.args.p_attachment_meta).toEqual(
      normalSendArgs(mixed, ['ver-1-p.jpg', 'ver-2-brief.pdf']).attachmentMeta,
    );
    const only = [doc('deck.pdf')];
    const b = await scheduleFiles(only, fakeUploader().upload);
    expect(b.calls[0]?.args).toMatchObject({
      p_attachment_asset_ids: ['ver-1-deck.pdf'],
      p_attachment_meta: {
        'ver-1-deck.pdf': { mime: 'application/pdf', name: 'deck.pdf', size: 20 },
      },
    });
  });

  it('one failed upload: no RPC call, the failed key is named, the others are kept', async () => {
    const uploaded: string[] = [];
    const { upload } = fakeUploader({ fail: ['b.jpg'] });
    const { client, calls } = fakeClient({ data: { id: 'm1' }, error: null });
    const write = vi.fn(() =>
      scheduleMessage({
        client,
        id: 'm1',
        channelId: 'c1',
        sendAt: new Date(),
        traceId: 't',
        body: 'x',
        mentions: [],
        attachmentAssetIds: [],
        sharedPostIds: [],
        sharedBriefIds: [],
        replyToMessageId: null,
      }),
    );
    const outcome = await scheduleWithFiles({
      files: [
        { key: 'a', file: photo('a.jpg'), versionId: null },
        { key: 'b', file: photo('b.jpg'), versionId: null },
      ],
      upload,
      signal: new AbortController().signal,
      onUploaded: (key) => uploaded.push(key),
      write,
    });
    expect(outcome).toEqual({ kind: 'upload-failed', failedKeys: ['b'] });
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(uploaded).toEqual(['a']);
  });

  it('a retry re-uploads only the failed file', async () => {
    const { upload, seen } = fakeUploader();
    const outcome = await scheduleWithFiles({
      files: [
        { key: 'a', file: photo('a.jpg'), versionId: 'ver-done' },
        { key: 'b', file: photo('b.jpg'), versionId: null },
      ],
      upload,
      signal: new AbortController().signal,
      write: async (args) => args,
    });
    expect(seen).toEqual(['b.jpg']);
    expect(outcome.kind === 'written' && outcome.result.attachmentAssetIds).toEqual([
      'ver-done',
      'ver-1-b.jpg',
    ]);
  });

  it('a chat switch mid-upload aborts the uploads and calls no RPC', async () => {
    let release = (): void => undefined;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { upload } = fakeUploader({ hold });
    const run = new AbortController();
    const pending = scheduleFiles([photo('a.jpg'), doc('b.pdf')], upload, run.signal);
    run.abort();
    release();
    const { outcome, calls } = await pending;
    expect(outcome).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([]);
  });

  it('no uploader with files: nothing is scheduled', async () => {
    const write = vi.fn(async () => true);
    const outcome = await scheduleWithFiles({
      files: [{ key: 'a', file: photo('a.jpg'), versionId: null }],
      upload: undefined,
      signal: new AbortController().signal,
      write,
    });
    expect(outcome).toEqual({ kind: 'upload-failed', failedKeys: ['a'] });
    expect(write).not.toHaveBeenCalled();
  });

  it('no files: the write runs at once with empty attachment args', async () => {
    const outcome = await scheduleWithFiles({
      files: [],
      upload: undefined,
      signal: new AbortController().signal,
      write: async (args) => args,
    });
    expect(outcome).toEqual({
      kind: 'written',
      result: { attachmentAssetIds: [], attachmentMeta: {} },
    });
    expect(scheduleAttachmentArgs([])).toEqual({ attachmentAssetIds: [], attachmentMeta: {} });
  });

  it('progress is reported per file, never after an abort', async () => {
    const progress: Array<[string, number]> = [];
    const run = new AbortController();
    await uploadScheduleFiles({
      files: [{ key: 'a', file: photo('a.jpg'), versionId: null }],
      upload: fakeUploader().upload,
      signal: run.signal,
      onProgress: (key, f) => progress.push([key, f]),
    });
    expect(progress).toEqual([
      ['a', 0.5],
      ['a', 1],
    ]);
  });
});

describe('UI-3 S6: Send now carries the attachments', () => {
  it('the recorded row renders its attachments exactly as the Worker reads them', () => {
    const meta = { v1: { mime: 'image/png', name: 'a.png', size: 3 } };
    const row = {
      id: 'm1',
      channel_id: 'c1',
      sender_user_id: 'u1',
      body: '',
      attachment_asset_ids: ['v1'],
      attachment_meta: meta,
      shared_post_ids: null,
      shared_brief_ids: null,
      reply_to_message_id: null,
      deleted_at: null,
      created_at: '2026-10-03T10:00:00Z',
    } as unknown as ChatMessageRow;
    const message = rowToThreadMessage(row, 'u1');
    expect(message.attachments).toEqual(parseAttachmentMeta(meta, ['v1']));
    expect(message.attachments[0]).toMatchObject({ assetId: 'v1', mime: 'image/png' });
  });

  it('addSentRow publishes the row message attachments live', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./use-chat-thread.ts', import.meta.url)),
      'utf8',
    );
    const body = src.slice(src.indexOf('const addSentRow'), src.indexOf('const forward ='));
    expect(body).toContain('rowToThreadMessage(row, currentUserId)');
    expect(body).toContain('attachments: message.attachments');
  });
});

describe('UI-3 S8: sorted:scheduled-changed', () => {
  function stubWindow() {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen: string[] = [];
    target.addEventListener(SCHEDULED_CHANGED_EVENT, (e) => {
      seen.push((e as CustomEvent<{ channelId: string }>).detail.channelId);
    });
    return { target, seen };
  }

  it('every wrapper announces its chat after success', async () => {
    const { seen } = stubWindow();
    const ok = fakeClient({ data: { id: 'm1', channel_id: 'c9' }, error: null });
    await scheduleMessage({
      client: ok.client,
      id: 'm1',
      channelId: 'c1',
      sendAt: new Date(),
      traceId: 't',
      body: 'x',
      mentions: [],
      attachmentAssetIds: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      replyToMessageId: null,
    });
    await updateScheduledMessage({
      client: ok.client,
      id: 'm1',
      sendAt: new Date(),
      body: 'x',
      mentions: [],
      traceId: 't',
    });
    await cancelScheduledMessage({ client: ok.client, id: 'm1', channelId: 'c2', traceId: 't' });
    await sendScheduledNow({ client: ok.client, id: 'm1', traceId: 't' });
    expect(seen).toEqual(['c1', 'c9', 'c2', 'c9']);
    vi.unstubAllGlobals();
  });

  it('a failed write announces nothing', async () => {
    const { seen } = stubWindow();
    const bad = fakeClient({ data: null, error: { message: 'boom' } });
    await cancelScheduledMessage({ client: bad.client, id: 'm1', channelId: 'c2', traceId: 't' });
    await sendScheduledNow({ client: bad.client, id: 'm1', traceId: 't' });
    expect(seen).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('onScheduledChanged runs only for its chat, and unsubscribes', () => {
    stubWindow();
    const listener = vi.fn();
    const stop = onScheduledChanged('c1', listener);
    announceScheduledChanged('c2');
    expect(listener).not.toHaveBeenCalled();
    announceScheduledChanged('c1');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    announceScheduledChanged('c1');
    expect(listener).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('without a window it is a no-op', () => {
    expect(() => announceScheduledChanged('c1')).not.toThrow();
    expect(onScheduledChanged('c1', () => undefined)()).toBeUndefined();
  });
});

describe('scheduled send carries the thumbnail meta', () => {
  it('a scheduled PDF writes page_count / thumb_w / thumb_h and the dispatch parser keeps them', () => {
    const args = scheduleAttachmentArgs([
      {
        assetId: 'v-pdf',
        name: 'deck.pdf',
        mime: 'application/pdf',
        size: 900,
        pageCount: 3,
        thumbW: 580,
        thumbH: 751,
      },
    ]);
    expect(args.attachmentMeta['v-pdf']).toEqual({
      mime: 'application/pdf',
      name: 'deck.pdf',
      size: 900,
      page_count: 3,
      thumb_w: 580,
      thumb_h: 751,
    });
    // chat-scheduled-send reads the row back with the shared parser.
    expect(parseAttachmentMeta(args.attachmentMeta, args.attachmentAssetIds)).toEqual([
      {
        assetId: 'v-pdf',
        name: 'deck.pdf',
        mime: 'application/pdf',
        size: 900,
        pageCount: 3,
        thumbW: 580,
        thumbH: 751,
      },
    ]);
  });

  it('a file uploaded for a schedule gets the thumbnail the Worker stored for its version', () => {
    rememberThumbnail('v-sched', { width: 580, height: 326 });
    const args = scheduleAttachmentArgs([
      { assetId: 'v-sched', name: 'clip.mp4', mime: 'video/mp4', size: 10 },
    ]);
    expect(args.attachmentMeta['v-sched']).toMatchObject({ thumb_w: 580, thumb_h: 326 });
    expect(args.attachmentMeta['v-sched']?.page_count).toBeUndefined();
  });
});
