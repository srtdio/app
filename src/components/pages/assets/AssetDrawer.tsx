import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconCopy, IconDownload, IconFile, IconLink, IconX } from '@/components/ui/icons';
import type { PresignCache } from '@/lib/asset-presign';
import { formatDimensions, humanizeSize, linkDomain, type AssetListItem } from '@/lib/assets';

interface AssetDrawerProps {
  item: AssetListItem;
  /** The active workspace's permanent R2 bucket (workspaces.asset_bucket). */
  bucket: string | null;
  presignEnabled: boolean;
  cache: PresignCache;
  onClose: () => void;
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-fg-3">{label}</span>
      <span className={mono ? 'text-xs font-mono break-all text-fg-2' : 'text-sm text-fg'}>
        {value}
      </span>
    </div>
  );
}

/** Resolve the openable URL for an asset: the external link, or a presigned GET. */
async function resolveUrl(item: AssetListItem, cache: PresignCache): Promise<string> {
  if (item.kind === 'link') {
    if (item.externalUrl === null) throw new Error('Link has no URL.');
    return item.externalUrl;
  }
  if (item.currentVersionId === null) throw new Error('Asset has no stored version.');
  return (await cache.resolve(item.currentVersionId)).url;
}

export function AssetDrawer({ item, bucket, presignEnabled, cache, onClose }: AssetDrawerProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Eagerly presign the open asset's preview (one drawer, no fan-out concern).
  useEffect(() => {
    if (!presignEnabled || item.kind !== 'image' || item.currentVersionId === null) return;
    let live = true;
    cache
      .resolve(item.currentVersionId)
      .then((p) => {
        if (live) setPreview(p.url);
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [item, presignEnabled, cache]);

  const canAct = item.kind === 'link' ? item.externalUrl !== null : presignEnabled;

  async function withUrl(apply: (url: string) => void | Promise<void>): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const url = await resolveUrl(item, cache);
      await apply(url);
    } catch {
      setMessage('Could not get a link for this asset.');
    } finally {
      setBusy(false);
    }
  }

  const handleDownload = (): void => {
    void withUrl((url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  };

  const handleCopy = (): void => {
    void withUrl(async (url) => {
      await navigator.clipboard.writeText(url);
      setMessage('Link copied.');
    });
  };

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-label={`Details for ${item.filename}`}
        className="absolute flex flex-col bg-panel inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t border-border md:inset-y-0 md:left-auto md:right-0 md:w-[380px] md:max-h-none md:rounded-none md:border-l md:border-t-0"
      >
        <div className="flex items-center gap-2 h-14 px-4 border-b border-border shrink-0">
          <h2 className="flex-1 truncate text-sm font-semibold">{item.filename}</h2>
          <IconButton label="Close" onClick={onClose}>
            <IconX size={18} />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <div className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-panel-2 flex items-center justify-center">
            {item.kind === 'image' && preview !== null ? (
              <img src={preview} alt={item.filename} className="h-full w-full object-contain" />
            ) : item.kind === 'link' ? (
              <div className="flex flex-col items-center gap-1 text-fg-2">
                <IconLink size={26} />
                <span className="text-xs">{linkDomain(item.externalUrl)}</span>
              </div>
            ) : (
              <IconFile size={28} className="text-fg-3" />
            )}
          </div>

          <Field label="Filename" value={item.filename} />
          {item.kind === 'link' ? (
            <Field label="URL" value={item.externalUrl ?? '-'} mono />
          ) : (
            <>
              <Field label="Type" value={item.mimeType ?? '-'} />
              <Field label="Size" value={humanizeSize(item.sizeBytes)} />
              <Field label="Dimensions" value={formatDimensions(item.width, item.height)} />
              <Field
                label="Version"
                value={item.versionNumber !== null ? `v${item.versionNumber}` : '-'}
              />
              <Field label="Bucket" value={bucket ?? '-'} mono />
              <Field label="Key" value={item.r2Key ?? '-'} mono />
            </>
          )}
          <Field
            label="Attached to"
            value={`${item.attachmentCount} ${item.attachmentCount === 1 ? 'place' : 'places'}`}
          />
        </div>

        <div className="shrink-0 border-t border-border p-4 flex flex-col gap-2">
          {message !== null ? <div className="text-xs text-fg-3">{message}</div> : null}
          <div className="flex gap-2">
            <Button
              variant="primary"
              className="flex-1"
              onClick={handleDownload}
              disabled={!canAct || busy}
            >
              <IconDownload size={16} />
              Download
            </Button>
            <Button className="flex-1" onClick={handleCopy} disabled={!canAct || busy}>
              <IconCopy size={16} />
              Copy URL
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
