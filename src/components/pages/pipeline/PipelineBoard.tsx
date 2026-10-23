import { useEffect, useState } from 'react';
import type { DragEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ApproveConfirm, approveTargetDate } from '@/components/ui/ApproveConfirm';
import { OnBehalfApproveSheet } from '@/components/ui/OnBehalfApproveSheet';
import { Sheet } from '@/components/ui/Sheet';
import { PostCard } from '@/components/pages/PostCard';
import {
  StageDot,
  StageEmpty,
  moveBlockedReason,
  stageLabel,
} from '@/components/pages/pipeline/stage-meta';
import {
  useApproveGate,
  type ApproveGate,
  type GateState,
  type MoveFn,
} from '@/components/pages/pipeline/approve-gate';
import type { PresignCache } from '@/lib/asset-presign';
import type { CoverLookup } from '@/lib/chat/post-covers';
import { hasAllowedMove, type CardViewer } from '@/components/pages/pipeline/card-status';
import { useWorkspace } from '@/lib/workspace-context';
import { isAgencySide } from '@/components/pages/pcs/roles';
import { canRoleMove } from '@/components/pages/pcs/stage-actions';
import { useWorkspaceApprovers } from '@/components/pages/pcs/use-approvers';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PipelineBoardProps {
  /** Columns to render, in the locked STAGE order (all stages, or one per-stage view). */
  stages: Stage[];
  grouped: Record<Stage, PipelinePost[]>;
  /** Cards per column before the View all foot control; null shows them all (per-stage view). */
  cap: number | null;
  /** One shared presign cache for the whole board; never per-column or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey?: string | null;
  /** Foot control on an overflowing column; the page decides what it switches to. */
  onViewAll: (stage: Stage) => void;
  /**
   * A legal drop calls up to the page's single move handler at once; a drop on
   * Approved does so only after the approve (or on-behalf) sheet confirms, with
   * the picked approver.
   */
  onMovePost: MoveFn;
  /** The viewer's workspace role: a client may only drop into Approved / Rejected. */
  role: string | null;
  /**
   * The role read has landed. Until then no card is draggable, so a drop never
   * bounces silently. Default true.
   */
  roleReady?: boolean;
  /** post.create granted: an empty stage also offers New post. */
  canCreate?: boolean;
  /** A card's Move button asks the page to open the move sheet for that post. */
  onOpenMove?: (post: PipelinePost) => void;
  /** A drop onto a column the post cannot move to: the page toasts the reason. */
  onBlockedMove?: (reason: string) => void;
  /** The workspace zone each card reads its target day in. Default UTC. */
  timeZone?: string;
  /** The viewer's role and approvers: each card's status line and its ⋯. */
  viewer?: CardViewer;
  /** Each post's first photo or video, so its card takes the platform frame. */
  covers?: CoverLookup;
}

// Native HTML5 DnD keeps dataTransfer unreadable during dragover (it is exposed
// only on drop), so the source stage is stashed here on dragstart purely to drive
// the per-column drop affordance. The authoritative payload still rides
// dataTransfer ("fromStage:postId") and is re-read and re-checked on drop, so the
// move never relies on this module variable for correctness.
let draggingFrom: Stage | null = null;

const DROP_OK = ['ring-2', 'ring-accent', 'ring-inset'];

function onCardDragStart(event: DragEvent<HTMLDivElement>, post: PipelinePost): void {
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  draggingFrom = post.stage as Stage;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', `${post.stage}:${post.id}`);
}

function onCardDragEnd(): void {
  draggingFrom = null;
}

function onColumnDragOver(
  event: DragEvent<HTMLDivElement>,
  toStage: Stage,
  role: string | null,
): void {
  if (draggingFrom === null || draggingFrom === toStage) {
    return;
  }
  // Every other column accepts the drop so a blocked one can say why; only a
  // target legal for this role shows the affordance.
  event.preventDefault();
  // (dropEffect 'none' would cancel the drop event, so a blocked column keeps
  // the default effect and just never lights up.)
  if (!canRoleMove(role, draggingFrom, toStage)) {
    return;
  }
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add(...DROP_OK);
}

function onColumnDragLeave(event: DragEvent<HTMLDivElement>): void {
  event.currentTarget.classList.remove(...DROP_OK);
}

function onColumnDrop(
  event: DragEvent<HTMLDivElement>,
  toStage: Stage,
  onMovePost: MoveFn,
  role: string | null,
  onBlockedMove?: (reason: string) => void,
): void {
  event.preventDefault();
  event.currentTarget.classList.remove(...DROP_OK);
  draggingFrom = null;
  const [fromStage, postId] = event.dataTransfer.getData('text/plain').split(':');
  if (postId === undefined || postId === '') {
    return;
  }
  // Bounce an illegal drop with no state change; a drop back onto its own column
  // is silent, any other says where this post can go ("Draft posts can move to
  // Review or Parked.") or that only approvers approve.
  if (!canRoleMove(role, fromStage as Stage, toStage)) {
    const reason = moveBlockedReason(role, fromStage as Stage, toStage);
    if (reason !== null) onBlockedMove?.(reason);
    return;
  }
  onMovePost(postId, toStage);
}

