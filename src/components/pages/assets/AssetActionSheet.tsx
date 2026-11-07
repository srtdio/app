import type { SelectBarAction } from '@/components/ui/SelectBar';
import {
  IconArrowUpRight,
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
import { errorText } from '@/lib/error-copy';

const SIGN_FAIL = errorText('get a link for this file', null);

/** Toast sink for Assets: a failure passes 'error' (the bad tone); a success passes nothing (neutral). */
export type AssetToast = (message: string, tone?: 'error') => void;

/** One row of the file actions (the select bar), in display order. */
type AssetMenuRow = 'primary' | 'copy' | 'rename' | 'info' | 'delete';

/**
 * The file actions in the one order: Open {domain} first for a link,
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

export interface AssetActionDeps {
  presignEnabled: boolean;
  /** Mint an attachment-disposition URL so a download saves in place, never navigating. */
  requestDownloadUrl: (item: AssetListItem) => Promise<string>;
  /** True when the current member may rename (owner/admin/agency). */
  canRename?: boolean;
  /** Open the lightbox for this asset with its Info sheet shown (non-links only). */
  onInfo: (item: AssetListItem) => void;
  /** Open the rename sheet for this asset. */
  onRename?: ((item: AssetListItem) => void) | undefined;
  /** Delete every ticked file: hide them now and offer Undo; the page commits after the window. */
  onDelete?: (() => void) | undefined;
  /** After an in-place row (Open link, Download, Copy link) ran: the page leaves select mode. */
  onDone?: (() => void) | undefined;
  onToast: AssetToast;
}

/** One Assets select bar action: `single` rows show only with exactly one file ticked. */
export type AssetSelectAction = SelectBarAction & { single?: boolean };

/**
 * The Assets select bar's actions (ui/SelectBar), the old card ⋮ rows in the
 * same order: for the one ticked file (`single`) Open {domain} first for a
 * link, Copy link, then Download (files), Rename (owner/admin/agency only),
 * Info (files only); then Delete last in the bad tone, for any count (the
 * page offers Undo). With no single file (`item` undefined: several ticked,
 * or the one is not loaded) only Delete. A row the member cannot use (no
 * download URL, nothing to copy) is left out, never shown disabled. Open link
 * and Copy link run inside the tap (a new tab and the clipboard need it), so a
 * download reports by toast: neutral on success, bad tone on failure.
 */
export function assetSelectActions(
  item: AssetListItem | undefined,
  deps: AssetActionDeps,
): AssetSelectAction[] {
  const { onRename, onDelete, onDone } = deps;
  const remove: AssetSelectAction[] =
    onDelete === undefined
      ? []
      : [{ id: 'delete', label: 'Delete', icon: IconTrash, tone: 'bad', onSelect: onDelete }];
  if (item === undefined) return remove;
  const isLink = item.kind === 'link';
  const canDownload = isLink
    ? item.externalUrl !== null
    : deps.presignEnabled && item.currentVersionId !== null;
  const canCopy = !isLink || item.externalUrl !== null;
  const rows = assetMenuRows(
    isLink,
    deps.canRename === true && onRename !== undefined,
    canDownload,
    canCopy,
  ).filter((row): row is Exclude<AssetMenuRow, 'delete'> => row !== 'delete');

  const primary = (): void => {
    // Link: open a new tab synchronously (keeps the user gesture).
    if (isLink) {
      if (item.externalUrl !== null) openLinkInNewTab(item.externalUrl);
      onDone?.();
      return;
    }
    // File: save in place via a content-disposition: attachment URL.
    void downloadFile(() => deps.requestDownloadUrl(item))
      .then(() => deps.onToast('Download started'))
      .catch(() => deps.onToast(SIGN_FAIL, 'error'));
    onDone?.();
  };

  const copy = (): void => {
    const target = copyLinkTarget(item, window.location.origin);
    if (target !== null) {
      void copyText(target).then((ok) =>
        ok ? deps.onToast('Link copied') : deps.onToast(COPY_FAILED, 'error'),
      );
    }
    onDone?.();
  };

  const single = rows.map((row): AssetSelectAction => {
    switch (row) {
      case 'primary':
        return isLink
          ? {
              id: 'open-link',
              label: `Open ${linkDomain(item.externalUrl)}`,
              icon: IconArrowUpRight,
              onSelect: primary,
              single: true,
            }
          : {
              id: 'download',
              label: 'Download',
              icon: IconDownload,
              onSelect: primary,
              single: true,
            };
      case 'copy':
        return { id: 'copy-link', label: 'Copy link', icon: IconLink, onSelect: copy, single: true };
      case 'rename':
        return {
          id: 'rename',
          label: 'Rename',
          icon: IconEdit,
          onSelect: () => onRename?.(item),
          single: true,
        };
      case 'info':
        return {
          id: 'info',
          label: 'Info',
          icon: IconInfo,
          onSelect: () => deps.onInfo(item),
          single: true,
        };
    }
  });
  return [...single, ...remove];
}
