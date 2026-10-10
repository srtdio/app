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
  type AssetOrigin,
  uploadErrorMessage,
  UPLOAD_ACCEPT,
  type Precheck,
  type UploadTransport,
} from '@/lib/asset-upload';
import { parsePeaks } from '@/lib/chat/waveform-peaks';

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
  /**
   * Legacy read-only: a transcript an older client wrote into attachment_meta.
   * Nothing writes it any more (transcripts are per-device, see transcript-store).
   */
  transcript?: string;
  /** Byte size of the uploaded file, when known. */
  size?: number;
  /** Recorded length of a voice note in ms; absent for non-audio attachments. */
  durationMs?: number;
  /**
   * A recorded voice note's waveform: up to 48 levels 0..100 from the real
   * audio (waveform-peaks.ts). Absent on older notes and non-audio files.
   */
  peaks?: number[];
  /**
   * Sender-side only: the picked file behind an instant send. Present from the
   * Send tap; `assetId` stays '' until the background upload returns the version
   * id. Never on the wire, in attachment_meta, or in localStorage.
   */
  local?: LocalAttachmentFile;
}

/**
 * Upload one file with progress (0..1); never throws (asset-upload Result
 * contract). An aborted `signal` stops the request at once (a cancelled send).
 */
export type AttachmentUploader = (
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
) => Promise<ChatAttachmentUpload>;

/** The local half of an attachment sent before its upload finished. */
export interface LocalAttachmentFile {
  /** Stable render key for the tile (the asset id arrives later). */
  key: string;
  /** The picked file; null once restored from storage (files do not survive a reload). */
  file: File | null;
  /** Object URL shown as the tile image for the session; null for non-images. */
  previewUrl: string | null;
  /** Upload progress 0..1; 1 once the version id is known. */
  progress: number;
  /**
   * True while this file's request is running (progress is real); absent or
   * false while it waits its turn, backs off or the device is offline.
   */
  uploading?: boolean;
  /** Uploads the file; carried in memory with the send (never persisted). */
  upload?: AttachmentUploader;
}

let localSeq = 0;

/**
 * The attachment an instant send carries: the file's name, mime and size, an
 * empty asset id (filled in by the background upload), and its local preview.
 */
export function toLocalAttachment(
  file: File,
  previewUrl: string | null,
  upload: AttachmentUploader | undefined,
): MessageAttachment {
  localSeq += 1;
  return {
    assetId: '',
    name: file.name,
    mime: file.type,
    size: file.size,
    local: {
      key: `local-${localSeq}`,
      file,
      previewUrl,
      progress: 0,
      ...(upload !== undefined ? { upload } : {}),
    },
  };
}

/** True while an attachment still has to be uploaded before its message can record. */
export function awaitsUpload(attachment: MessageAttachment): boolean {
  return attachment.assetId === '' && attachment.local !== undefined;
}

/** Upload progress to render on a tile; null when there is nothing in flight (plain tile). */
export function uploadProgress(attachment: MessageAttachment): number | null {
  if (attachment.local === undefined || attachment.assetId !== '') return null;
  return Math.min(Math.max(attachment.local.progress, 0), 1);
}

/**
 * The upload ring of a set of attachments (one message, or one tile): null when
 * none awaits upload (no ring). Otherwise the share of bytes sent across all of
 * them (an uploaded one counts in full; sizes unknown weigh one each), or null
 * while no request is running (queued, waiting, backoff, offline: the ring
 * spins). Pure.
 */
export function uploadRing(
  attachments: readonly MessageAttachment[],
): { progress: number | null } | null {
  if (!attachments.some(awaitsUpload)) return null;
  if (!attachments.some((a) => awaitsUpload(a) && a.local?.uploading === true)) {
    return { progress: null };
  }
  const known = attachments.every((a) => (a.size ?? 0) > 0);
  let total = 0;
  let sent = 0;
  for (const a of attachments) {
    const weight = known ? (a.size ?? 0) : 1;
    total += weight;
    sent += weight * (awaitsUpload(a) ? Math.min(Math.max(a.local?.progress ?? 0, 0), 1) : 1);
  }
  return { progress: total > 0 ? Math.min(Math.max(sent / total, 0), 1) : 0 };
}

/** The attachment without its local half: what is persisted and recorded. */
export function withoutLocal(attachment: MessageAttachment): MessageAttachment {
  if (attachment.local === undefined) return attachment;
  const rest = { ...attachment };
  delete rest.local;
  return rest;
}

/** Object URLs of own voice notes' recorded files, one per File for the session. */
const localAudioUrls = new WeakMap<File, string>();

/**
 * The playable object URL of an own voice note's recorded file, created once
 * per File (so the upload finishing never swaps the audio src); null when the
 * attachment carries no local file (a peer's note, or restored after a reload).
 */
