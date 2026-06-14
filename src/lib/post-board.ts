// Pure board derivations for the Pipeline: grouping the (already filtered and
// sorted) posts into their workflow columns, and resolving which columns the
// active stage tab shows. Kept stage-agnostic (the caller passes the ordered
// stage list from @srtdio/posts) so no workflow literals leak in here.

import type { Post, Stage } from '@srtdio/posts';

/**
 * Group posts into one bucket per stage, preserving the input order within each.
 * Generic over the post shape so the element type (e.g. PipelinePost, which adds
 * thumbnailAssetVersionId) is preserved instead of widening back to Post.
 */
export function groupByStage<T extends Post>(posts: T[], stages: Stage[]): Record<Stage, T[]> {
  const map = Object.fromEntries(stages.map((s) => [s, [] as T[]])) as Record<Stage, T[]>;
  for (const post of posts) {
    const column = map[post.stage as Stage];
    if (column !== undefined) column.push(post);
  }
  return map;
}

/** The columns to render: every stage for "all", otherwise the one selected tab. */
export function stageColumns(stages: Stage[], active: string): Stage[] {
  return active === 'all' ? stages : stages.filter((s) => s === active);
}
