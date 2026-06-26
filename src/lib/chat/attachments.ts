// Attachment model for chat (Model A: attachments are Sorted assets). Pure,
// SDK-free helpers shared by the composer (send) and the thread (render):
//
//  - the wire shape carried on the Agora message `ext` payload,
//  - the upload command that reuses the existing asset-upload pipeline as-is,
//  - the small predicates the composer and renderer branch on.
//
// The id carried is the asset VERSION id: the render path presigns through
// asset-read, which looks up asset_versions.id, and the webhook mirror persists
// the same ids on chat_messages.attachment_asset_ids. Binding to a version (not
// the asset) matches asset_attachments.asset_version_id and how the Assets grid
// presigns currentVersionId.

import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';
import {
  precheckFile,
  uploadAssetFile,
  uploadErrorMessage,
  UPLOAD_ACCEPT,
  type Precheck,
} from '@/lib/asset-upload';

/**
 * One Sorted asset version referenced by a chat message: the asset VERSION id to
 * presign plus the metadata the receiver needs to render it without a second
 * lookup (the name for the file chip / image alt, the mime to dispatch image vs
 * file). `assetId` holds the version id (the value asset-read presigns).
 */
export interface MessageAttachment {
  assetId: string;
  name: string;
  mime: string;
  /** Whisper transcript for a voice note; absent for non-audio attachments. */
  transcript?: string;
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
export type AttachmentKind = 'image' | 'audio' | 'file';

export function classifyAttachment(mime: string): AttachmentKind {
  return isImageMime(mime) ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file';
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
    attachment_meta: attachments.map((a) => ({
      assetId: a.assetId,
      name: a.name,
      mime: a.mime,
      ...(a.transcript !== undefined ? { transcript: a.transcript } : {}),
    })),
  };
}

/**
 * A WhatsApp-style reply quote: a snapshot of another message carried on the
 * sending message's `ext` (exactly like attachments and shared posts ride `ext`).
 * No new Agora API or message type; a reply is a normal text message that points
 * back at the quoted one.
 */
export interface ReplyQuote {
  /** Server id of the quoted message. */
  id: string;
  /** Sorted user id of the quoted message's sender, or null when unmapped. */
  authorUserId: string | null;
  /** Short text snapshot of the quoted message, shown in the quote line. */
  preview: string;
}

/**
 * The full custom-extension payload a chat message may carry: the attachment ids
 * (PR5, unchanged) plus PR6's `shared_post_ids`, the post uuids shared into the
 * message. Only post ids ride the wire; no post content is sent, each viewer
 * resolves the cards through RLS. The webhook mirror persists the whole ext via
 * raw_payload, so `shared_post_ids` is captured without a new column.
 */
export interface MessageExt extends AttachmentExt {
  shared_post_ids: string[];
  /** Quoted message (snake_case on the wire); present only when this is a reply. */
  reply_to?: { id: string; author_user_id: string | null; preview: string };
}

/**
 * Build the message ext from attachments and/or shared post ids. Extends the PR5
 * attachment ext with `shared_post_ids` rather than replacing it, so attachment
 * sends keep `attachment_asset_ids` working unchanged and a send may carry both.
 */
export function buildMessageExt(input: {
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  reply: ReplyQuote | null;
}): MessageExt {
  return {
    ...buildAttachmentExt(input.attachments),
    shared_post_ids: [...input.sharedPostIds],
    ...(input.reply !== null
      ? {
          reply_to: {
            id: input.reply.id,
            author_user_id: input.reply.authorUserId,
            preview: input.reply.preview,
          },
        }
      : {}),
  };
}

/**
 * Read the shared post ids off a message's `ext`. Returns an empty array, never
 * null, for a message that shares no posts. Mirrors {@link parseAttachments}: the
 * render path branches on a non-empty result.
 */
export function parseSharedPostIds(ext: unknown): string[] {
  if (typeof ext !== 'object' || ext === null) return [];
  const ids = (ext as Record<string, unknown>).shared_post_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((value): value is string => typeof value === 'string');
}

/**
 * Read the reply quote off a message's `ext`. Defensive, mirroring
 * {@link parseSharedPostIds}: returns null for any message that is not a reply
 * or whose `reply_to` is malformed, so the render path branches on a non-null
 * result.
 */
