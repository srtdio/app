import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconCopy, IconDownload, IconEdit, IconLink, IconTrash } from '@/components/ui/icons';
import { IconInfo } from '@/components/pages/assets/viewerIcons';
import { displayLabel, linkDomain, type AssetListItem } from '@/lib/assets';
import { downloadFile, openLinkInNewTab } from '@/components/pages/assets/openExternal';
import { assetLink } from '@/components/pages/assets/assets-nav';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { useEscapeLayer } from '@/lib/escape-stack';

const SIGN_FAIL = "Couldn't get a link for this asset. Try again.";

/** One row of the file menu, in display order. */
export type AssetMenuRow = 'primary' | 'copy' | 'rename' | 'info' | 'delete';

/**
 * The file menu's rows in order: Download (Open {domain} for a link), Copy
 * link, Rename (owner/admin/agency only), Info (files only,
 * links never open in the viewer), Delete last. Pure.
 */
export function assetMenuRows(isLink: boolean, canRename: boolean): AssetMenuRow[] {
  const rows: AssetMenuRow[] = ['primary', 'copy'];
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

interface AssetActionSheetProps {
  item: AssetListItem;
  presignEnabled: boolean;
  /** Mint an attachment-disposition URL so a download saves in place, never navigating. */
  requestDownloadUrl: (item: AssetListItem) => Promise<string>;
  /** True when the current member may rename (owner/admin/agency). */
  canRename?: boolean;
  onClose: () => void;
  /** Open the lightbox for this asset with its Info sheet shown (non-links only). */
  onInfo: (item: AssetListItem) => void;
  /** Open the rename sheet for this asset. */
  onRename?: ((item: AssetListItem) => void) | undefined;
  /** Hide the asset now and offer Undo; the page commits after the window. */
  onDelete?: ((item: AssetListItem) => void) | undefined;
  onToast: (message: string) => void;
}

function Row({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full !justify-start !gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent${
        destructive ? ' text-bad hover:text-bad' : ''
      }`}
    >
      <span className={destructive ? 'text-bad' : 'text-fg-2'}>{icon}</span>
      {label}
    </Button>
  );
}

/**
 * Bottom action sheet opened by a card's ⋯ or a long-press. Rows follow
 * assetMenuRows: Download (or Open {domain}), Copy link, Rename, Info, and a
 * destructive Delete last. Theme tokens only; rows are 48px.
 */
export function AssetActionSheet({
  item,
  presignEnabled,
  requestDownloadUrl,
  canRename = false,
  onClose,
  onInfo,
  onRename,
  onDelete,
  onToast,
}: AssetActionSheetProps) {
  const [busy, setBusy] = useState(false);
  // Escape closes the menu while it is the top layer.
  useEscapeLayer(true, onClose);
  const isLink = item.kind === 'link';
  const name = displayLabel(item);
  const canDownload = isLink
    ? item.externalUrl !== null
    : presignEnabled && item.currentVersionId !== null;

  const handlePrimary = (): void => {
    // Link: open a new tab synchronously (keeps the user gesture) and close.
    if (isLink) {
      if (item.externalUrl !== null) openLinkInNewTab(item.externalUrl);
      onClose();
      return;
    }
    // File: save in place via a content-disposition: attachment URL. On success
    // toast and close; on failure surface SIGN_FAIL and leave the sheet open.
    setBusy(true);
    void downloadFile(() => requestDownloadUrl(item))
      .then(() => {
        onToast('Download started');
        onClose();
      })
      .catch(() => onToast(SIGN_FAIL))
      .finally(() => setBusy(false));
  };

  const canCopy = !isLink || item.externalUrl !== null;
  const handleCopy = (): void => {
    const target = copyLinkTarget(item, window.location.origin);
    if (target === null) return;
    void copyText(target).then((ok) => {
      onToast(ok ? 'Link copied' : COPY_FAILED);
      onClose();
    });
  };

  const rows = assetMenuRows(isLink, canRename && onRename !== undefined).filter(
    (row) => row !== 'delete' || onDelete !== undefined,
  );

  return (
    <div className="fixed inset-0 z-40 flex items-end">
      <button
        type="button"
        aria-label="Close actions"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-label={`Actions for ${name}`}
        className="relative w-full rounded-t-2xl border-t border-border bg-panel p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:mx-auto md:mb-4 md:max-w-sm md:rounded-2xl md:border"
      >
        <div className="truncate px-3 py-2 text-legacy-sm font-semibold text-fg">{name}</div>
        {rows.map((row) => {
          switch (row) {
            case 'primary':
              return (
                <Row
                  key={row}
                  icon={isLink ? <IconLink size={18} /> : <IconDownload size={18} />}
                  label={isLink ? `Open ${linkDomain(item.externalUrl)}` : 'Download'}
                  onClick={handlePrimary}
                  disabled={!canDownload || busy}
                />
              );
            case 'copy':
              return (
                <Row
                  key={row}
                  icon={<IconCopy size={18} />}
                  label="Copy link"
                  onClick={handleCopy}
                  disabled={!canCopy || busy}
                />
              );
            case 'rename':
              return (
                <Row
                  key={row}
                  icon={<IconEdit size={18} />}
                  label="Rename"
                  onClick={() => onRename?.(item)}
                />
              );
            case 'info':
              return (
                <Row
                  key={row}
                  icon={<IconInfo size={18} />}
                  label="Info"
                  onClick={() => onInfo(item)}
                />
              );
            case 'delete':
              return (
                <Row
                  key={row}
                  icon={<IconTrash size={18} />}
                  label="Delete"
                  onClick={() => onDelete?.(item)}
                  destructive
                />
              );
          }
        })}
      </div>
    </div>
  );
}
