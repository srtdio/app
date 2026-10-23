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
// Embedded in a plan item, the same sheet leads with Open in pipeline. The
// delete confirm names the post's live plans (one bounded read on opening it).

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import { Button } from '@/components/ui/Button';
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
import { postPlansLine, readPostPlans, type PostPlanRef } from '@/lib/chat/plans';
import { supabase } from '@/lib/supabase';
import { MOVE_ROW_LABEL, PostSheetPlanRowsContext } from '@/components/chat/PlanMoveSheet';
import { COPY_FAILED, copyText } from '@/lib/clipboard';

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
  /** Owner, admin or agency (canDeletePost): gates the Delete post row + confirm view. */
  canDelete: boolean;
  /** Soft-delete the post; the page handles the proc call, toast, and navigation. */
  onDeletePost: () => Promise<void>;
  /** Embedded in a plan item: the first row, Open in pipeline. Absent elsewhere. */
  onOpenInPipeline?: () => void;
  /** The delete confirm's plans read; the live read (5s cap) when absent. */
  readPlans?: (postId: string) => Promise<Result<PostPlanRef[]>>;
}

/** The delete confirm's base copy: honest about the 4s Undo and the recovery surface. */
export const DELETE_CONFIRM_BASE = 'Delete this post? Moves to Recently deleted.';

/**
 * The delete confirm's copy: the base, then the plans line once the read
 * settled with one or more plans. Still reading, failed, timed out or no plan:
 * the base alone. Pure.
 */
export function deleteConfirmText(plans: Result<PostPlanRef[]> | null): string {
  if (plans === null || !plans.ok) return DELETE_CONFIRM_BASE;
  const line = postPlansLine(plans.data);
  return line === null ? DELETE_CONFIRM_BASE : `${DELETE_CONFIRM_BASE} ${line}`;
}

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
  readPlans,
}: PostActionSheetProps): ReactElement {
  const planRows = useContext(PostSheetPlanRowsContext);
  const [view, setView] = useState<'actions' | 'chat' | 'confirm-delete'>('actions');
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The confirm's plans read: null while it runs (the base copy shows).
  const [plans, setPlans] = useState<Result<PostPlanRef[]> | null>(null);
  const confirming = open && view === 'confirm-delete';
  const readPlansRef = useRef(readPlans);
  readPlansRef.current = readPlans;
  useEffect(() => {
    if (!confirming) {
      setPlans(null);
      return;
    }
    let live = true;
    const run = readPlansRef.current ?? ((id: string) => readPostPlans(supabase, id));
    void run(postId).then((result) => {
      if (live) setPlans(result);
    });
    return () => {
      live = false;
    };
  }, [confirming, postId]);

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
        onToast('Could not prepare the images for download.');
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
          ? 'Some images could not be downloaded.'
          : `Downloading ${descriptors.length} image${descriptors.length === 1 ? '' : 's'}.`,
      );
      close();
    } finally {
      setDownloading(false);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDeletePost();
    } finally {
      setDeleting(false);
    }
    close();
  }

  const title =
    view === 'chat' ? 'Send to chat' : view === 'confirm-delete' ? 'Delete post' : 'Post actions';

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
      ) : view === 'confirm-delete' ? (
        <div className="flex flex-col gap-3">
          <p data-post-delete-text="" className="text-sm text-fg">
            {deleteConfirmText(plans)}
          </p>
          <Button
            variant="danger"
            size="lg"
            disabled={deleting}
            onClick={() => void handleConfirmDelete()}
          >
            {deleting ? 'Deleting' : 'Delete post'}
          </Button>
          <Button variant="ghost" size="lg" disabled={deleting} onClick={() => setView('actions')}>
            Cancel
          </Button>
        </div>
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
              sub="This cannot be undone"
              onClick={() => setView('confirm-delete')}
            />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