/**
 * The board with its approve gate: a legal drop into Approved opens the approve
 * sheet and only its Approve calls the page's move handler; every other legal
 * drop moves at once (the page toasts "Moved to {Stage}" with Undo). An
 * agency-side role gets the on-behalf sheet (pick the approver, carried into
 * the move); a client gets the plain approve confirm. The confirm's post and
 * target date come from the dropped post's row already in `grouped` and the
 * workspace context; slide count (not loaded here) is left out.
 */
export function PipelineBoard(props: PipelineBoardProps): ReactElement {
  const { gate, state } = useApproveGate(props.onMovePost);
  const { workspaces, workspaceId, workspaceName } = useWorkspace();
  const approvers = useWorkspaceApprovers(workspaceId);
  const timeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? 'UTC';
  const pending = pendingPost(props.grouped, state.pendingId);
  // The last confirmed-or-cancelled post stays rendered so the sheet plays its
  // exit instead of vanishing.
  const [shown, setShown] = useState<PipelinePost | null>(null);
  useEffect(() => {
    if (pending !== null) setShown(pending);
  }, [pending]);
  const open = state.pendingId !== null && !state.sent;
  return (
    <>
      <PipelineBoardView {...props} timeZone={timeZone} onMovePost={gate.request} />
      {isAgencySide(props.role) ? (
        <OnBehalfApproveSheet
          open={open}
          approvers={approvers}
          brand={workspaceName}
          busy={state.sent}
          onCancel={gate.cancel}
          onConfirm={(onBehalfOf) => gate.confirm(onBehalfOf)}
        />
      ) : (
        <BoardApproveConfirm
          post={pending ?? shown}
          gate={gate}
          gateState={state}
          timeZone={timeZone}
        />
      )}
    </>
  );
}