export function localAudioUrl(attachment: MessageAttachment): string | null {
  const file = attachment.local?.file ?? null;
  if (file === null || typeof URL.createObjectURL !== 'function') return null;
  const known = localAudioUrls.get(file);
  if (known !== undefined) return known;
  const url = URL.createObjectURL(file);
  localAudioUrls.set(file, url);
  return url;
}

/** True for a voice note: an audio mime, or a recorded length whatever the mime. */
export function isVoiceAttachment(
  attachment: Pick<MessageAttachment, 'mime' | 'durationMs'>,
): boolean {
  return classifyAttachment(attachment.mime) === 'audio' || attachment.durationMs !== undefined;
}

/** Revoke the object URLs of local previews (entry removed, bubble gone). */
export function revokeLocalPreviews(attachments: readonly MessageAttachment[]): void {
  for (const attachment of attachments) {
    const url = attachment.local?.previewUrl;
    if (url != null) URL.revokeObjectURL(url);
    const file = attachment.local?.file ?? null;
    const audio = file !== null ? localAudioUrls.get(file) : undefined;
    if (file !== null && audio !== undefined) {
      URL.revokeObjectURL(audio);
      localAudioUrls.delete(file);
    }
  }
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
      ...(a.size !== undefined ? { size: a.size } : {}),
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
      ...(a.peaks !== undefined ? { peaks: [...a.peaks] } : {}),
    })),
  };
}

/** One attachment's render metadata as persisted in chat_messages.attachment_meta. */
export type AttachmentMetaEntry = {
  mime: string;
  name: string;
  size: number;
  duration_ms?: number;
  transcript?: string;
  /** A voice note's waveform (waveform-peaks.ts); absent on older notes. */
  peaks?: number[];
};

/** chat_messages.attachment_meta: render metadata keyed by asset (version) id. */
export type AttachmentMetaMap = Record<string, AttachmentMetaEntry>;

/**
 * Build the p_attachment_meta payload for chat_message_send, so a message read
 * back from Postgres renders exactly like the live one (image vs file vs voice
 * note, name). Transcripts are never written: they live on the reading device.
 */
export function buildAttachmentMeta(attachments: readonly MessageAttachment[]): AttachmentMetaMap {
  const meta: AttachmentMetaMap = {};
  for (const a of attachments) {
    meta[a.assetId] = {
      mime: a.mime,
      name: a.name,
      size: a.size ?? 0,
      ...(a.durationMs !== undefined ? { duration_ms: a.durationMs } : {}),
      ...(a.peaks !== undefined ? { peaks: [...a.peaks] } : {}),
    };
  }
  return meta;
}

/**
 * Read a row's attachments: one per id in `attachment_asset_ids` (the row's
 * order), enriched from `attachment_meta` when it carries that id. An id with no
 * (or malformed) meta renders through the bare-id path, as before the column.
 */
