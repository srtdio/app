// F8 PCS post ⋯ menu (ui/ActionMenu: a Sheet on phone, a popover on laptop)
// on the live post header: Open in pipeline (embedded in a plan item), Copy
// link, the creator's stage moves, Send to chat, Download all images, Remove
// image and Delete post, in the one ⋯ order (Open, Copy link, the rest, Delete
// last). Frontend only, no schema, no Postgres write, no new RPC. Each action
// reuses an existing path:
//   - Send to chat -> the existing Agora sendText via ConversationPicker, in
//                     its own sheet once the menu closes.
//   - Copy link    -> an in-app authenticated deep link built from
//                     window.location.origin + the pretty short route
//                     (/p/<key>-<number>) when the workspace key is known, falling
//                     back to the classic /posts/<uuid> route otherwise (no domain
//                     hardcoded, no share token: there is no public-share concept).
//                     The ui/toast says "Link copied".
//   - Download all -> the same attachment-disposition presigned URL the PCS
//                     lightbox already uses per image, looped over the gallery.
// It is mounted in LIVE PCS only (never the read-only old-version view).
// Delete post and Remove image ask nothing: the menu closes and the page acts
// at once behind its UNDO_MS Undo strip ("Post deleted", "Image removed").

import { useContext, useMemo, useState } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { ActionMenu, orderActionItems, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Sheet } from '@/components/ui/Sheet';
import {
  IconCalendar,
  IconDownload,
  IconLink,
  IconPipeline,
  IconSend,
  IconTrash,
  type IconProps,
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
 * One stage move offered in the menu (flow B 31): the creator's Approve on
 * their behalf, Park and Reject. The page owns the move (its confirm, Undo and
 * errors); the menu closes, then hands off.
 */
export interface PostMoveRow {
  key: string;
  icon: ComponentType<IconProps>;
  label: string;
  sub?: string;
  danger?: boolean;
  onPick: () => void;
}

/** A toast from the menu: neutral for a success, the bad tone for a failure. */
export type PostActionToast = (message: string, tone?: 'error') => void;

interface PostActionSheetProps {
  /** Controlled open state; the trigger (or the host) asks through onOpenChange. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The opener. Absent: ActionMenu's default ⋯ "More actions", where the page
   * renders this (top-right of the header). null: the host opens it (the plan
   * item's own header button).
   */
  trigger?: ReactNode | null;
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
  /** Show a toast on the app-wide ui/toast. */
  onToast: PostActionToast;
  /** Owner, admin or agency (canDeletePost): gates the Delete post row. */
  canDelete: boolean;
  /**
   * Delete the post at once; the page runs the UNDO_MS "Post deleted" Undo
   * window, the proc call, the failure toast and the navigation.
   */
  onDeletePost: () => Promise<void> | void;
  /** Embedded in a plan item: the first row, Open in pipeline. Absent elsewhere. */
  onOpenInPipeline?: () => void;
  /** Stage moves (creators only); absent or empty shows none. */
  moveRows?: readonly PostMoveRow[];
  /**
   * Remove the slide the gallery shows (agency, editable stage only); absent
   * hides the row. Hands off to the page, which removes it behind an Undo strip.
   */
  removeImage?: RemoveImageAction | undefined;
}

/** The header menu's Remove image row: which slide, and the page's remove. */
export interface RemoveImageAction {
  /** Zero-based slide the gallery shows. */
  index: number;
  /** Total slides, for the row line. */
  count: number;
  /** A gallery write is in flight: the row says "Saving…" and does nothing. */
  saving: boolean;
  onRemove: () => void;
}

/**
 * Flow B 38: the delete row's line, honest about the recovery surface. There
 * is no confirm (spec B7); the Undo strip is the safety net.
 */
export const DELETE_CONFIRM_BASE = 'Moves to Recently deleted. You can restore it there.';

/** The menu's accessible name and phone sheet title. */
export const POST_ACTIONS_TITLE = 'Post actions';

/** What the menu offers and what each row does. */
export interface PostActionItemsInput {
  onOpenInPipeline?: (() => void) | undefined;
  /** The plan item's Move to another day, when the item screen provides it. */
  onMoveInPlan?: (() => void) | undefined;
  moveRows?: readonly PostMoveRow[];
  onSendToChat: () => void;
  onCopyLink: () => void;
  /** The image count for Download all images; null hides the row. */
  download: { count: number; busy: boolean; onSelect: () => void } | null;
  removeImage?: RemoveImageAction | undefined;
  onDelete: (() => void) | null;
}

/** The menu rows in the one ⋯ order (Open, Copy link, the rest, Delete last). Pure. */
export function postActionItems(input: PostActionItemsInput): ActionMenuItem[] {
  const items: ActionMenuItem[] = [];
  if (input.onOpenInPipeline !== undefined) {
    items.push({
      id: 'open-pipeline',
      label: 'Open in pipeline',
      icon: IconPipeline,
      description: 'See this post in the pipeline',
      onSelect: input.onOpenInPipeline,
    });
  }
  items.push({
    id: 'copy-link',
    label: 'Copy link',
    icon: IconLink,
    description: 'In-app link to this post',
    onSelect: input.onCopyLink,
  });
  if (input.onMoveInPlan !== undefined) {
    items.push({
      id: 'move-plan',
      label: MOVE_ROW_LABEL,
      icon: IconCalendar,
      onSelect: input.onMoveInPlan,
    });
  }
  for (const row of input.moveRows ?? []) {
    items.push({
      id: `move-${row.key}`,
      label: row.label,
      icon: row.icon,
      ...(row.sub !== undefined ? { description: row.sub } : {}),
      ...(row.danger === true ? { tone: 'danger' as const } : {}),
      onSelect: row.onPick,
    });
  }
  items.push({
    id: 'send-to-chat',
    label: 'Send to chat',
    icon: IconSend,
    description: 'Share this post in a conversation',
    onSelect: input.onSendToChat,
  });
  if (input.download !== null) {
    const { count, busy, onSelect } = input.download;
    items.push({
      id: 'download-all',
      label: 'Download all images',
      icon: IconDownload,
      description: busy ? 'Preparing downloads' : `${count} image${count === 1 ? '' : 's'}`,
      onSelect,
    });
  }
  const remove = input.removeImage;
  if (remove !== undefined && remove.count > 0) {
    items.push({
      id: 'remove-image',
      label: 'Remove image',
      icon: IconTrash,
      tone: 'danger',
      description: remove.saving
        ? 'Saving…'
        : `Image ${Math.min(remove.index, remove.count - 1) + 1} of ${remove.count}`,
      onSelect: () => {
        if (!remove.saving) remove.onRemove();
      },
    });
  }
  if (input.onDelete !== null) {
    items.push({
      id: 'delete-post',
      label: 'Delete post',
      icon: IconTrash,
      tone: 'danger',
      description: DELETE_CONFIRM_BASE,
      onSelect: input.onDelete,
    });
  }
  return orderActionItems(items);
}

/** The action row labels in menu order. Pure. */
export function postActionLabels(opts: {
  openInPipeline: boolean;
  download: boolean;
  canDelete: boolean;
  removeImage?: boolean;
}): string[] {
  const noop = (): void => {};
  return postActionItems({
    ...(opts.openInPipeline ? { onOpenInPipeline: noop } : {}),
    onSendToChat: noop,
    onCopyLink: noop,
    download: opts.download ? { count: 1, busy: false, onSelect: noop } : null,
    ...(opts.removeImage === true
      ? { removeImage: { index: 0, count: 1, saving: false, onRemove: noop } }
      : {}),
    onDelete: opts.canDelete ? noop : null,
  }).map((item) => item.label);
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
  onOpenChange,
  trigger,
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
  removeImage,
}: PostActionSheetProps): ReactElement {
  const planRows = useContext(PostSheetPlanRowsContext);
  const [chatOpen, setChatOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const images = useMemo(() => gallery.filter(isDownloadableImage), [gallery]);
  const showDownload = canDownloadAll(gallery);

  async function handleCopyLink(): Promise<void> {
    const link = postCopyLink(window.location.origin, workspaceKey, postNumber, postId);
    const ok = await copyText(link);
    if (ok) onToast('Link copied');
    else onToast(COPY_FAILED, 'error');
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
        onToast(errorText('prepare the images for download', null), 'error');
        return;
      }
      for (let i = 0; i < descriptors.length; i += 1) {
        const descriptor = descriptors[i];
        if (descriptor === undefined) continue;
        triggerDownload(descriptor.url, descriptor.filename);
        if (i < descriptors.length - 1) await wait(DOWNLOAD_GAP_MS);
      }
      if (descriptors.length < images.length) {
        onToast("Some images couldn't be downloaded", 'error');
      } else {
        onToast(`Downloading ${descriptors.length} image${descriptors.length === 1 ? '' : 's'}`);
      }
    } finally {
      setDownloading(false);
    }
  }

  // Spec B7: no confirm. The menu closes, then the page deletes behind its
  // Undo strip ("Post deleted" · Undo, UNDO_MS).
  const items = postActionItems({
    onOpenInPipeline,
    ...(planRows !== null ? { onMoveInPlan: planRows.onMove } : {}),
    moveRows,
    onSendToChat: () => setChatOpen(true),
    onCopyLink: () => void handleCopyLink(),
    download: showDownload
      ? { count: images.length, busy: downloading, onSelect: () => void handleDownloadAll() }
      : null,
    removeImage,
    onDelete: canDelete ? () => void onDeletePost() : null,
  });

  return (
    <>
      <ActionMenu
        title={POST_ACTIONS_TITLE}
        items={items}
        open={open}
        onOpenChange={onOpenChange}
        {...(trigger !== undefined ? { trigger } : {})}
      />
      <Sheet open={chatOpen} onClose={() => setChatOpen(false)} title="Send to chat">
        <ConversationPicker
          postId={postId}
          workspaceId={workspaceId}
          currentUserId={currentUserId}
          onToast={(message) => onToast(message)}
          onSent={() => setChatOpen(false)}
        />
      </Sheet>
    </>
  );
}
