import { describe, expect, it } from 'vitest';
import { groupByStage, stageColumns } from '@/lib/post-board';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { Post, Stage } from '@srtdio/posts';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

function post(over: Partial<Post>): Post {
  return {
    id: 'p',
    workspace_id: 'w',
    number: 1,
    title: 'Untitled',
    stage: STAGES[0]!,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    ...over,
  };
}

describe('groupByStage', () => {
  it('buckets posts into their stage column preserving input order', () => {
    const first = STAGES[0]!;
    const second = STAGES[1]!;
    const grouped = groupByStage(
      [
        post({ id: 'a', stage: first }),
        post({ id: 'b', stage: second }),
        post({ id: 'c', stage: first }),
      ],
      STAGES,
    );
    expect(grouped[first].map((p) => p.id)).toEqual(['a', 'c']);
    expect(grouped[second].map((p) => p.id)).toEqual(['b']);
  });

  it('gives every stage an array even when empty', () => {
    const grouped = groupByStage([], STAGES);
    for (const stage of STAGES) expect(grouped[stage]).toEqual([]);
  });
});

describe('stageColumns', () => {
  it('shows every stage for the All tab', () => {
    expect(stageColumns(STAGES, 'all')).toEqual(STAGES);
  });

  it('shows only the selected stage tab', () => {
    const target = STAGES[1]!;
    expect(stageColumns(STAGES, target)).toEqual([target]);
  });
});
