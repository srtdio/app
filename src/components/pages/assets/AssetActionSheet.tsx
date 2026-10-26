import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import {
  IconCopy,
  IconDownload,
  IconEdit,
  IconInfo,
  IconLink,
  IconTrash,
} from '@/components/ui/icons';
import { linkDomain, type AssetListItem } from '@/lib/assets';
import { downloadFile, openLinkInNewTab } from '@/components/pages/assets/openExternal';
import { assetLink } from '@/components/pages/assets/assets-nav';
import { COPY_FAILED, copyText } from '@/lib/clipboard';

const SIGN_FAIL = "Couldn't get a link for this file. Try again.";

/** Toast sink for Assets: a failure passes 'error' (the bad tone); a success passes nothing (neutral). */
export type AssetToast = (message: string, tone?: 'error') => void;

/** One row of the file menu, in display order. */
type AssetMenuRow = 'primary' | 'copy' | 'rename' | 'info' | 'delete';

/**
 * The file menu's rows in the one ⋯ order: Open {domain} first for a link,
 * Copy link, then Download (files), Rename (owner/admin/agency only), Info
 * (files only, links never open in the viewer), Delete last. A row the
 * member cannot use (no download URL, nothing to copy) is left out, never
 * shown disabled. Pure.
 */
export function assetMenuRows(
  isLink: boolean,
  canRename: boolean,
  canDownload = true,
  canCopy = true,
): AssetMenuRow[] {
  const rows: AssetMenuRow[] = [];
  if (isLink && canDownload) rows.push('primary');
  if (canCopy) rows.push('copy');
  if (!isLink && canDownload) rows.push('primary');
  if (canRename) rows.push('rename');
  if (!isLink) rows.push('info');
  rows.push('delete');
  return rows;
}

/**
 * What Copy link copies: a file's in-app link (/assets?asset=<id>), which opens
 * for workspace members and never expires; a link asset's own external URL. Never
 * a presigned storage URL. Pure.
 */
export function copyLinkTarget(item: AssetListItem, origin: string): string | null {
  if (item.kind === 'link') return item.externalUrl;
  return assetLink(origin, item.id);
}

export interface AssetMenuDeps {
  presignEnabled: boolean;
  /** Mint an attachment-disposition URL so a download saves in place, never navigating. */
  requestDownloadUrl: (item: AssetListItem) => Promise<string>;
  /** True when the current member may rename (owner/admin/agency). */
  canRename?: boolean;
  /** Open the lightbox for this asset with its Info sheet shown (non-links only). */
  onInfo: (item: AssetListItem) => void;
  /** Open the rename sheet for this asset. */
  onRename?: ((item: AssetListItem) => void) | undefined;
  /** Hide the asset now and offer Undo; the page commits after the window. */
  onDelete?: ((item: AssetListItem) => void) | undefined;
  onToast: AssetToast;
}

/**
 * The rows of one card's ⋯ menu (ui/ActionMenu), opened by its ⋯ or a long
 * press. Rows follow assetMenuRows; Delete is last in the danger tone and
 * deletes at once (the page offers Undo). The menu closes before a row runs,
 * so a download reports by toast: neutral on success, bad tone on failure.
 */
export function assetMenuItems(item: AssetListItem, deps: AssetMenuDeps): ActionMenuItem[] {
  const isLink = item.kind === 'link';
  const canDownload = isLink
    ? item.externalUrl !== null
    : deps.presignEnabled && item.currentVersionId !== null;
  const canCopy = !isLink || item.externalUrl !== null;
  const { onRename, onDelete } = deps;
  const rows = assetMenuRows(
    isLink,
    deps.canRename === true && onRename !== undefined,
    canDownload,
    canCopy,
  ).filter((row) => row !== 'delete' || onDelete !== undefined);

  const primary = (): void => {
    // Link: open a new tab synchronously (keeps the user gesture).
    if (isLink) {
      if (item.externalUrl !== null) openLinkInNewTab(item.externalUrl);
      return;
    }
    // File: save in place via a content-disposition: attachment URL.
    void downloadFile(() => deps.requestDownloadUrl(item))
      .then(() => deps.onToast('Download started'))
      .catch(() => deps.onToast(SIGN_FAIL, 'error'));
  };

  const copy = (): void => {
    const target = copyLinkTarget(item, window.location.origin);
    if (target === null) return;
    void copyText(target).then((ok) =>
      ok ? deps.onToast('Link copied') : deps.onToast(COPY_FAILED, 'error'),
    );
  };

  return rows.map((row): ActionMenuItem => {
    switch (row) {
      case 'primary':
        return isLink
          ? {
              id: 'open-link',
              label: `Open ${linkDomain(item.externalUrl)}`,
              icon: IconLink,
              onSelect: primary,
            }
          : { id: 'download', label: 'Download', icon: IconDownload, onSelect: primary };
      case 'copy':
        return { id: 'copy-link', label: 'Copy link', icon: IconCopy, onSelect: copy };
      case 'rename':
        return { id: 'rename', label: 'Rename', icon: IconEdit, onSelect: () => onRename?.(item) };
      case 'info':
        return { id: 'info', label: 'Info', icon: IconInfo, onSelect: () => deps.onInfo(item) };
      case 'delete':
        return {
          id: 'delete',
          label: 'Delete',
          icon: IconTrash,
          tone: 'danger',
          onSelect: () => onDelete?.(item),
        };
    }
  });
}
