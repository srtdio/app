// Attachment model for chat (Model A: attachments are Sorted assets). Pure,
// SDK-free helpers shared by the composer (send) and the thread (render):
//
//  - the wire shape carried on the Agora message `ext` payload,
//  - the upload command that reuses the existing asset-upload pipeline as-is,
//  - the small predicates the composer and renderer branch on.
//
// The asset id is whatever `uploadAssetFile` returns; this layer treats it as an
// opaque reference (the presign cache keys on it) and never asserts asset-vs-
// version semantics, so it stays correct against the asset libs used as-is.

import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import { uploadAssetFile, UPLOAD_ACCEPT, type UploadOutcome } from '@/lib/asset-upload';

/**
 * One Sorted asset referenced by a chat message: the id to presign plus the
 * metadata the receiver needs to render it without a second lookup (the name for
 * the file chip / image alt, the mime to dispatch image vs file).
 */
export interface MessageAttachment {
  assetId: string;
  name: string;
  mime: string;
}

/** The picker `accept` for the Photo item: the image subset of the shared allowlist. */
export const IMAGE_ACCEPT = ALLOWED_MIME_TYPES.filter((mime) => isImageMime(mime)).join(',');

/** The picker `accept` for the File item: the full shared allowlist. */
export const FILE_ACCEPT = UPLOAD_ACCEPT;

/**
 * Render branch for one attachment. PR6 adds a 'post' branch for shared posts;
 * extend `classifyAttachment` and the MessageThread dispatch together, never the
 * chip components, so each branch stays self-contained.
 */
export type AttachmentKind = 'image' | 'file';

export function classifyAttachment(mime: string): AttachmentKind {
  return isImageMime(mime) ? 'image' : 'file';
}

/**
 * Custom-extension payload carried on the Agora message. `attachment_asset_ids`
 * is the canonical id list the webhook mirror persists (chat-webhook-mirror's
 * extractAssetIds reads this exact key); `attachment_meta` is client-only render
 * metadata the mirror ignores.
 */
export interface AttachmentExt {
  attachment_asset_ids: string[];
  attachment_meta: MessageAttachment[];
}

export function buildAttachmentExt(attachments: readonly MessageAttachment[]): AttachmentExt {
  return {
    attachment_asset_ids: attachments.map((attachment) => attachment.assetId),
    attachment_meta: attachments.map((attachment) => ({
      assetId: attachment.assetId,
      name: attachment.name,
      mime: attachment.mime,
    })),
  };
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.assetId === 'string' &&
    typeof record.name === 'string' &&
    typeof record.mime === 'string'
  );
}

/**
 * Read the attachments off a message's `ext`. Prefers the rich `attachment_meta`
 * (name + mime for deterministic rendering); falls back to the bare
 * `attachment_asset_ids` (rendered via the image-with-fallback path) so a message
 * carrying only ids still shows its attachments. Returns an empty array, never
 * null, for a message with no attachments.
 */
export function parseAttachments(ext: unknown): MessageAttachment[] {
  if (typeof ext !== 'object' || ext === null) return [];
  const record = ext as Record<string, unknown>;
  const meta = record.attachment_meta;
  if (Array.isArray(meta)) {
    const parsed = meta.filter(isMessageAttachment);
    if (parsed.length > 0) return parsed;
  }
  const ids = record.attachment_asset_ids;
  if (Array.isArray(ids)) {
    return ids
      .filter((value): value is string => typeof value === 'string')
      .map((assetId) => ({ assetId, name: '', mime: '' }));
  }
  return [];
}

/** Distinct, non-empty asset ids, preserving order: the set the renderer presigns. */
export function uniqueAssetIds(attachments: readonly MessageAttachment[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const attachment of attachments) {
    if (attachment.assetId !== '' && !seen.has(attachment.assetId)) {
      seen.add(attachment.assetId);
      ids.push(attachment.assetId);
    }
  }
  return ids;
}

/** Whether a compose action may send: text or at least one attachment, idle. */
export function canSendAttachmentMessage(input: {
  text: string;
  attachmentCount: number;
  uploading: boolean;
  sending: boolean;
}): boolean {
  if (input.uploading || input.sending) return false;
  return input.text.trim() !== '' || input.attachmentCount > 0;
}

/** Build the message attachment for a successfully uploaded file. */
export function toMessageAttachment(file: File, assetId: string): MessageAttachment {
  return { assetId, name: file.name, mime: file.type };
}

export interface ChatUploadParams {
  file: File;
  workspaceId: string;
  token: string;
  endpoint: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Upload one chat attachment through the existing asset-upload pipeline, sending
 * the file under its original name. Reuses `uploadAssetFile` verbatim (multipart
 * {file, workspace_id} + Bearer), so it inherits the never-throw Result contract:
 * a transport or worker failure comes back as { ok: false } with mapped copy.
 */
export function uploadChatAttachment(params: ChatUploadParams): Promise<UploadOutcome> {
  return uploadAssetFile(params.file, {
    endpoint: params.endpoint,
    token: params.token,
    workspaceId: params.workspaceId,
    filename: params.file.name,
    fetcher: params.fetcher,
  });
}
