import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { BOARD_CAP, emptyStageMessage } from '@/components/pages/pipeline/stage-meta';
import { PostCard } from '@/components/pages/PostCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { groupByStage } from '@/lib/post-board';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

// PostCard is never invoked here (the tree is walked, not rendered), so the cache
// is only carried as a prop and a stub satisfies the type without a real one.
const cache = {} as unknown as PresignCache;

function makePost(id: string, stage: Stage): PipelinePost {
  return {
    id,
    workspace_id: 'w',
    title: `Post ${id}`,
    stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
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
    thumbnailAssetVersionId: null,
  };
}

function manyIn(stage: Stage, n: number): PipelinePost[] {
  return Array.from({ length: n }, (_unused, i) => makePost(`${stage}-${i}`, stage));
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function cardCount(tree: ReactNode): number {
  return findAll(tree, (el) => el.type === PostCard).length;
}

function dataStage(el: ReactElement): string | undefined {
  return (el.props as { 'data-stage'?: string })['data-stage'];
}

describe('PipelineFeed', () => {
  it('All tab renders one grouped section per stage, capped at the board cap', () => {
    const first = STAGES[0]!;
    const grouped = groupByStage(manyIn(first, BOARD_CAP + 2), STAGES);
    const tree = PipelineFeed({
      stages: STAGES,
      grouped,
      activeStage: 'all',
      cache,
      presignEnabled: false,
      onViewAll: () => {},
    });

    const sections = findAll(tree, (el) =>
      Boolean((el.props as { 'data-feed-section'?: boolean })['data-feed-section']),
    );
    expect(sections.map(dataStage)).toEqual(STAGES);

    const overflowing = sections.find((s) => dataStage(s) === first)!;
    expect(cardCount(overflowing)).toBe(BOARD_CAP);
  });

  it('shows a View all affordance on a stage with more than the cap and wires it', () => {
    const first = STAGES[0]!;
    const grouped = groupByStage(manyIn(first, BOARD_CAP + 5), STAGES);
    let viewed: Stage | undefined;
    const tree = PipelineFeed({
      stages: STAGES,
      grouped,
      activeStage: 'all',
      cache,
      presignEnabled: false,
      onViewAll: (s) => {
        viewed = s;
      },
    });

    const viewAll = findAll(tree, (el) => {
      const label = (el.props as { 'aria-label'?: string })['aria-label'];
      return typeof label === 'string' && label.startsWith('View all');
    });
    expect(viewAll).toHaveLength(1);
    (viewAll[0]!.props as { onClick: () => void }).onClick();
    expect(viewed).toBe(first);
  });

  it('a single-stage tab renders that stage uncapped', () => {
    const first = STAGES[0]!;
    const grouped = groupByStage(manyIn(first, BOARD_CAP + 7), STAGES);
    const tree = PipelineFeed({
      stages: STAGES,
      grouped,
      activeStage: first,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
    });
    expect(cardCount(tree)).toBe(BOARD_CAP + 7);
  });

  it('an empty single-stage tab shows the EmptyState message', () => {
    const first = STAGES[0]!;
    const grouped = groupByStage([], STAGES);
    const tree = PipelineFeed({
      stages: STAGES,
      grouped,
      activeStage: first,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
    });
    const empties = findAll(tree, (el) => el.type === EmptyState);
    expect(empties).toHaveLength(1);
    expect((empties[0]!.props as { title?: string }).title).toBe(emptyStageMessage(first));
  });
});

describe('PipelineBoard', () => {
  it('renders one column per stage in the locked order', () => {
    const grouped = groupByStage([], STAGES);
    const tree = PipelineBoard({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
    });
    const columns = findAll(tree, (el) =>
      Boolean((el.props as { 'data-drag-container'?: boolean })['data-drag-container']),
    );
    expect(columns.map(dataStage)).toEqual(STAGES);
  });
});
