import { describe, expect, it, vi } from 'vitest';
import type { DragEvent, ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  BoardApproveConfirm,
  PipelineBoardView,
  pendingPost,
} from '@/components/pages/pipeline/PipelineBoard';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { ApproveConfirm } from '@/components/ui/ApproveConfirm';
import { onBehalfConfirmLine } from '@/components/pages/pcs/stage-actions';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import { PostCard } from '@/components/pages/PostCard';
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
    number: 1,
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
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
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
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
    });
    const columns = findAll(tree, (el) =>
      Boolean((el.props as { 'data-drag-container'?: boolean })['data-drag-container']),
    );
    expect(columns.map(dataStage)).toEqual(STAGES);
  });

  it('(structural) the horizontal scroll container locks the vertical axis to the page', () => {
    const grouped = groupByStage([], STAGES);
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
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
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
      role: 'agency',
    });
    const review = findAll(tree, (el) => dataStage(el) === 'review' && 'onDrop' in el.props)[0]!;
    // draft -> review is legal per the transition map.
    (review.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(
      dropEvent('draft:p1'),
    );
    expect(onMovePost).toHaveBeenCalledWith('p1', 'review');
  });

  it('client: a drop into Parked or Review bounces; Approved and Rejected go through', () => {
    const onMovePost = vi.fn();
    const grouped = groupByStage([makePost('p1', 'review')], STAGES);
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
      role: 'client',
    });
    const dropOn = (stage: Stage, payload: string): void => {
      const col = findAll(tree, (el) => dataStage(el) === stage && 'onDrop' in el.props)[0]!;
      (col.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(dropEvent(payload));
    };
    dropOn('parked', 'review:p1');
    dropOn('review', 'rejected:p1');
    expect(onMovePost).not.toHaveBeenCalled();
    dropOn('rejected', 'review:p1');
    expect(onMovePost).toHaveBeenCalledWith('p1', 'rejected');
    dropOn('approved', 'review:p1');
    expect(onMovePost).toHaveBeenCalledWith('p1', 'approved');
  });

  it('a drop onto an invalid target does NOT call the move handler', () => {
    const onMovePost = vi.fn();
    const grouped = groupByStage([makePost('p1', 'approved')], STAGES);
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped,
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
      role: 'agency',
    });
    const draft = findAll(tree, (el) => dataStage(el) === 'draft' && 'onDrop' in el.props)[0]!;
    // approved -> draft is NOT in the transition map; the drop must bounce.
    (draft.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(
      dropEvent('approved:p1'),
    );
    expect(onMovePost).not.toHaveBeenCalled();
  });
});

describe('PipelineBoard single-stage grid', () => {
  function attr(el: ReactElement, name: string): unknown {
    return (el.props as Record<string, unknown>)[name];
  }

  it('a single-stage view renders one full-width grid, not the column layout', () => {
    const tree = PipelineBoardView({
      stages: ['review'],
      grouped: groupByStage(manyIn('review', 12), STAGES),
      cap: null,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
    });
    const grids = findAll(tree, (el) => Boolean(attr(el, 'data-board-grid')));
    expect(grids).toHaveLength(1);
    const className = (grids[0]!.props as { className: string }).className;
    expect(className).toContain('grid-cols-[repeat(auto-fill,minmax(220px,1fr))]');
    expect(className).toContain('gap-4');
    expect(className).not.toContain('overflow');
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-drag-container')))).toHaveLength(0);
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-board-scroll')))).toHaveLength(0);
    // Every post renders (no cap, no View all); none is draggable (W4 fix 9).
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-post-id')))).toHaveLength(12);
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-drag-item')))).toHaveLength(0);
    expect(findAll(tree, (el) => attr(el, 'draggable') === true)).toHaveLength(0);
  });

  it('an empty single-stage view names the stage with emptyStageMessage', () => {
    const tree = PipelineBoardView({
      stages: ['parked'],
      grouped: groupByStage([], STAGES),
      cap: null,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
    });
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('Nothing in Parked. Posts land here when moved.');
    expect(markup).toContain('data-board-grid');
  });

  it('All still renders the column layout, not the grid', () => {
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped: groupByStage([], STAGES),
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
    });
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-board-grid')))).toHaveLength(0);
    expect(findAll(tree, (el) => Boolean(attr(el, 'data-drag-container')))).toHaveLength(
      STAGES.length,
    );
  });
});

function harness(): {
  gate: ReturnType<typeof createApproveGate>;
  move: ReturnType<typeof vi.fn<(postId: string, toStage: Stage) => void>>;
  state: () => GateState;
} {
  let state = GATE_IDLE;
  const move = vi.fn<(postId: string, toStage: Stage) => void>();
  const gate = createApproveGate({
    move,
    read: () => state,
    write: (next) => {
      state = next;
    },
  });
  return { gate, move, state: () => state };
}

