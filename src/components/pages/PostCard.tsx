import { Chip } from '@/components/ui/Chip';
import type { Post } from '@srtdio/posts';

/** Format an ISO date as a date only (no time), matching the board reference. */
function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A pipeline board card: title, a chip for platform, a chip for format, and the
 * target date when present. No owner name in this PR.
 */
export function PostCard({ post }: { post: Post }) {
  return (
    <div className="rounded-lg border border-border bg-panel p-3 flex flex-col gap-2">
      <div className="text-sm font-medium leading-snug line-clamp-2">{post.title}</div>
      <div className="flex flex-wrap gap-1.5">
        <Chip label={post.platform} />
        <Chip label={post.format} />
      </div>
      {post.target_date !== null ? (
        <div className="text-xs text-fg-3 tabular-nums">{formatTargetDate(post.target_date)}</div>
      ) : null}
    </div>
  );
}
