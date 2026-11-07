// The one pending-file chip (decision F, 7 Nov): a picked file, a shared post
// or a shared brief in a composer tray (chat composer, CommentComposer,
// SlotComposer, ConceptSheet for a Plan concept and a Bank idea). A 48 thumb
// (radius 8), title over one meta line, chip radius 12, padding 4. Tokens only.
//
// States keep the chip's footprint:
//   uploading: ui/UploadRing (X cancels) on the thumb, size progress as meta
//              ("1.2 of 3.4 MB"), no trailing X.
//   ready:     type · size meta and a trailing X that removes it.
//   failed:    bad border, "Couldn't upload", Retry, and the trailing X.

import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { UploadRing, uploadSizeMeta } from '@/components/ui/UploadRing';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/file-size';

export type PendingChipStatus =
  | { state: 'ready' }
  | { state: 'uploading'; progress: number | null }
  | { state: 'failed' };

/** The failed chip's meta line (Errors "Couldn't {action}"). */
export const PENDING_CHIP_FAILED = "Couldn't upload";

/**
 * A ready chip's type word: the name's extension ("deck.pdf" -> PDF), else the
 * mime's subtype ("image/png" -> PNG), else FILE. Pure.
 */
export function chipType(name: string, mime?: string | null): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  if (mime !== undefined && mime !== null && mime !== '') {
    const subtype = mime.split('/')[1] ?? mime;
    return (subtype.split(/[+;]/)[0] ?? subtype).trim().toUpperCase() || 'FILE';
  }
  return 'FILE';
}

/**
 * A ready chip's meta: "PDF · 1.2 MB"; the type alone while the size is not
 * known (0 or absent). Pure.
 */
export function readyChipMeta(file: {
  name: string;
  mime?: string | null | undefined;
  size?: number | null | undefined;
}): string {
  const type = chipType(file.name, file.mime);
  const size = file.size ?? 0;
  return size > 0 ? `${type} · ${humanizeSize(size)}` : type;
}

/**
 * An uploading chip's meta: "1.2 of 3.4 MB" once bytes are known (loaded),
 * else the file's total size ("3.4 MB"). Never a % figure. Pure.
 */
export function uploadingChipMeta(totalBytes: number, loadedBytes?: number | null): string {
  if (loadedBytes !== undefined && loadedBytes !== null && totalBytes > 0) {
    return uploadSizeMeta(loadedBytes, totalBytes);
  }
  return humanizeSize(totalBytes);
}

export function PendingChip(props: {
  thumb: ReactNode;
  title: string;
  /** Ready: "PDF · 1.2 MB"; uploading: "1.2 of 3.4 MB" (uploadSizeMeta). */
  meta: string;
  /** Defaults to ready. */
  status?: PendingChipStatus | undefined;
  onRemove: () => void;
  /** Uploading: the X on the thumb cancels. Defaults to onRemove. */
  onCancel?: (() => void) | undefined;
  /** Failed: Retry re-runs the upload; omitted when it can't be retried. */
  onRetry?: (() => void) | undefined;
  /** The caller's data-* hooks on the chip's <li> (tests, e2e, its own state names). */
  dataAttrs?: Readonly<Record<`data-${string}`, string>> | undefined;
}): ReactElement {
  const status = props.status ?? { state: 'ready' };
  const uploading = status.state === 'uploading';
  const failed = status.state === 'failed';
  return (
    <li
      {...props.dataAttrs}
      data-pending-chip={status.state}
      className={cn(
        'flex items-center gap-2 rounded-xl border bg-panel-2 p-1 lit-card-muted',
        failed && 'border-bad lit-bad',
      )}
    >
      <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3 lit-media">
        {props.thumb}
        {uploading ? (
          <UploadRing
            variant="file"
            label="Cancel upload"
            progress={status.progress}
            onCancel={props.onCancel ?? props.onRemove}
            className="absolute inset-0 m-auto"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 max-w-44 flex-col">
        <span className="truncate text-sm font-medium text-fg" title={props.title}>
          {props.title}
        </span>
        <span
          data-pending-chip-meta=""
          className={cn(
            'truncate font-mono text-xs tabular-nums',
            failed ? 'text-bad' : 'text-fg-3',
          )}
        >
          {failed ? PENDING_CHIP_FAILED : props.meta}
        </span>
      </span>
      {failed && props.onRetry !== undefined ? (
        <Button
          type="button"
          variant="link"
          className="min-w-11 shrink-0"
          aria-label={`Retry ${props.title}`}
          onClick={props.onRetry}
        >
          Retry
        </Button>
      ) : null}
      {uploading ? (
        // Keeps the trailing slot's width so the chip never changes size.
        <span aria-hidden="true" className="h-11 w-11 shrink-0" />
      ) : (
        <IconButton label={`Remove ${props.title}`} onClick={props.onRemove}>
          <IconX size={ICON_SIZE.inline} />
        </IconButton>
      )}
    </li>
  );
}