/** The post a pending approve names, found in the rows the board already holds. */
export function pendingPost(
  grouped: Record<Stage, PipelinePost[]>,
  postId: string | null,
): PipelinePost | null {
  if (postId === null) return null;
  for (const posts of Object.values(grouped)) {
    const hit = posts.find((post) => post.id === postId);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * A client's approve confirm after a drop on Approved: the shared Sheet
 * (translateY axis) titled with the post, and the chat-matching confirm in its
 * body asking the question once ("Approve this post, for 2 Oct?"), so the
 * title is never repeated. Confirm sends once and closes; Back, the close
 * button, the backdrop and Escape send nothing. Hookless, so the tree is unit
 * tested by walking it.
 */
export function BoardApproveConfirm(props: {
  /** The post to name: the pending one, or the last one while the sheet exits. */
  post: PipelinePost | null;
  gate: ApproveGate;
  gateState: GateState;
  timeZone: string;
}): ReactElement | null {
  const { post, gate, gateState } = props;
  if (post === null) return null;
  return (
    <Sheet
      open={gateState.pendingId !== null && !gateState.sent}
      onClose={gate.cancel}
      title={post.title}
    >
      <ApproveConfirm
        postTitle={null}
        mediaCount={null}
        targetDate={approveTargetDate(post.target_date, props.timeZone)}
        busy={gateState.sent}
        onBack={gate.cancel}
        onConfirm={() => gate.confirm()}
      />
    </Sheet>
  );
}

/**
 * Desktop kanban: one fixed-width column per stage (a single-stage view renders
 * the full-width {@link SingleStageGrid} instead) in the locked STAGE order,
 * horizontally scrolled. Cards are native-draggable items (once the role is
 * known, and only when the role has a move) and columns are drop targets; a
 * drop onto a legal target for the viewer's role (canRoleMove) calls up to the
 * page's move handler, an illegal drop bounces with its reason. Cards in a
 * column never repeat the column's stage name or dot. No DnD library, native
 * events only, and no stageTransition call lives here. Capped columns surface a View all control at
 * the foot. Hookless (drag affordance toggles classes on the event target and the
 * payload rides dataTransfer) so the structure stays unit-testable by walking the
 * returned tree.
 */
export function PipelineBoardView({
  stages,
  grouped,
  cap,
  cache,
  presignEnabled,
  workspaceKey = null,
  onViewAll,
  onMovePost,
  role,
  onOpenMove,
  onBlockedMove,
  timeZone = 'UTC',
  viewer,
  covers,
  roleReady = true,
  canCreate = false,
}: PipelineBoardProps): ReactElement {
  const only = stages.length === 1 ? stages[0] : undefined;
  if (only !== undefined) {
    // Called, not mounted, so the tree stays walkable in unit tests (hookless).
    return SingleStageGrid({
      stage: only,
      posts: grouped[only],
      cache,
      presignEnabled,
      workspaceKey,
      timeZone,
      canCreate,
      ...(onOpenMove !== undefined ? { onOpenMove } : {}),
      ...(viewer !== undefined ? { viewer } : {}),
      ...(covers !== undefined ? { covers } : {}),
    });
  }
  return (
    // Lock scrolling to the horizontal axis only: with bare overflow-x-auto the
    // y-axis resolves to auto, so a both-axis scroll fights the app-shell main.
    // overflow-y-hidden + min-h-0 keep vertical scrolling owned by the page.
    <div
      data-board-scroll
      className="flex min-h-0 gap-3 overflow-x-auto overflow-y-hidden px-4 py-4 md:px-6"
    >
      {stages.map((stage) => {
        const all = grouped[stage];
        const shown = cap === null ? all : all.slice(0, cap);
        const overflow = cap !== null && all.length > cap;
        return (
          <div
            key={stage}
            data-drag-container
            data-stage={stage}
            onDragOver={(event) => onColumnDragOver(event, stage, role)}
            onDragLeave={onColumnDragLeave}
            onDrop={(event) => onColumnDrop(event, stage, onMovePost, role, onBlockedMove)}
            className="flex w-[260px] shrink-0 flex-col rounded-xl border border-border bg-panel-2"
          >
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              <StageDot stage={stage} />
              <span className="text-sm font-medium">{stageLabel(stage)}</span>
              <span className="ml-auto text-xs tabular-nums text-fg-3">{all.length}</span>
            </div>
            {all.length === 0 ? (
              <div data-column-empty="">{StageEmpty({ stage, canCreate })}</div>
            ) : (
              <div className="flex flex-col gap-2 p-2">
                {shown.map((post) => {
                  // No drag until the role is known, and none for a card this
                  // role cannot move anywhere.
                  const draggable = roleReady && hasAllowedMove(role, post.stage as Stage);
                  return (
                    <div
                      key={post.id}
                      data-drag-item
                      data-post-id={post.id}
                      draggable={draggable}
                      onDragStart={(event) => onCardDragStart(event, post)}
                      onDragEnd={onCardDragEnd}
                      className="rounded-lg"
                    >
                      <PostCard
                        post={post}
                        cache={cache}
                        presignEnabled={presignEnabled}
                        workspaceKey={workspaceKey}
                        inColumn
                        timeZone={timeZone}
                        {...(onOpenMove !== undefined ? { onMove: onOpenMove } : {})}
                        {...(viewer !== undefined ? { viewer } : {})}
                        {...(covers !== undefined ? { cover: covers(post.id) } : {})}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {overflow ? (
              <div className="border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full"
                  aria-label={`View all ${all.length}`}
                  onClick={() => onViewAll(stage)}
                >
                  View all {all.length}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Single-stage view: the one stage's cards as a full-width auto-fill grid, no
 * column chrome (the active chip already names the stage and count). Flows top
 * to bottom with the page owning vertical scroll; no inner scroll box. Cards are
 * not draggable: the only column on screen is the cards' own stage, so there is
 * nowhere to drop. Moves go through each card's Move button.
 */
function SingleStageGrid({
  stage,
  posts,
  cache,
  presignEnabled,
  workspaceKey,
  timeZone,
  canCreate,
  onOpenMove,
  viewer,
  covers,
}: {
  stage: Stage;
  posts: PipelinePost[];
  cache: PresignCache;
  presignEnabled: boolean;
  workspaceKey: string | null;
  timeZone: string;
  canCreate: boolean;
  onOpenMove?: (post: PipelinePost) => void;
  viewer?: CardViewer;
  covers?: CoverLookup;
}): ReactElement {
  if (posts.length === 0) {
    return (
      <div data-board-grid data-stage={stage} className="px-4 md:px-6">
        {StageEmpty({ stage, canCreate })}
      </div>
    );
  }
  return (
    <div
      data-board-grid
      data-stage={stage}
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 px-4 py-4 md:px-6"
    >
      {posts.map((post) => (
        <div key={post.id} data-post-id={post.id} className="h-full min-w-0 rounded-lg">
          <PostCard
            post={post}
            cache={cache}
            presignEnabled={presignEnabled}
            workspaceKey={workspaceKey}
            timeZone={timeZone}
            {...(onOpenMove !== undefined ? { onMove: onOpenMove } : {})}
            {...(viewer !== undefined ? { viewer } : {})}
            {...(covers !== undefined ? { cover: covers(post.id) } : {})}
          />
        </div>
      ))}
    </div>
  );
}