export function parseReply(ext: unknown): ReplyQuote | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const raw = (ext as { reply_to?: unknown }).reply_to;
  if (typeof raw !== 'object' || raw === null) return null;
  const q = raw as { id?: unknown; author_user_id?: unknown; preview?: unknown };
  if (typeof q.id !== 'string' || typeof q.preview !== 'string') return null;
  const authorUserId = typeof q.author_user_id === 'string' ? q.author_user_id : null;
  return { id: q.id, authorUserId, preview: q.preview };
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.assetId === 'string' &&
    typeof record.name === 'string' &&
    typeof record.mime === 'string' &&
    (record.transcript === undefined || typeof record.transcript === 'string')
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

/**
 * Whether a compose action may send: text, at least one attachment, or at least
 * one shared post, while idle. A shared-posts-only send is allowed; a send with
 * none of the three is blocked. `sharedPostCount` is optional so the PR5 callers
 * that predate post sharing keep their existing two-argument behaviour.
 */
export function canSendAttachmentMessage(input: {
  text: string;
  attachmentCount: number;
  sharedPostCount?: number;
  uploading: boolean;
  sending: boolean;
}): boolean {
  if (input.uploading || input.sending) return false;
  return input.text.trim() !== '' || input.attachmentCount > 0 || (input.sharedPostCount ?? 0) > 0;
}

/**
 * Photo-path pre-check: image-only on top of the shared size/type gate. The File
 * path uses `precheckFile` (the full allowlist); the Photo dialog restricts to
 * images via its `accept`, but a determined pick can still surface an allowlisted
 * non-image, so the Photo path additionally rejects any non-image MIME before a
 * single byte leaves the device. Type is gated first so a non-image reports the
 * image error regardless of size.
 */
export function precheckImage(file: File): Precheck {
  if (!isImageMime(file.type)) {
    return { ok: false, message: 'Photos must be an image file' };
  }
  return precheckFile(file);
}

/** Build the message attachment for a successfully uploaded file; `versionId` is
 * the asset VERSION id the render path presigns. */
export function toMessageAttachment(file: File, versionId: string): MessageAttachment {
  return { assetId: versionId, name: file.name, mime: file.type };
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
 * The chat upload result. It carries the asset VERSION id (presign binds to a
 * specific version), not the asset id, so the render path resolves a thumbnail
 * instead of 404ing. Never throws: it inherits asset-upload's Result contract.
 */
export type ChatAttachmentUpload =
  | { ok: true; reused: boolean; versionId: string }
  | { ok: false; message: string };

/** Read `asset.versionId` from the asset-upload worker JSON body; '' when absent. */
function uploadedVersionId(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const asset = (body as { asset?: unknown }).asset;
  if (typeof asset !== 'object' || asset === null) return '';
  const versionId = (asset as { versionId?: unknown }).versionId;
  return typeof versionId === 'string' ? versionId : '';
}

/**
 * Upload one chat attachment through the existing asset-upload pipeline, sending
 * the file under its original name. The POST is `uploadAssetFile` verbatim
 * (multipart {file, workspace_id} + Bearer); asset-upload surfaces only the asset
 * id, but the chat render path presigns an asset VERSION id (asset-read looks up
 * asset_versions.id). We capture `asset.versionId` off the same worker response
 * via a clone (so uploadAssetFile still reads the body) rather than issuing a
 * second request or duplicating the upload.
 */
export async function uploadChatAttachment(
  params: ChatUploadParams,
): Promise<ChatAttachmentUpload> {
  let versionId = '';
  const fetcher: ChatUploadParams['fetcher'] = async (input, init) => {
    const response = await params.fetcher(input, init);
    if (response.ok) {
      try {
        versionId = uploadedVersionId(await response.clone().json());
      } catch {
        versionId = '';
      }
    }
    return response;
  };

  const outcome = await uploadAssetFile(params.file, {
    endpoint: params.endpoint,
    token: params.token,
    workspaceId: params.workspaceId,
    filename: params.file.name,
    fetcher,
  });
  if (!outcome.ok) return outcome;
  if (versionId === '') {
    return { ok: false, message: uploadErrorMessage('network') };
  }
  return { ok: true, reused: outcome.reused, versionId };
}
