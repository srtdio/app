import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/comments';
import {
  COMMENT_FILE_COLUMNS,
  commentViewerTitle,
  fetchCommentFiles,
  idsToRead,
  parseCommentFileRow,
  toCommentFileAttachments,
  type CommentFile,
} from '@/components/comments/comment-files';
import { fileMetaParts } from '@/components/chat/FileBubble';
import { attachmentView } from '@/components/chat/MessageAttachments';
import { formatAgo } from '@/lib/time';
import { humanizeSize } from '@/lib/assets';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The card's line under the name, as it reads. */
function line(parts: Array<{ text: string }>): string {
  return parts.map((p) => p.text).join(' · ');
}

/** A query builder double: records the select and the id list, answers `result`. */
function fakeClient(result: { data: unknown; error: unknown } | Error): {
  client: Client;
  calls: Array<{ table: string; columns: string; ids: string[] }>;
} {
  const calls: Array<{ table: string; columns: string; ids: string[] }> = [];
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        in: async (_col: string, ids: string[]) => {
          calls.push({ table, columns, ids });
          if (result instanceof Error) throw result;
          return result;
        },
      }),
    }),
  } as unknown as Client;
  return { client, calls };
}

describe('the batched files read', () => {
  it('selects name, mime, size and page count in ONE query with the asset name embedded', () => {
    expect(COMMENT_FILE_COLUMNS).toContain('mime_type');
    expect(COMMENT_FILE_COLUMNS).toContain('size_bytes');
    expect(COMMENT_FILE_COLUMNS).toContain('page_count');
    // The embed names its foreign key: asset_versions and assets have two
    // foreign keys between them, so a bare assets(...) answers HTTP 300.
    expect(COMMENT_FILE_COLUMNS).toContain('assets!asset_id(display_name, filename)');
    expect(COMMENT_FILE_COLUMNS).not.toMatch(/(^|[ ,])assets\(/);
  });

  it('asks once for every id (deduped, blanks dropped), no N+1', async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          id: 'v1',
          mime_type: 'application/pdf',
          size_bytes: 2_400_000,
          page_count: 12,
          width: null,
          height: null,
          assets: { display_name: 'Launch deck.pdf', filename: 'upload-1.pdf' },
        },
        {
          id: 'v2',
          mime_type: 'image/jpeg',
          size_bytes: 900_000,
          page_count: null,
          width: 1200,
          height: 900,
          assets: { display_name: null, filename: 'IMG_0042.jpg' },
        },
      ],
      error: null,
    });
    const files = await fetchCommentFiles(client, ['v1', 'v2', 'v1', '']);
    expect(calls).toEqual([
      { table: 'asset_versions', columns: COMMENT_FILE_COLUMNS, ids: ['v1', 'v2'] },
    ]);
    expect(files?.get('v1')).toEqual({
      name: 'Launch deck.pdf',
      mime: 'application/pdf',
      size: 2_400_000,
      pageCount: 12,
    });
    expect(files?.get('v2')).toEqual({
      name: 'IMG_0042.jpg',
      mime: 'image/jpeg',
      size: 900_000,
      width: 1200,
      height: 900,
    });
  });

  it('no ids: no query', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect((await fetchCommentFiles(client, ['']))?.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('an error or a throw is null (asked again next pass), never a throw', async () => {
    const failed = fakeClient({ data: null, error: { message: 'boom' } });
    expect(await fetchCommentFiles(failed.client, ['v1'])).toBeNull();
    const thrown = fakeClient(new Error('offline'));
    expect(await fetchCommentFiles(thrown.client, ['v1'])).toBeNull();
  });

  it('parses an embedded asset given as a one-item array too, and skips rows with no id', () => {
    expect(
      parseCommentFileRow({ id: 'v3', mime_type: DOCX, assets: [{ filename: 'Brief.docx' }] }),
    ).toEqual(['v3', { name: 'Brief.docx', mime: DOCX }]);
    expect(parseCommentFileRow({ mime_type: DOCX })).toBeNull();
    expect(parseCommentFileRow(null)).toBeNull();
  });

  it('idsToRead skips blanks, repeats and ids already asked', () => {
    expect(idsToRead(['a', 'b', 'a', '', 'c'], new Set(['c']))).toEqual(['a', 'b']);
  });
});

describe('comment attachments carry name, mime, size and pages', () => {
  const files = new Map<string, CommentFile>([
    ['pdf', { name: 'Launch deck.pdf', mime: 'application/pdf', size: 2_400_000, pageCount: 12 }],
    ['doc', { name: 'Brief.docx', mime: DOCX, size: 48_000 }],
    ['xls', { name: 'Budget.xlsx', mime: XLSX, size: 31_000 }],
    ['img', { name: 'IMG_0042.jpg', mime: 'image/jpeg', size: 900_000, width: 1200, height: 900 }],
  ]);

  it('the card line reads "PDF · n pages · size", "Word · size", "Excel · size"', () => {
    const [pdf, doc, xls] = toCommentFileAttachments(['pdf', 'doc', 'xls'], files);
    expect(line(fileMetaParts(pdf!))).toBe(`PDF · 12 pages · ${humanizeSize(2_400_000)}`);
    expect(line(fileMetaParts(doc!))).toBe(`Word · ${humanizeSize(48_000)}`);
    expect(line(fileMetaParts(xls!))).toBe(`Excel · ${humanizeSize(31_000)}`);
    expect(pdf!.name).toBe('Launch deck.pdf');
  });

  it('a PDF from a comment has no thumbnail meta, so its card is the type tile', () => {
    const [pdf] = toCommentFileAttachments(['pdf'], files);
    expect(pdf!.thumbW).toBeUndefined();
    expect(pdf!.thumbH).toBeUndefined();
  });

  it('a photo keeps its name and pixel size (inline box final) and renders as an image', () => {
    const [img] = toCommentFileAttachments(['img'], files);
    expect(img).toMatchObject({ name: 'IMG_0042.jpg', thumbW: 1200, thumbH: 900 });
    const view = attachmentView({
      attachment: img!,
      presignEnabled: true,
      url: 'https://signed/img',
      failed: false,
    });
    expect(view).toEqual({ kind: 'image', src: 'https://signed/img', alt: 'IMG_0042.jpg' });
  });

  it('an id the read has not answered keeps the file footprint with no name', () => {
    expect(toCommentFileAttachments(['zzz'], files)).toEqual([
      { assetId: 'zzz', name: '', mime: '' },
    ]);
    expect(toCommentFileAttachments(null, files)).toEqual([]);
  });
});

describe('the photo viewer title', () => {
  it('reads "{Name} · {formatAgo}"', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    const at = '2026-11-07T09:55:00Z';
    expect(commentViewerTitle('Maya Rao', at, now)).toBe(`Maya Rao · ${formatAgo(at, now)}`);
    expect(commentViewerTitle('', at, now)).toBe(formatAgo(at, now));
  });
});
