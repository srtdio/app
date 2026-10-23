// F8 PCS post action sheet: one "more" sheet on the live post header offering
// Send to chat, Copy link, and Download all images. Frontend only, no schema, no
// Postgres write, no new RPC. Each action reuses an existing path:
//   - Send to chat -> the existing Agora sendText via ConversationPicker.
//   - Copy link    -> an in-app authenticated deep link built from
//                     window.location.origin + the pretty short route
//                     (/p/<key>-<number>) when the workspace key is known, falling
//                     back to the classic /posts/<uuid> route otherwise (no domain
//                     hardcoded, no share token: there is no public-share concept).
//   - Download all -> the same attachment-disposition presigned URL the PCS
//                     lightbox already uses per image, looped over the gallery.
// It is mounted in LIVE PCS only (never the read-only old-version view).
// Embedded in a plan item, the same sheet leads with Open in pipeline. Delete
// post asks nothing (spec B7): the sheet closes and the page deletes behind its
// 4s "Post deleted" Undo strip.

import { useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import {
  IconCalendar,
  IconDownload,
  IconLink,
  IconPipeline,
  IconSend,
  IconTrash,
} from '@/components/ui/icons';
import { requestPresignedUrl, type PresignDeps } from '@/lib/asset-presign';
import { postRoute } from '@/components/chat/post-card';
import { entityUrlPath } from '@/lib/entityRef';
import {
  buildPostLink,
  canDownloadAll,
  isDownloadableImage,
  toDownloadDescriptors,
  type ResolvedDownload,
} from '@/lib/post-share';
import { ConversationPicker } from '@/components/pages/pcs/ConversationPicker';
import type { GalleryItem } from '@srtdio/posts';
import { MOVE_ROW_LABEL, PostSheetPlanRowsContext } from '@/components/chat/PlanMoveSheet';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { errorText } from '@/lib/error-copy';

/**
 * One stage move offered in the sheet (flow B 31): the creator's Approve on
 * their behalf, Park and Reject. The page owns the move (its confirm, Undo and
 * errors); the sheet closes, then hands off.
 */
export interface PostMoveRow {
  key: string;
  icon: ReactNode;
  label: string;
  sub?: string;
  danger?: boolean;
  onPick: () => void;
}

interface PostActionSheetProps {
  open: boolean;
  onClose: () => void;
  postId: string;
  workspaceId: string;
  currentUserId: string;
  /** The current (live) gallery, as already resolved by PCS for rendering. */
  gallery: GalleryItem[];
  /** The presign deps PCS already builds for the lightbox download. */
  deps: PresignDeps;
  /**
   * The active workspace key, or null when it has not resolved yet. When present,
   * Copy link uses the pretty /p/<key>-<number> short link; when null it falls back
   * to the classic /posts/<uuid> deep link.
   */
  workspaceKey: string | null;
  /** The post's per-workspace entity number, used to build the short link. */
  postNumber: number;
  /** Push a toast onto the page's stack. */
  onToast: (message: string) => void;
  /** Owner, admin or agency (canDeletePost): gates the Delete post row. */
  canDelete: boolean;
  /**
   * Delete the post at once; the page runs the 4s "Post deleted" Undo window,
   * the proc call, the failure toast and the navigation.
   */
  onDeletePost: () => Promise<void> | void;
  /** Embedded in a plan item: the first row, Open in pipeline. Absent elsewhere. */
  onOpenInPipeline?: () => void;
  /** Stage moves listed first (creators only); absent or empty shows none. */
  moveRows?: readonly PostMoveRow[];
}

/**
 * Flow B 38: the delete row's line, honest about the recovery surface. There
 * is no confirm (spec B7); the Undo strip is the safety net.
 */
export const DELETE_CONFIRM_BASE = 'Moves to Recently deleted. You can restore it there.';

/** The action rows in order (Open in pipeline first when offered, Delete last). Pure. */
export function postActionLabels(opts: {
  openInPipeline: boolean;
  download: boolean;
  canDelete: boolean;
}): string[] {
  return [
    ...(opts.openInPipeline ? ['Open in pipeline'] : []),
    'Send to chat',
    'Copy link',
    ...(opts.download ? ['Download all images'] : []),
    ...(opts.canDelete ? ['Delete post'] : []),
  ];
}

/** Save one resolved URL as a file via a throwaway download anchor. */
function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Small gap between sequential downloads so the browser does not coalesce them. */
const DOWNLOAD_GAP_MS = 150;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The absolute link the Copy link action puts on the clipboard: the pretty short
 * link (/p/<key>-<number>) when the workspace key is known, else the classic
 * /posts/<uuid> deep link. The origin is always the caller's
 * window.location.origin; no domain is ever hardcoded. Pure so the copy behaviour
 * is unit-testable without a DOM.
 */
export function postCopyLink(
  origin: string,
  workspaceKey: string | null,
  postNumber: number,
  postId: string,
): string {
  const path =
    workspaceKey !== null ? entityUrlPath('post', workspaceKey, postNumber) : postRoute(postId);
  return buildPostLink(origin, path);
}

export function PostActionSheet({
  open,
  onClose,
  postId,
  workspaceId,
  currentUserId,
  gallery,
  deps,
  workspaceKey,
  postNumber,
  onToast,
  canDelete,
  onDeletePost,
  onOpenInPipeline,
  moveRows = [],
}: PostActionSheetProps): ReactElement {
  const planRows = useContext(PostSheetPlanRowsContext);
  const [view, setView] = useState<'actions' | 'chat'>('actions');
  const [downloading, setDownloading] = useState(false);

  const images = useMemo(() => gallery.filter(isDownloadableImage), [gallery]);
  const showDownload = canDownloadAll(gallery);

  function close(): void {
    setView('actions');
    onClose();
  }

  async function handleCopyLink(): Promise<void> {
    const link = postCopyLink(window.location.origin, workspaceKey, postNumber, postId);
    const ok = await copyText(link);
    onToast(ok ? 'Link copied' : COPY_FAILED);
    close();
  }

  async function handleDownloadAll(): Promise<void> {
    if (downloading || images.length === 0) return;
    setDownloading(true);
    try {
      const resolved: ResolvedDownload[] = await Promise.all(
        images.map(async (item) => {
          try {
            const presigned = await requestPresignedUrl(deps, item.assetVersionId, 'attachment');
            return { url: presigned.url, filename: item.filename };
          } catch {
            return { url: null, filename: item.filename };
          }
        }),
      );
      const descriptors = toDownloadDescriptors(resolved);
      if (descriptors.length === 0) {
        onToast(errorText('prepare the images for download', null));
        return;
      }
      for (let i = 0; i < descriptors.length; i += 1) {
        const descriptor = descriptors[i];
        if (descriptor === undefined) continue;
        triggerDownload(descriptor.url, descriptor.filename);
        if (i < descriptors.length - 1) await wait(DOWNLOAD_GAP_MS);
      }
      onToast(
        descriptors.length < images.length
          ? "Some images couldn't be downloaded"
          : `Downloading ${descriptors.length} image${descriptors.length === 1 ? '' : 's'}`,
      );
      close();
    } finally {
      setDownloading(false);
    }
  }

  // Spec B7: no confirm. The sheet closes, then the page deletes behind its
  // Undo strip ("Post deleted" · Undo, 4s).
  function handleDelete(): void {
    close();
    void onDeletePost();
  }

  const title = view === 'chat' ? 'Send to chat' : 'Post actions';

  return (
    <Sheet open={open} onClose={close} title={title}>
      {view === 'chat' ? (
        <ConversationPicker
          postId={postId}
          workspaceId={workspaceId}
          currentUserId={currentUserId}
          onToast={onToast}
          onSent={close}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {onOpenInPipeline !== undefined ? (
            <ActionRow
              icon={<IconPipeline size={18} />}
              label="Open in pipeline"
              sub="See this post in the pipeline"
              onClick={() => {
                close();
                onOpenInPipeline();
              }}
            />
          ) : null}
          {planRows !== null ? (
            <ActionRow
              icon={<IconCalendar size={18} />}
              label={MOVE_ROW_LABEL}
              onClick={() => {
                close();
                planRows.onMove();
              }}
            />
          ) : null}
          {moveRows.map((row) => (
            <ActionRow
              key={row.key}
              icon={row.icon}
              label={row.label}
              {...(row.sub !== undefined ? { sub: row.sub } : {})}
              {...(row.danger === true ? { danger: true } : {})}
              onClick={() => {
                close();
                row.onPick();
              }}
            />
          ))}
          <ActionRow
            icon={<IconSend size={18} />}
            label="Send to chat"
            sub="Share this post in a conversation"
            chevron
            onClick={() => setView('chat')}
          />
          <ActionRow
            icon={<IconLink size={18} />}
            label="Copy link"
            sub="In-app link to this post"
            onClick={() => void handleCopyLink()}
          />
          {showDownload ? (
            <ActionRow
              icon={<IconDownload size={18} />}
              label="Download all images"
              sub={
                downloading
                  ? 'Preparing downloads'
                  : `${images.length} image${images.length === 1 ? '' : 's'}`
              }
              onClick={() => void handleDownloadAll()}
            />
          ) : null}
          {canDelete ? (
            <ActionRow
              danger
              icon={<IconTrash size={18} />}
              label="Delete post"
              sub={DELETE_CONFIRM_BASE}
              onClick={handleDelete}
            />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
