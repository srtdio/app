// Renders the attachments on one message. The per-attachment dispatch is
// explicit (classifyAttachment -> branch) so PR6 can add a shared-post branch
// without touching the image / file branches. Each attachment presigns through
// the shared PresignCache, which dedupes in-flight ids and caches URLs, so a
// thread of attachments never fires N+1 presigns and re-renders never re-presign.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { IconFile } from '@/components/ui/icons';
import { fileExtension } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { classifyAttachment, type MessageAttachment } from '@/lib/chat/attachments';

/** Presign one attachment id once, refreshing shortly before expiry; never throws. */
function useAttachmentUrl(
  assetId: string,
  cache: PresignCache,
  enabled: boolean,
): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(() =>
    enabled && assetId !== '' ? (cache.peek(assetId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || assetId === '') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(assetId);
        if (!live) return;
        setUrl(presigned.url);
        setFailed(false);
        const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
        timer = setTimeout(() => {
          if (live) void load();
        }, delay);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [assetId, cache, enabled]);

  return { url, failed };
}

function FileChip({ name, url }: { name: string; url: string | null }): ReactElement {
  const ext = fileExtension(name);
  const label = name.trim() !== '' ? name : 'Attachment';
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-2.5 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconFile size={18} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-fg" title={label}>
          {label}
        </span>
        {url !== null ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-medium text-accent hover:underline"
          >
            Open
          </a>
        ) : (
          <span className="text-[11px] text-fg-3">{ext !== '' ? ext : 'File'}</span>
        )}
      </span>
    </div>
  );
}

function AttachmentItem({
  attachment,
  cache,
  presignEnabled,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const { url, failed } = useAttachmentUrl(attachment.assetId, cache, presignEnabled);

  // Render dispatch by attachment kind. PR6 extension point: add a 'post' case
  // here for a shared-post card; keep this branch (image / file) untouched.
  if (classifyAttachment(attachment.mime) === 'image' && presignEnabled && !failed) {
    if (url !== null) {
      return (
        <img
          src={url}
          alt={attachment.name}
          className="max-h-48 max-w-[260px] rounded-lg border border-border object-cover"
        />
      );
    }
    return <div className="h-32 w-44 animate-pulse rounded-lg border border-border bg-panel-2" />;
  }

  return <FileChip name={attachment.name} url={url} />;
}

export function MessageAttachments({
  attachments,
  cache,
  presignEnabled,
}: {
  attachments: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {attachments.map((attachment, index) => (
        <AttachmentItem
          key={`${attachment.assetId}-${index}`}
          attachment={attachment}
          cache={cache}
          presignEnabled={presignEnabled}
        />
      ))}
    </div>
  );
}