export function parseAttachmentMeta(
  meta: unknown,
  assetIds: readonly string[],
): MessageAttachment[] {
  const map =
    typeof meta === 'object' && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  return assetIds.map((assetId) => {
    const raw = map[assetId];
    if (typeof raw !== 'object' || raw === null) return { assetId, name: '', mime: '' };
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const mime = typeof entry.mime === 'string' ? entry.mime : '';
    const peaks = parsePeaks(entry.peaks);
    return {
      assetId,
      name,
      mime,
      ...(typeof entry.transcript === 'string' ? { transcript: entry.transcript } : {}),
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
      ...(typeof entry.duration_ms === 'number' ? { durationMs: entry.duration_ms } : {}),
      ...(peaks !== undefined ? { peaks } : {}),
    };
  });
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
  /**
   * A send's thread root as the sender derived it from the loaded parent
   * (coalesce(parent's root, parent id), the record trigger's rule). Rides
   * the live ext as sorted_thread_root_id, never reply_to; absent when unknown.
   */
  rootId?: string;
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
  /** The source message id; present only when this message was forwarded. */
  forwarded_from?: string;
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
  /** The source message id when this send forwards it. */
  forwardedFrom?: string | null;
}): MessageExt {
  return {
    ...buildAttachmentExt(input.attachments),
    shared_post_ids: [...input.sharedPostIds],
    ...(input.forwardedFrom != null && input.forwardedFrom !== ''
      ? { forwarded_from: input.forwardedFrom }
      : {}),
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

/** Read the forwarded-from source id off a message's `ext`; null when not forwarded. */
export function parseForwardedFrom(ext: unknown): string | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const value = (ext as Record<string, unknown>).forwarded_from;
  return typeof value === 'string' && value !== '' ? value : null;
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
    (record.transcript === undefined || typeof record.transcript === 'string') &&
    (record.size === undefined || typeof record.size === 'number') &&
    (record.durationMs === undefined || typeof record.durationMs === 'number')
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
    // Only known keys are kept; `peaks` that do not validate are dropped.
    const parsed = meta.filter(isMessageAttachment).map((a): MessageAttachment => {
      const peaks = parsePeaks((a as { peaks?: unknown }).peaks);
      return {
        assetId: a.assetId,
        name: a.name,
        mime: a.mime,
        ...(a.transcript !== undefined ? { transcript: a.transcript } : {}),
        ...(a.size !== undefined ? { size: a.size } : {}),
        ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
        ...(peaks !== undefined ? { peaks } : {}),
      };
    });
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
 * Whether a compose action may send: text, at least one accepted attachment, or
 * at least one shared post or brief, while idle. Uploads never block: a picked
 * file uploads in the background after Send. A send with none is blocked.
 */
export function canSendAttachmentMessage(input: {
  text: string;
  attachmentCount: number;
  sharedPostCount?: number;
  sharedBriefCount?: number;
  sending: boolean;
}): boolean {
  if (input.sending) return false;
  return (
    input.text.trim() !== '' ||
    input.attachmentCount > 0 ||
    (input.sharedPostCount ?? 0) > 0 ||
    (input.sharedBriefCount ?? 0) > 0
  );
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
  return { assetId: versionId, name: file.name, mime: file.type, size: file.size };
}

/** The asset_versions columns a library pick carries (attachment meta is built from these). */
export interface LibraryVersionRow {
  id: string;
  mime_type: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
}

/**
 * The message attachment for an existing library version: already uploaded, so
 * it carries the version id and no local half (the outbox never uploads it).
 * Name, mime and size match what an uploaded file of the same shape carries;
 * duration only when the version has one. Pure.
 */
export function toLibraryAttachment(version: LibraryVersionRow, name: string): MessageAttachment {
  return {
    assetId: version.id,
    name,
    mime: version.mime_type ?? '',
    size: version.size_bytes ?? 0,
    ...(version.duration_ms !== null ? { durationMs: version.duration_ms } : {}),
  };
}

export type ChatUploadParams = {
  file: File;
  workspaceId: string;
  /** 'chat' from the chat composer/outbox; 'library' from comments and post/brief fields. */
  origin: AssetOrigin;
  token: string;
  endpoint: string;
} & UploadTransport;

/**
 * The chat upload result. It carries the asset VERSION id (presign binds to a
 * specific version), not the asset id, so the render path resolves a thumbnail
 * instead of 404ing. Never throws: it inherits asset-upload's Result contract.
 */
export type ChatAttachmentUpload =
  | { ok: true; reused: boolean; versionId: string }
  | { ok: false; message: string };

/**
 * Upload one chat attachment through the existing asset-upload pipeline, sending
 * the file under its original name. The POST is `uploadAssetFile` verbatim
 * (multipart {file, workspace_id} + Bearer), over XHR when the caller wants
 * progress. The chat render path presigns an asset VERSION id (asset-read looks
 * up asset_versions.id), read off the same worker response; a success without
 * one fails closed.
 */
/**
 * The chat's copy for an upload that failed for no named reason. The shared
 * upload layer's generic line mentions the connection; chat never shows
 * connection wording, so it is replaced here (still a transient failure).
 */
export const CHAT_UPLOAD_FAILED = 'Upload failed. Try again';

/** Chat copy for an upload failure: named reasons stay, the generic one is neutral. */
export function chatUploadMessage(message: string): string {
  return message === uploadErrorMessage('network') ? CHAT_UPLOAD_FAILED : message;
}

export async function uploadChatAttachment(
  params: ChatUploadParams,
): Promise<ChatAttachmentUpload> {
  const base = {
    endpoint: params.endpoint,
    token: params.token,
    workspaceId: params.workspaceId,
    origin: params.origin,
    filename: params.file.name,
  };
  const outcome = await uploadAssetFile(
    params.file,
    params.xhr !== undefined ? { ...base, xhr: params.xhr } : { ...base, fetcher: params.fetcher },
  );
  if (!outcome.ok) return { ...outcome, message: chatUploadMessage(outcome.message) };
  const versionId = outcome.assetVersionId ?? '';
  if (versionId === '') {
    return { ok: false, message: CHAT_UPLOAD_FAILED };
  }
  return { ok: true, reused: outcome.reused, versionId };
}

/**
 * A message's attachments split for the album render: every image (in send
 * order) goes into one album, everything else (voice notes, file chips) renders
 * below it as before. Pure.
 */
export function splitAlbum(attachments: readonly MessageAttachment[]): {
  images: MessageAttachment[];
  others: MessageAttachment[];
} {
  const images: MessageAttachment[] = [];
  const others: MessageAttachment[] = [];
  for (const attachment of attachments) {
    (classifyAttachment(attachment.mime) === 'image' ? images : others).push(attachment);
  }
  return { images, others };
}
