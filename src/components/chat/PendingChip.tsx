// One removable chip in the composer tray: a picked file (with its upload
// status), a shared post or a shared brief all use this one look. A 48px thumb,
// title over one meta line, and a 44px remove control. Tokens only.

import type { ReactElement, ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

export function PendingChip(props: {
  thumb: ReactNode;
  title: string;
  meta: string;
  /** Upload failed: the chip border and meta line take the bad token. */
  error?: boolean;
  onRemove: () => void;
}): ReactElement {
  const error = props.error === true;
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-panel-2 py-1 pl-1 pr-1',
        error ? 'border-bad' : 'border-border',
      )}
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3">
        {props.thumb}
      </span>
      <span className="flex min-w-0 max-w-[180px] flex-col">
        <span className="truncate text-sm font-medium text-fg" title={props.title}>
          {props.title}
        </span>
        <span className={cn('truncate text-xs', error ? 'text-bad' : 'text-fg-3')}>
          {props.meta}
        </span>
      </span>
      <IconButton label={`Remove ${props.title}`} onClick={props.onRemove}>
        <IconX size={16} />
      </IconButton>
    </li>
  );
}
