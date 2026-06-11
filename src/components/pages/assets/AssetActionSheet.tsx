import { useState } from 'react';
import { IconCopy, IconDownload, IconLink } from '@/components/ui/icons';
import { IconInfo } from '@/components/pages/assets/viewerIcons';
import type { PresignCache } from '@/lib/asset-presign';
import { displayLabel, linkDomain, type AssetListItem } from '@/lib/assets';
import { resolveAssetUrl } from '@/components/pages/assets/media';

const SIGN_FAIL = "Couldn't get a link for this asset. Try again.";

interface AssetActionSheetProps {
  item: AssetListItem;
  presignEnabled: boolean;
  cache: PresignCache;
  onClose: () => void;
  /** Open the lightbox for this asset with its Info sheet shown (non-links only). */
  onInfo: (item: AssetListItem) => void;
  onToast: (message: string) => void;
}

function Row({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-sm text-fg hover:bg-panel-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="text-fg-2">{icon}</span>
      {label}
    </button>
  );
}

/**
 * Bottom action sheet opened by a long-press on a card. Files get Download /
 * Copy link / Info; links get Open {domain} / Copy link (no Info, since links
 * never open in the lightbox). Reuses the shared presign helper for URLs.
 */
export function AssetActionSheet({
  item,
  presignEnabled,
  cache,
  onClose,
  onInfo,
  onToast,
}: AssetActionSheetProps) {
  const [busy, setBusy] = useState(false);
  const isLink = item.kind === 'link';
  const name = displayLabel(item);
  const canAct = isLink
    ? item.externalUrl !== null
    : presignEnabled && item.currentVersionId !== null;

  async function withUrl(apply: (url: string) => void | Promise<void>): Promise<void> {
    setBusy(true);
    try {
      const url = await resolveAssetUrl(item, cache);
      await apply(url);
    } catch {
      onToast(SIGN_FAIL);
    } finally {
      setBusy(false);
    }
  }

  const handlePrimary = (): void => {
    void withUrl((url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      if (!isLink) onToast('Download started');
      onClose();
    });
  };

  const handleCopy = (): void => {
    void withUrl(async (url) => {
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
      onClose();
    });
  };

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
        <div className="truncate px-3 py-2 text-sm font-semibold text-fg">{name}</div>
        <Row
          icon={isLink ? <IconLink size={18} /> : <IconDownload size={18} />}
          label={isLink ? `Open ${linkDomain(item.externalUrl)}` : 'Download'}
          onClick={handlePrimary}
          disabled={!canAct || busy}
        />
        <Row
          icon={<IconCopy size={18} />}
          label="Copy link"
          onClick={handleCopy}
          disabled={!canAct || busy}
        />
        {!isLink ? (
          <Row icon={<IconInfo size={18} />} label="Info" onClick={() => onInfo(item)} />
        ) : null}
      </div>
    </div>
  );
}