type ConfirmProps = Parameters<typeof ApproveConfirm>[0];

/** The board wired as PipelineBoard wires it: drops go through the gate. */
function board(h: ReturnType<typeof harness>, posts: PipelinePost[]): ReactNode {
  return PipelineBoardView({
    stages: STAGES,
    grouped: groupByStage(posts, STAGES),
    cap: BOARD_CAP,
    cache,
    presignEnabled: false,
    onViewAll: () => {},
    onMovePost: h.gate.request,
    role: 'agency',
  });
}

function drop(tree: ReactNode, stage: Stage, payload: string): void {
  const column = findAll(tree, (el) => dataStage(el) === stage && 'onDrop' in el.props)[0]!;
  (column.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(dropEvent(payload));
}

/** The confirm sheet for the current gate state, as PipelineBoard renders it. */
function sheet(h: ReturnType<typeof harness>, posts: PipelinePost[]): ReactElement | null {
  return BoardApproveConfirm({
    post: pendingPost(groupByStage(posts, STAGES), h.state().pendingId),
    gate: h.gate,
    gateState: h.state(),
    timeZone: 'UTC',
    onBehalf: false,
  });
}

function confirmOf(el: ReactElement | null): ConfirmProps {
  const footer = (el?.props as { footer: ReactElement }).footer;
  expect(footer.type).toBe(ApproveConfirm);
  return footer.props as ConfirmProps;
}

describe('PipelineBoard approve confirm (drop)', () => {
  const review = makePost('p1', 'review');

  it('T1: a drop into Approved opens the confirm and does not move', () => {
    const h = harness();
    expect(sheet(h, [review])).toBeNull();
    drop(board(h, [review]), 'approved', 'review:p1');
    expect(h.move).not.toHaveBeenCalled();
    expect((sheet(h, [review])?.props as { open: boolean }).open).toBe(true);
  });

  it('T2: Back and the Sheet close (button, backdrop, Escape) send nothing', () => {
    const h = harness();
    drop(board(h, [review]), 'approved', 'review:p1');
    confirmOf(sheet(h, [review])).onBack();
    expect(h.state()).toEqual(GATE_IDLE);
    drop(board(h, [review]), 'approved', 'review:p1');
    (sheet(h, [review])?.props as { onClose: () => void }).onClose();
    expect(h.state()).toEqual(GATE_IDLE);
    expect(h.move).not.toHaveBeenCalled();
  });

  it('T3: Confirm moves once with the drop args and closes the sheet', () => {
    const h = harness();
    drop(board(h, [review]), 'approved', 'review:p1');
    confirmOf(sheet(h, [review])).onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
    expect((sheet(h, [review])?.props as { open: boolean }).open).toBe(false);
  });

  it('T4: a double tap on Confirm moves once; Confirm disables once sent', () => {
    const h = harness();
    drop(board(h, [review]), 'approved', 'review:p1');
    const props = confirmOf(sheet(h, [review]));
    props.onConfirm();
    props.onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(confirmOf(sheet(h, [review])).busy).toBe(true);
  });

  it('T5: drops into Rejected and Parked move at once with no confirm', () => {
    for (const stage of ['rejected', 'parked'] as const) {
      const h = harness();
      drop(board(h, [review]), stage, 'review:p1');
      expect(h.move).toHaveBeenCalledWith('p1', stage);
      expect(sheet(h, [review])).toBeNull();
    }
  });

  it('T6: the confirm names the post title and the target date when set, never slides', () => {
    const h = harness();
    const dated = { ...review, number: 9, target_date: '2026-10-02T06:30:00Z' };
    drop(board(h, [dated]), 'approved', 'review:p1');
    expect(confirmOf(sheet(h, [dated]))).toMatchObject({
      postTitle: 'Post p1',
      mediaCount: null,
      targetDate: '2 Oct',
    });
    expect(confirmOf(sheet(h, [review])).targetDate).toBe('');
    // The sheet title is the format alone and the confirm never shows a KEY-N code.
    const el = sheet(h, [dated]);
    expect((el?.props as { title: string }).title).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    const html = renderToStaticMarkup((el?.props as { footer: ReactElement }).footer);
    expect(html).toContain('Approve Post p1, for 2 Oct?');
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  it('T7: an agency approve confirm adds the on-behalf line; a client one does not', () => {
    for (const onBehalf of [true, false]) {
      const h = harness();
      drop(board(h, [review]), 'approved', 'review:p1');
      const el = BoardApproveConfirm({
        post: pendingPost(groupByStage([review], STAGES), h.state().pendingId),
        gate: h.gate,
        gateState: h.state(),
        timeZone: 'UTC',
        onBehalf,
      });
      const html = renderToStaticMarkup(
        (el?.props as { children: ReactNode }).children as ReactElement,
      );
      expect(html.includes(onBehalfConfirmLine(null))).toBe(onBehalf);
    }
  });
});

describe('W4 board fixes', () => {
  it('fix 8: a drop onto a column the post cannot reach toasts the reason', () => {
    const onMovePost = vi.fn();
    const onBlockedMove = vi.fn();
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped: groupByStage([makePost('p1', 'draft')], STAGES),
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost,
      role: 'agency',
      onBlockedMove,
    });
    const drop = (stage: Stage, payload: string): void => {
      const col = findAll(tree, (el) => dataStage(el) === stage && 'onDrop' in el.props)[0]!;
      (col.props as { onDrop: (e: DragEvent<HTMLDivElement>) => void }).onDrop(dropEvent(payload));
    };
    drop('approved', 'draft:p1');
    expect(onMovePost).not.toHaveBeenCalled();
    expect(onBlockedMove).toHaveBeenCalledWith('Not allowed from Draft');
    // A drop back onto its own column is silent.
    onBlockedMove.mockClear();
    drop('draft', 'draft:p1');
    expect(onBlockedMove).not.toHaveBeenCalled();
  });

  it('fix 8: dragging over a blocked column still accepts the drop event, without the ring', () => {
    const tree = PipelineBoardView({
      stages: STAGES,
      grouped: groupByStage([makePost('p1', 'draft')], STAGES),
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
    });
    const card = findAll(
      tree,
      (el) =>
        (el.props as { 'data-post-id'?: string })['data-post-id'] === 'p1' &&
        'onDragStart' in el.props,
    )[0]!;
    (card.props as { onDragStart: (e: unknown) => void }).onDragStart({
      dataTransfer: { setData: () => {} },
    });
    const prevent = vi.fn();
    const add = vi.fn();
    const col = findAll(tree, (el) => dataStage(el) === 'approved' && 'onDragOver' in el.props)[0]!;
    (col.props as { onDragOver: (e: unknown) => void }).onDragOver({
      preventDefault: prevent,
      dataTransfer: {},
      currentTarget: { classList: { add } },
    });
    expect(prevent).toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    (card.props as { onDragEnd: () => void }).onDragEnd();
  });

  it('fix 1 and 5: every board card gets the Move button handler and, in All, the stage line', () => {
    const onOpenMove = vi.fn();
    const columns = PipelineBoardView({
      stages: STAGES,
      grouped: groupByStage([makePost('p1', 'draft'), makePost('p2', 'review')], STAGES),
      cap: BOARD_CAP,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
      onOpenMove,
    });
    const cards = findAll(columns, (el) => el.type === PostCard);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const props = card.props as { onMove?: unknown; showStage?: boolean };
      expect(props.onMove).toBe(onOpenMove);
      expect(props.showStage).toBe(true);
    }
    const grid = PipelineBoardView({
      stages: ['review'],
      grouped: groupByStage([makePost('p2', 'review')], STAGES),
      cap: null,
      cache,
      presignEnabled: false,
      onViewAll: () => {},
      onMovePost: () => {},
      role: 'agency',
      onOpenMove,
    });
    const gridCard = findAll(grid, (el) => el.type === PostCard)[0]!;
    expect((gridCard.props as { onMove?: unknown }).onMove).toBe(onOpenMove);
  });

  it('fix 1: the phone feed renders a Move button on every card', () => {
    const markup = renderFeed({ posts: manyIn('review', 3), activeStage: 'review' });
    expect((markup.match(/data-post-card-move=""/g) ?? []).length).toBe(3);
  });

  it('fix 5: the All feed leads each card with its stage; a single-stage feed does not', () => {
    expect(renderFeed({ posts: [makePost('a', 'parked')], activeStage: 'all' })).toContain(
      'data-post-card-stage',
    );
    expect(renderFeed({ posts: [makePost('a', 'parked')], activeStage: 'parked' })).not.toContain(
      'data-post-card-stage',
    );
  });

  it('fix 9: the approve confirm title wraps to two lines', () => {
    let state: GateState = GATE_IDLE;
    const gate = createApproveGate({
      move: () => {},
      read: () => state,
      write: (next) => {
        state = next;
      },
    });
    gate.request('p1', 'approved');
    const tree = BoardApproveConfirm({
      post: makePost('p1', 'review'),
      gate,
      gateState: state,
      timeZone: 'UTC',
      onBehalf: false,
    })!;
    const title = findAll(tree, (el) => 'data-approve-title' in (el.props as object))[0]!;
    expect((title.props as { className: string }).className).toContain('line-clamp-2');
  });
});
