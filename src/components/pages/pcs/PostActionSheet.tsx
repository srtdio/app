// F8 PCS post action sheet: one "more" sheet on the live post header offering
// Send to chat, Copy link, and Download all images. Frontend only, no schema, no
// Postgres write, no new RPC. Each action reuses an existing path:
//   - Send to chat -> the existing Agora sendText via ConversationPicker.
//   - Copy link    -> an in-app authenticated deep link built from
//                     window.location.origin + the existing post route (no domain
//                     hardcoded, no share token: there is no public-share concept).
//   - Download all -> the same attachment-disposition presigned URL the PCS
//                     lightbox already uses per image, looped over the gallery.
// It is mounted in LIVE PCS only (never the read-only old-version view).

import { useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import { Button } from '@/components/ui/Button';
import { IconDownload, IconLink, IconSend, IconTrash } from '@/components/ui/icons';
import { requestPresignedUrl, type PresignDeps } from '@/lib/asset-presign';
import { postRoute } from '@/components/chat/post-card';
import {
  buildPostLink,
  canDownloadAll,
  isDownloadableImage,
  toDownloadDescriptors,
  type ResolvedDownload,
} from '@/lib/post-share';
import { ConversationPicker } from '@/components/pages/pcs/ConversationPicker';
import type { GalleryItem } from '@srtdio/posts';

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
  /** Push a toast onto the page's stack. */
  onToast: (message: string) => void;
  /** Owner/admin only: gates the destructive Delete post row + confirm view. */
  canDelete: boolean;
  /** Soft-delete the post; the page handles the proc call, toast, and navigation. */
  onDeletePost: () => Promise<void>;
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

export function PostActionSheet({
  open,
  onClose,
  postId,
  workspaceId,
  currentUserId,
  gallery,
  deps,
  onToast,
  canDelete,
  onDeletePost,
}: PostActionSheetProps) {
  const [view, setView] = useState<'actions' | 'chat' | 'confirm-delete'>('actions');
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const images = useMemo(() => gallery.filter(isDownloadableImage), [gallery]);
  const showDownload = canDownloadAll(gallery);

  function close(): void {
    setView('actions');
    onClose();
  }

  async function handleCopyLink(): Promise<void> {
    const link = buildPostLink(window.location.origin, postRoute(postId));
    try {
      await navigator.clipboard.writeText(link);
      onToast('Link copied.');
    } catch {
      onToast('Could not copy the link.');
    }
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
          <p className="text-sm text-fg">Delete this post? This cannot be undone.</p>
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
