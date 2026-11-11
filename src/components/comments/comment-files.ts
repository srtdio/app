// The comment side of "every comment file opens in-app": one batched read of a
// list's attachment versions that brings back what the file card and the
// viewers need (name, mime, size, PDF page count, image pixel size), and the
// mapper from those rows to MessageAttachment props.
//
// Why comment files did not open properly before: the batched read selected
// only `id, mime_type`, and the mapper set `name: ''`. Every card read
// "Attachment" with no size or page count, the viewer's bar said "Attachment"
// and Download saved a file with no extension. Worse, the read's answer was
// dropped whenever the list changed while it was in flight (the effect's
// cleanup), and its ids were marked attempted, so they were never asked again:
// the mime stayed '', a photo drew as a file card and a tap on a PDF or a
// photo opened "Preview not available yet". A failed read was never retried
// either. The caller now keeps every answer and re-asks only failed ids. The read
// below is still ONE query for every id in view (the name rides in through
// the asset_versions -> assets foreign key as an embedded select, no second
// round trip, no N+1), off the paint path exactly like the mime read it
// replaces. The embed names the foreign key column (`assets!asset_id`):
// asset_versions and assets have two foreign keys between them
// (asset_versions_asset_id_fkey, assets_current_version_id_fkey), so a bare
// `assets(...)` is ambiguous and PostgREST answers HTTP 300 with no rows,
// which drew every comment file as "Attachment / File".

import type { Client } from '@srtdio/comments';
import { classifyAttachment, type MessageAttachment } from '@/lib/chat/attachments';
import { formatAgo } from '@/lib/time';

/**
 * The batched read's column list: the version's own facts plus the asset's
 * name through the asset_versions_asset_id_fkey embed (one query). The
 * `!asset_id` hint is required: without it the embed is ambiguous (HTTP 300).
 */
export const COMMENT_FILE_COLUMNS =
  'id, mime_type, size_bytes, page_count, width, height, assets!asset_id(display_name, filename)';

/** What a comment attachment's card and viewer need, by version id. */
export interface CommentFile {
  /** The asset's display name, else its file name; '' when unreadable. */
  name: string;
  mime: string;
  size?: number;
  /** PDFs: the stored page count, once the upload counted it. */
  pageCount?: number;
  /** Images: the stored pixel size, so the inline box is final when known. */
  width?: number;
  height?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The embedded asset: an object (many-to-one) or, defensively, a one-item array. */
function assetName(asset: unknown): string {
  const row: unknown = Array.isArray(asset) ? asset[0] : asset;
  if (typeof row !== 'object' || row === null) return '';
  const record = row as Record<string, unknown>;
  const display = text(record.display_name);
  return display !== '' ? display : text(record.filename);
}

/** One asset_versions row (COMMENT_FILE_COLUMNS) as [id, file]; null when it has no id. Pure. */
export function parseCommentFileRow(row: unknown): [string, CommentFile] | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const id = text(record.id);
  if (id === '') return null;
  const file: CommentFile = { name: assetName(record.assets), mime: text(record.mime_type) };
  const size = positiveInt(record.size_bytes);
  if (size !== undefined) file.size = size;
  const pages = positiveInt(record.page_count);
  if (pages !== undefined) file.pageCount = pages;
  const width = positiveInt(record.width);
  const height = positiveInt(record.height);
  if (width !== undefined && height !== undefined) {
    file.width = width;
    file.height = height;
  }
  return [id, file];
}

/**
 * The batched read: every id in one query (deduped, blanks dropped). Never
 * throws. Null when the read failed (the caller asks again on its next pass);
 * else the rows it could see (an unreadable id is simply absent).
 */
export async function fetchCommentFiles(
  client: Client,
  versionIds: readonly string[],
): Promise<Map<string, CommentFile> | null> {
  const ids = Array.from(new Set(versionIds.filter((id) => id !== '')));
  const files = new Map<string, CommentFile>();
  if (ids.length === 0) return files;
  try {
    const { data, error } = await client
      .from('asset_versions')
      .select(COMMENT_FILE_COLUMNS)
      .in('id', ids);
    const rows: unknown = data;
    if (error || !Array.isArray(rows)) return null;
    for (const row of rows as unknown[]) {
      const parsed = parseCommentFileRow(row);
      if (parsed !== null) files.set(parsed[0], parsed[1]);
    }
    return files;
  } catch {
    return null;
  }
}

/**
 * The ids the read should still ask for, in order, deduped: not blank and not
 * asked already (asked = in flight or answered). Pure.
 */
export function idsToRead(versionIds: readonly string[], asked: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of versionIds) {
    if (id === '' || seen.has(id) || asked.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Map a comment's stored version ids to renderable attachments with name,
 * mime, size and (PDF) page count, and an image's pixel size as its inline
 * box. An id the read has not answered yet renders as a file card with no
 * name (the card says "Attachment") and the same footprint. Pure.
 */
export function toCommentFileAttachments(
  versionIds: readonly string[] | null,
  files: ReadonlyMap<string, CommentFile>,
): MessageAttachment[] {
  return (versionIds ?? []).map((id) => {
    const file = files.get(id);
    if (file === undefined) return { assetId: id, name: '', mime: '' };
    const attachment: MessageAttachment = { assetId: id, name: file.name, mime: file.mime };
    if (file.size !== undefined) attachment.size = file.size;
    if (file.pageCount !== undefined) attachment.pageCount = file.pageCount;
    if (
      classifyAttachment(file.mime) === 'image' &&
      file.width !== undefined &&
      file.height !== undefined
    ) {
      attachment.thumbW = file.width;
      attachment.thumbH = file.height;
    }
    return attachment;
  });
}

/**
 * A comment's files for a forward (Thread polish 2): one attachment per stored
 * version id, in order, never dropped. Details the screen already holds are
 * used as they are; any it does not hold are read here in one batch. Called
 * after the Forward picker's Send, never on a tap. Null when that read failed.
 */
export async function commentForwardFiles(
  client: Client,
  versionIds: readonly string[],
  known: ReadonlyMap<string, CommentFile>,
): Promise<MessageAttachment[] | null> {
  const missing = idsToRead(versionIds, new Set(known.keys()));
  if (missing.length === 0) return toCommentFileAttachments(versionIds, known);
  const fetched = await fetchCommentFiles(client, missing);
  if (fetched === null) return null;
  return toCommentFileAttachments(versionIds, new Map([...known, ...fetched]));
}

/**
 * One comment's stored attachment ids by its id (catch up holds a comment's
 * text only). RLS-scoped; read after the Forward picker's Send. Null when the
 * read failed or the comment is gone or deleted. Never throws.
 */
export async function fetchCommentAttachmentIds(
  client: Client,
  commentId: string,
): Promise<string[] | null> {
  try {
    const { data, error } = await client
      .from('comments')
      .select('attachment_asset_ids, deleted_at')
      .eq('id', commentId)
      .maybeSingle();
    if (error || data === null || data.deleted_at !== null) return null;
    return [...(data.attachment_asset_ids ?? [])];
  } catch {
    return null;
  }
}

/**
 * The photo viewer's bar title for a comment: "{Name} · {formatAgo}". A name
 * not known yet leaves the time alone. Pure.
 */
export function commentViewerTitle(name: string, createdAt: string, now: Date): string {
  const when = formatAgo(createdAt, now);
  const who = name.trim();
  return who !== '' ? `${who} · ${when}` : when;
}
