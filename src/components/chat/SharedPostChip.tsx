// One shared-post chip in the composer, mirroring the attachment PendingChip:
// a removable tag for a post queued to send. It shows the post title and stage
// (no thumbnail; the picker rows carry no cover image) and a 44px remove control.

import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { IconPipeline, IconX } from '@/components/ui/icons';
import type { PostCardFields } from '@srtdio/posts';

/** Title-case a stage value for its label (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export function SharedPostChip({
  post,
  onRemove,
}: {
  post: PostCardFields;
  onRemove: () => void;
}): ReactElement {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 py-1 pl-1 pr-1">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconPipeline size={16} />
      </span>
      <span className="flex min-w-0 max-w-[180px] flex-col">
        <span className="truncate text-xs font-medium text-fg" title={post.title}>
          {post.title}
        </span>
        <span className="text-[11px] text-fg-3">{stageLabel(post.stage)}</span>
      </span>
      <IconButton label={`Remove ${post.title}`} onClick={onRemove}>
        <IconX size={16} />
      </IconButton>
    </li>
  );
}
