import { describe, expect, it, vi } from 'vitest';
import type { DragEvent, ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PipelineBoard } from '@/components/pages/pipeline/PipelineBoard';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { BOARD_CAP, emptyStageMessage } from '@/components/pages/pipeline/stage-meta';
import { groupByStage } from '@/lib/post-board';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

// The board tree is walked (PostCard never invoked) and the feed renders with
// presign disabled, so the cache is never touched on either path: a bare stub
// satisfies the type without a real one.
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

// The feed renders real PostCards (it owns hooks now), so it is exercised via SSR
// markup rather than tree-walking. Cards carry a data-post-id, so counting those
// attributes counts rendered cards. presignEnabled is false so the injected cache
// is never touched and a bare stub satisfies the type.
function renderFeed(props: { posts: PipelinePost[]; activeStage: string }): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PipelineFeed
        posts={props.posts}
        activeStage={props.activeStage}
        cache={cache}
        presignEnabled={false}
        onLongPressPost={() => {}}
      />
    </MemoryRouter>,
  );
}

function feedCardCount(markup: string): number {
  return (markup.match(/data-post-id=/g) ?? []).length;
}

function dataStage(el: ReactElement): string | undefined {
  return (el.props as { 'data-stage'?: string })['data-stage'];
}

/** A minimal synthetic DragEvent carrying a "fromStage:postId" payload on drop. */
function dropEvent(payload: string): DragEvent<HTMLDivElement> {
  return {
    preventDefault: () => {},
    currentTarget: { classList: { remove: () => {} } },
    dataTransfer: { getData: () => payload },
  } as unknown as DragEvent<HTMLDivElement>;
}

describe('PipelineFeed', () => {
  it('the All tab renders one flat grid capped at the board cap, with a Show more control', () => {
    const first = STAGES[0]!;
    const markup = renderFeed({ posts: manyIn(first, BOARD_CAP + 2), activeStage: 'all' });
    // The first page shows exactly the cap; the overflow is gated behind Show more.
    expect(feedCardCount(markup)).toBe(BOARD_CAP);
    // The remaining 2 are offered in place (min of the cap and the remainder).
    expect(markup).toContain('Show 2 more');
  });

  it('caps the Show more label at the board cap when more than a page remains', () => {
    const first = STAGES[0]!;
    const markup = renderFeed({ posts: manyIn(first, BOARD_CAP * 3), activeStage: 'all' });
    expect(feedCardCount(markup)).toBe(BOARD_CAP);
    // A full next page remains, so the label offers exactly one cap's worth.
    expect(markup).toContain(`Show ${BOARD_CAP} more`);
  });

  it('no Show more control when the list fits within the cap', () => {
    const first = STAGES[0]!;
    const markup = renderFeed({ posts: manyIn(first, BOARD_CAP - 1), activeStage: 'all' });
    expect(feedCardCount(markup)).toBe(BOARD_CAP - 1);
    expect(markup).not.toContain('Show');
  });

  it('a single-stage tab shows only that stage, capped at the board cap', () => {
    const first = STAGES[0]!;
    const second = STAGES[1]!;
    const posts = [...manyIn(first, BOARD_CAP + 3), ...manyIn(second, 4)];
    const markup = renderFeed({ posts, activeStage: first });
    // Only the active stage's posts are listed, and they cap at the board cap.
    expect(feedCardCount(markup)).toBe(BOARD_CAP);
    expect(markup).toContain('Show 3 more');
  });

  it('an empty single-stage tab shows the stage EmptyState message', () => {
    const first = STAGES[0]!;
    const markup = renderFeed({ posts: [], activeStage: first });
    expect(markup).toContain(emptyStageMessage(first));
  });

  it('an empty All tab shows the "No posts yet" EmptyState', () => {
    const markup = renderFeed({ posts: [], activeStage: 'all' });
    expect(markup).toContain('No posts yet');
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
      onMovePost: () => {},
    });
    const columns = findAll(tree, (el) =>
      Boolean((el.props as { 'data-drag-container'?: boolean })['data-drag-container']),
    );
    expect(columns.map(dataStage)).toEqual(STAGES);
  });

  it('(structural) the horizontal scroll container locks the vertical axis to the page', () => {
    const grouped = groupByStage([], STAGES);
    const tree = PipelineBoard({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
    });
    const scroll = findAll(tree, (el) =>
      Boolean((el.props as { 'data-board-scroll'?: boolean })['data-board-scroll']),
    );
    expect(scroll).toHaveLength(1);
    const className = (scroll[0]!.props as { className: string }).className;
    expect(className).toContain('overflow-x-auto');
    // Vertical-lock: only the horizontal axis scrolls; the page owns vertical scroll.
    expect(className).toContain('overflow-y-hidden');
    expect(className).toContain('min-h-0');
  });

  it('a drop onto a legal target calls the move handler with the post + target stage', () => {
    const onMovePost = vi.fn();
    const grouped = groupByStage([makePost('p1', 'draft')], STAGES);
    const tree = PipelineBoard({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
    });
    const review = findAll(tree, (el) => dataStage(el) === 'review' && 'onDrop' in el.props)[0]!;
    // draft -> review is legal per the transition map.
    (review.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(
      dropEvent('draft:p1'),
    );
    expect(onMovePost).toHaveBeenCalledWith('p1', 'review');
  });

  it('a drop onto an invalid target does NOT call the move handler', () => {
    const onMovePost = vi.fn();
    const grouped = groupByStage([makePost('p1', 'approved')], STAGES);
    const tree = PipelineBoard({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
    });
    const draft = findAll(tree, (el) => dataStage(el) === 'draft' && 'onDrop' in el.props)[0]!;
    // approved -> draft is NOT in the transition map; the drop must bounce.
    (draft.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(
      dropEvent('approved:p1'),
    );
    expect(onMovePost).not.toHaveBeenCalled();
  });
});
