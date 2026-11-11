import { describe, expect, it, vi } from 'vitest';
import {
  canForwardComment,
  commentForwardRecord,
  forwardComment,
  type CommentForwardSource,
} from '@/lib/chat/forward-comment';

const PDF = { assetId: 'v-pdf', name: 'Launch deck.pdf', mime: 'application/pdf', size: 1200 };
const PNG = { assetId: 'v-png', name: 'Grid.png', mime: 'image/png', size: 900 };
const ids = { id: 'm1', channelId: 'ch1', traceId: 't1' };

describe('canForwardComment', () => {
  it('a sent, live comment with text or at least one file', () => {
    const base = { sent: true, deleted: false, body: 'hi', fileCount: 0 };
    expect(canForwardComment(base)).toBe(true);
    expect(canForwardComment({ ...base, body: '  ', fileCount: 1 })).toBe(true);
    expect(canForwardComment({ ...base, body: '', fileCount: 0 })).toBe(false);
    expect(canForwardComment({ ...base, deleted: true })).toBe(false);
    expect(canForwardComment({ ...base, sent: false })).toBe(false);
  });
});

describe('commentForwardRecord', () => {
  it('carries the text and every attachment id as stored, with its meta; no source message', () => {
    const record = commentForwardRecord({ body: 'See these', attachments: [PDF, PNG] }, ids);
    expect(record).toMatchObject({
      id: 'm1',
      channelId: 'ch1',
      traceId: 't1',
      body: 'See these',
      attachmentAssetIds: ['v-pdf', 'v-png'],
      replyToMessageId: null,
      forwardedFromMessageId: null,
    });
    expect(record.attachmentMeta?.['v-pdf']).toMatchObject({
      mime: 'application/pdf',
      name: 'Launch deck.pdf',
      size: 1200,
    });
    expect(record.sharedPostIds).toEqual([]);
  });

  it('a file-only comment sends its files with an empty body; unknown details still send the id', () => {
    const record = commentForwardRecord(
      { body: '', attachments: [{ assetId: 'v-x', name: '', mime: '' }] },
      ids,
    );
    expect(record.body).toBe('');
    expect(record.attachmentAssetIds).toEqual(['v-x']);
  });
});

describe('forwardComment', () => {
  const chats = [{ channelId: 'a' }, { channelId: 'b' }];
  const source: CommentForwardSource = { body: 'hi', attachments: [PDF] };
  type Record = Parameters<Parameters<typeof forwardComment>[0]['send']>[0];
  const deps = (
    over: {
      targets?: Array<{ channelId: string }>;
      source?: CommentForwardSource | null;
      results?: boolean[];
    } = {},
  ) => {
    let n = 0;
    const results = [...(over.results ?? [])];
    return {
      targets: over.targets ?? chats,
      load: vi.fn(() =>
        Promise.resolve<CommentForwardSource | null>(
          over.source === undefined ? source : over.source,
        ),
      ),
      send: vi.fn((_record: Record) => Promise.resolve({ ok: results.shift() ?? true })),
      newId: () => `m${(n += 1)}`,
      newTrace: () => 'trace',
    };
  };

  it('one message per picked chat, each with the files; the source is loaded once, after Send', async () => {
    const d = deps();
    expect(await forwardComment(d)).toEqual({ ok: true });
    expect(d.load).toHaveBeenCalledOnce();
    expect(d.send.mock.calls.map(([r]) => [r.channelId, r.id, r.attachmentAssetIds])).toEqual([
      ['a', 'm1', ['v-pdf']],
      ['b', 'm2', ['v-pdf']],
    ]);
  });

  it('the first failed send stops the run and names its chat', async () => {
    const d = deps({ results: [true, false], targets: [...chats, { channelId: 'c' }] });
    expect(await forwardComment(d)).toEqual({ ok: false, failed: { channelId: 'b' } });
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  it('a failed read, or nothing to send, fails on the first chat and sends nothing', async () => {
    const failed = deps({ source: null });
    expect(await forwardComment(failed)).toEqual({ ok: false, failed: { channelId: 'a' } });
    expect(failed.send).not.toHaveBeenCalled();
    const empty = deps({ source: { body: ' ', attachments: [] } });
    expect(await forwardComment(empty)).toEqual({ ok: false, failed: { channelId: 'a' } });
    expect(empty.send).not.toHaveBeenCalled();
  });

  it('no chats picked: nothing is read or sent', async () => {
    const d = deps({ targets: [] });
    expect(await forwardComment(d)).toEqual({ ok: true });
    expect(d.load).not.toHaveBeenCalled();
  });
});
