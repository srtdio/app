// The post sheet a shared post card opens in chat: every slide of the post, the
// title and its key facts, and the post's decisions. The decisions are Post
// detail's own (pcs/use-post-decisions, the one hook both call): approvers in
// review get Reject and Approve, an approved post can still be rejected;
// creators get "Send for review" or "Send for review again" (open comments ask
// "Send anyway?", never block), and their other moves (Approve on their behalf
// with the approver picker, Reject, Park) sit in the ⋯ menu. Placement is Post
// detail's too: phone, the row is the sheet's bottom bar (its footer); laptop,
// it sits at the right of the title row beside the ⋯. Approvers in review may
// also leave checkpoint points through the same SlotComposer the post page uses.
// The post itself is never refetched: the card's PR 2 row carries every value
// shown. Only the gallery is read, once per open, and the strip paints a
// same-height skeleton until it lands, so the sheet never shortens after first
// paint. A landed move announces sorted:post-changed so every live card
// refetches. Colours are design tokens only, so light and dark match.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, ReactNode, UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { ICON_SIZE, IconArrowUpRight, IconLink, IconPlay } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useThumbnail } from '@/components/media/use-thumbnail';
import {
  CHAT_SHEET_FRAME_MAX_HEIGHT,
  frameMediaClass,
  galleryItemMedia,
  PlatformFrame,
} from '@/components/media/PlatformFrame';
import { frameFor, type Frame } from '@/lib/platform-specs';
import { SlotComposer } from '@/components/comments/SlotComposer';
import type { CheckpointPoint } from '@/components/comments/SlotComposer';
import { runCreateCommentBatch } from '@/components/comments/Comments';
import { PostLightbox, slideFromScroll } from '@/components/pages/pcs/PostLightbox';
import { postHref, type SharedPostView } from '@/components/chat/post-card';
import {
  agencyWaitingHint,
  commentToast,
  detailRows,
  dispatchPostChanged,
  friendlyCommentError,
  isVideoItem,
  postSubject,
  reelLabel,
  sheetTitle,
  stageTagLabel,
  stripCounter,
} from '@/components/chat/post-sheet';
import {
  hasDecisionContent,
  PostDecisionBar,
  PostDecisionRow,
} from '@/components/pages/pcs/PostDecisionBar';
import { usePostDecisions } from '@/components/pages/pcs/use-post-decisions';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import { buildPostLink } from '@/lib/post-share';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { formatDueDate } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { getPostGallery, type GalleryItem } from '../../../packages/posts/src/reads';
import { STAGE_TRANSITIONS, type Stage } from '../../../packages/posts/src/stage-machine';

type PostView = Extract<SharedPostView, { kind: 'post' }>;

/** The gallery for one open: loading until the single read settles. */
export type SheetGallery = { status: 'loading' } | { status: 'ready'; items: GalleryItem[] };

/**
 * The strip: a 4:5 rail bled to the sheet's edges (the negative margins undo the
 * sheet body's padding; auto width then spans them), for a format with no
 * platform frame. The skeleton is the same box.
 */
export const STRIP_BOX = 'relative -mx-[18px] -mt-4 aspect-[4/5] overflow-hidden bg-panel-3';

/** The bled rail a platform frame sits centred in. */
const STRIP_RAIL = 'relative -mx-[18px] -mt-4 flex justify-center bg-panel-3';

/**
 * The strip's platform frame: the post's platform + format and its first slide
 * (stored size when known), so it matches the post page. Pure.
 */
function stripFrame(
  platform: string,
  format: string,
  first: GalleryItem | undefined,
): Frame | null {
  return frameFor(
    platform,
    format,
    first === undefined
      ? null
      : galleryItemMedia(
          first,
          first.width !== null && first.height !== null
            ? { w: first.width, h: first.height }
            : null,
        ),
  );
}

/** A small pill laid over a slide. */
const STRIP_PILL =
  'pointer-events-none inline-flex h-6 items-center gap-1 rounded-md bg-panel px-2 text-sm font-medium text-fg';

/** The sheet's talk-about label. */
export function talkAboutLabel(): string {
  return 'Talk about this post';
}

// ---------------------------------------------------------------------------
// Media strip

function StripSlide(props: {
  item: GalleryItem;
  index: number;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The platform frame the slide fills; null keeps the 4:5 cover crop. */
  frame: Frame | null;
  onOpen: (index: number) => void;
}): ReactElement {
  const { item, index, frame } = props;
  const fit = frame !== null ? frameMediaClass(frame) : 'h-full w-full object-cover';
  const thumb = useThumbnail<HTMLButtonElement>({
    assetVersionId: item.assetVersionId,
    cache: props.cache,
    enabled: props.presignEnabled,
  });
  const video = isVideoItem(item);
  const ready = thumb.url !== null && !thumb.failed;
  return (
    <PressableRow
      flat
      buttonRef={thumb.ref}
      type="button"
      data-strip-slide=""
      aria-label={`Open slide ${index + 1}`}
      onClick={() => props.onOpen(index)}
      className={cn(
        'relative h-full shrink-0 snap-center overflow-hidden',
        frame === null && 'bg-panel-3',
      )}
    >
      {ready && video ? (
        <video
          src={thumb.url ?? undefined}
          preload="metadata"
          muted
          playsInline
          onError={thumb.onError}
          className={cn('pointer-events-none', fit)}
        />
      ) : ready ? (
        <img
          src={thumb.url ?? undefined}
          alt=""
          draggable={false}
          onError={thumb.onError}
          className={fit}
        />
      ) : null}
      {video ? (
        <span
          data-play-badge=""
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-panel text-fg">
            <IconPlay size={ICON_SIZE.control} />
          </span>
        </span>
      ) : null}
    </PressableRow>
  );
}

/**
 * The slide on show again, cropped to fill, behind the frame for blurred bands
 * (YouTube Shorts); the same presigned URL as its slide, so no extra request.
 */
function StripBackdrop(props: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.item.assetVersionId,
    cache: props.cache,
    enabled: props.presignEnabled,
  });
  const ready = thumb.url !== null && !thumb.failed;
  return (
    <span ref={thumb.ref} data-strip-backdrop="" className="block h-full w-full">
      {ready && isVideoItem(props.item) ? (
        <video
          src={thumb.url ?? undefined}
          preload="metadata"
          muted
          playsInline
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : ready ? (
        <img
          src={thumb.url ?? undefined}
          alt=""
          draggable={false}
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}

/**
 * The media strip, or nothing. While the gallery loads it is a skeleton of the
 * same box, shown only when the card row says the post has media; a post with no
 * media renders no box at all, before or after the read.
 */
export function PostSheetMedia(props: {
  gallery: SheetGallery;
  mediaCount: number;
  platform: string;
  format: string;
  active: number;
  cache: PresignCache;
  presignEnabled: boolean;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  onOpen: (index: number) => void;
}): ReactElement | null {
  const { gallery } = props;
  if (gallery.status === 'loading') {
    if (props.mediaCount <= 0) return null;
    const pending = stripFrame(props.platform, props.format, undefined);
    return pending !== null ? (
      <div data-strip-skeleton="" className={STRIP_RAIL}>
        <PlatformFrame
          frame={pending}
          maxHeight={CHAT_SHEET_FRAME_MAX_HEIGHT}
          bordered={false}
          empty
          className="animate-pulse"
        >
          {null}
        </PlatformFrame>
      </div>
    ) : (
      <div data-strip-skeleton="" className={cn(STRIP_BOX, 'animate-pulse')} />
    );
  }
  const items = gallery.items;
  const first = items[0];
  if (first === undefined) return null;
  const count = items.length;
  const reel = reelLabel(props.format, items);
  const frame = stripFrame(props.platform, props.format, first);
  const strip = (
    <>
      <div
        onScroll={props.onScroll}
        aria-roledescription="carousel"
        data-motion-axis="x"
        className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        {items.map((item, index) => (
          <StripSlide
            key={item.assetAttachmentId}
            item={item}
            index={index}
            cache={props.cache}
            presignEnabled={props.presignEnabled}
            frame={frame}
            onOpen={props.onOpen}
          />
        ))}
      </div>
      {count > 1 ? (
        <span
          data-strip-counter=""
          className={cn(STRIP_PILL, 'absolute left-2 top-2 font-mono tabular-nums')}
        >
          {stripCounter(props.active, count)}
        </span>
      ) : null}
      {reel !== null ? (
        <span data-strip-reel="" className={cn(STRIP_PILL, 'absolute right-2 top-2')}>
          {reel}
        </span>
      ) : null}
      {count > 1 ? (
        <span
          aria-hidden="true"
          data-strip-dots=""
          className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5"
        >
          {items.map((item, index) => (
            <span
              key={item.assetAttachmentId}
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                index === props.active ? 'bg-overlay-fg' : 'bg-overlay-dot',
              )}
            />
          ))}
        </span>
      ) : null}
    </>
  );
  return frame !== null ? (
    <div data-strip="" className={STRIP_RAIL}>
      <PlatformFrame
        frame={frame}
        maxHeight={CHAT_SHEET_FRAME_MAX_HEIGHT}
        bordered={false}
        backdrop={
          <StripBackdrop
            item={items[props.active] ?? first}
            cache={props.cache}
            presignEnabled={props.presignEnabled}
          />
        }
      >
        {strip}
      </PlatformFrame>
    </div>
  ) : (
    <div data-strip="" className={STRIP_BOX}>
      {strip}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body

/**
 * The full title (with `aside` at its right: the laptop decision row and the
 * ⋯ menu), the Stage tag, then the key/value rows. Presentational.
 */
export function PostSheetDetails(props: {
  view: PostView;
  /** For tests: the zone moments render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** The workspace's zone: the target (due) date reads its calendar day on it. */
  workspaceZone: string | null | undefined;
  /** The workspace's brand name for "on behalf of <Brand>"; null falls back. */
  brand?: string | null;
  /** The stage to show (a pending move's), in place of the card row's. */
  stage?: string;
  /** Beside the title, at the right: the decision row (laptop) and the ⋯ menu. */
  aside?: ReactNode;
}): ReactElement {
  const { post, approverName, approverRole } = props.view;
  const stage = props.stage ?? post.stage;
  const rows = detailRows(
    post,
    approverName,
    props.timeZone,
    props.workspaceZone,
    approverRole ?? null,
    props.brand,
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <h3 data-sheet-title="" className="min-w-0 flex-1 py-2.5 text-lg font-semibold text-fg">
          {post.title}
        </h3>
        {props.aside !== undefined ? (
          <div data-sheet-title-aside="" className="flex shrink-0 items-center gap-2">
            {props.aside}
          </div>
        ) : null}
      </div>
      <dl className="flex flex-col text-base">
        <div className="flex min-h-[36px] items-center justify-between gap-3 border-b border-border">
          <dt className="text-fg-3">Stage</dt>
          <dd>
            <Tag label={stageTagLabel(stage)} {...(isTagDot(stage) ? { dot: stage } : {})} />
          </dd>
        </div>
        {rows.map((row) => (
          <div
            key={row.key}
            data-sheet-row={row.key}
            className="flex min-h-[36px] items-center justify-between gap-3 border-b border-border last:border-b-0"
          >
            <dt className="shrink-0 text-fg-3">{row.label}</dt>
            <dd className="min-w-0 truncate text-right text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extras

/** The sheet's non-decision buttons and lines under the details. */
export interface PostSheetExtrasProps {
  /** An approver in review may leave checkpoint points; absent hides the button. */
  onComment?: (() => void) | undefined;
  /** Bring the post into the chat's conversation; absent hides the button. */
  onTalkAbout?: (() => void) | undefined;
  /** A quiet meta line (the agency's "Waiting on approvers since ..."), or null. */
  hint: string | null;
}

/**
 * Comment on this post, Talk about this post and the waiting line. None of
 * them moves the post (the decisions are the row's and the ⋯ menu's), so they
 * read the same on phone and laptop. Presentational.
 */
export function PostSheetExtras(props: PostSheetExtrasProps): ReactElement | null {
  if (props.onComment === undefined && props.onTalkAbout === undefined && props.hint === null) {
    return null;
  }
  return (
    <div data-sheet-extras="" className="flex flex-col gap-2">
      {props.onComment !== undefined ? (
        <Button
          type="button"
          variant="secondary"
          data-sheet-comment=""
          onClick={props.onComment}
          className="w-full"
        >
          Comment on this post
        </Button>
      ) : null}
      {props.onTalkAbout !== undefined ? (
        <Button
          type="button"
          variant="link"
          data-sheet-talk-about=""
          onClick={props.onTalkAbout}
          className="w-full bg-accent-soft"
        >
          {talkAboutLabel()}
        </Button>
      ) : null}
      {props.hint !== null ? (
        <p data-sheet-hint="" className="text-center text-sm text-fg-3">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** The ⋯ menu's rows: Open post, Copy link, then the creator's moves. Pure. */
export function postSheetMenuItems(args: {
  onOpenPost: () => void;
  onCopyLink: () => void;
  moves: readonly {
    key: string;
    icon: ActionMenuItem['icon'];
    label: string;
    sub?: string;
    danger?: boolean;
    onPick: () => void;
  }[];
}): ActionMenuItem[] {
  return [
    { id: 'open-post', label: 'Open post', icon: IconArrowUpRight, onSelect: args.onOpenPost },
    { id: 'copy-link', label: 'Copy link', icon: IconLink, onSelect: args.onCopyLink },
    ...args.moves.map(
      (row): ActionMenuItem => ({
        id: `move-${row.key}`,
        label: row.label,
        icon: row.icon,
        ...(row.sub !== undefined ? { description: row.sub } : {}),
        ...(row.danger === true ? { tone: 'danger' as const } : {}),
        onSelect: row.onPick,
      }),
    ),
  ];
}

/** A card row stage the stage machine knows, or null (nothing is offered). Pure. */
export function knownStage(stage: string): Stage | null {
  return Object.prototype.hasOwnProperty.call(STAGE_TRANSITIONS, stage) ? (stage as Stage) : null;
}

/** The viewer's side as the role the decision rules read (any agency role acts alike). */
export function sideRole(side: ViewerSide): string | null {
  if (side === 'client') return 'client';
  if (side === 'agency') return 'agency';
  return null;
}

// ---------------------------------------------------------------------------
// The stateful sheet

interface PostSheetProps {
  open: boolean;
  onClose: () => void;
  view: PostView;
  side: ViewerSide;
  /** For tests: the zone dates render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  cache: PresignCache;
  deps: PresignDeps;
  presignEnabled: boolean;
  /** "Talk about this post": brings the post into the conversation, then the sheet closes. */
  onTalkAbout?: () => void;
}

/** Read the gallery once per open; a closed sheet drops it so a reopen reads fresh. */
function useSheetGallery(open: boolean, postId: string): SheetGallery {
  const [gallery, setGallery] = useState<SheetGallery>({ status: 'loading' });
  useEffect(() => {
    if (!open) {
      setGallery({ status: 'loading' });
      return;
    }
    let cancelled = false;
    void getPostGallery(supabase, postId).then(
      (result) => {
        if (!cancelled) setGallery({ status: 'ready', items: result.ok ? result.data : [] });
      },
      () => {
        if (!cancelled) setGallery({ status: 'ready', items: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, postId]);
  return gallery;
}

export function PostSheet(props: PostSheetProps): ReactElement {
  const { open, onClose, view, side, timeZone } = props;
  const { post } = view;
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const toast = useToast();
  const isLaptop = useIsLaptop();
  const { workspaces, workspaceId, workspaceName, workspaceKey } = useWorkspace();
  const brand = workspaceName ?? null;
  // Due dates are calendar days on the workspace zone (src/lib/time.ts).
  const workspaceZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? null;
  const gallery = useSheetGallery(open, view.postId);
  const [commenting, setCommenting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);

  // A closed sheet forgets its composer, menu, strip position and viewer.
  useEffect(() => {
    if (open) return;
    setCommenting(false);
    setMenuOpen(false);
    setActive(0);
    setViewer(null);
  }, [open]);

  const subject = postSubject(post.title);
  const targetDate =
    post.target_date !== null ? formatDueDate(post.target_date, workspaceZone) : '';
  const items = gallery.status === 'ready' ? gallery.items : [];

  // Post detail's decisions, the same hook: a landed move tells every live
  // card to refetch, and the card's new row replaces the pending stage.
  const decisions = usePostDecisions({
    postId: view.postId,
    stage: knownStage(post.stage),
    role: sideRole(side),
    enabled: open,
    workspaceId,
    brand,
    postTitle: post.title,
    creatorName: view.creatorName ?? null,
    mediaCount: post.mediaCount > 0 ? post.mediaCount : null,
    approveDay: targetDate,
    // No live comment list here: the hook reads the open count on the tap.
    openCount: null,
    reload: () => dispatchPostChanged(window, view.postId),
  });
  const stage = decisions.stage ?? post.stage;

  // Escape belongs to the viewer while it is open (it closes itself on Escape).
  const closeSheet = useCallback(() => {
    if (viewer === null) onClose();
  }, [viewer, onClose]);

  const openPost = (): void => {
    onClose();
    navigate(postHref(view.postId, post.number, workspaceKey));
  };

  const copyLink = (): void => {
    // The same in-app link Post detail's Copy link builds (/p/<key>-<n>).
    const link = buildPostLink(
      window.location.origin,
      postHref(view.postId, post.number, workspaceKey),
    );
    void copyText(link).then((ok) => {
      if (ok) toast.show({ title: 'Link copied' });
      else toast.show({ title: COPY_FAILED, tone: 'error' });
    });
  };

  const onSubmitPoints = async (
    points: CheckpointPoint[],
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (workspaceId === null) return { ok: false, error: friendlyCommentError('unknown') };
    const result = await runCreateCommentBatch(supabase, {
      workspaceId,
      postId: view.postId,
      points,
      traceId: newTrace(),
    });
    if (!result.ok) return { ok: false, error: friendlyCommentError(result.error.code) };
    onClose();
    toast.show({ title: commentToast() });
    return { ok: true };
  };

  const onStripScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    setActive(slideFromScroll(el.scrollLeft, el.clientWidth, items.length));
  };

  const menu = (
    <ActionMenu
      title="Post actions"
      open={menuOpen}
      onOpenChange={setMenuOpen}
      items={postSheetMenuItems({
        onOpenPost: openPost,
        onCopyLink: copyLink,
        moves: decisions.moveRows,
      })}
    />
  );
  // Laptop: the row at the right of the title, beside the ⋯; the approver's
  // note and a failed tap's error under the details. Phone: the row is the
  // sheet's bottom bar (its footer), with the note inline.
  const aside = (
    <>
      {isLaptop ? (
        <div data-header-decision="">
          <PostDecisionRow model={decisions.model} busy={decisions.busy} error={null} />
        </div>
      ) : null}
      {menu}
    </>
  );
  const phoneBar =
    !isLaptop && hasDecisionContent(decisions.model, decisions.error) ? (
      <PostDecisionBar
        placement="footer"
        model={decisions.model}
        busy={decisions.busy}
        error={decisions.error}
      />
    ) : null;
  const footer = commenting ? (
    <div data-sheet-actions="" className="w-full">
      <Button
        type="button"
        variant="secondary"
        onClick={() => setCommenting(false)}
        className="w-full"
      >
        Back
      </Button>
    </div>
  ) : (
    phoneBar
  );
  const canComment = side === 'client' && stage === 'review';

  return (
    <>
      <Sheet
        open={open}
        onClose={closeSheet}
        title={sheetTitle(post.format)}
        {...(footer !== null ? { footer } : {})}
      >
        <div data-post-sheet={view.postId} className="flex flex-col gap-4">
          {commenting ? (
            <div data-sheet-composer="" className="flex flex-col gap-3">
              <h3 className="text-lg font-semibold text-fg">Comment on {subject}</h3>
              <SlotComposer onSubmit={onSubmitPoints} canAttach={false} />
            </div>
          ) : (
            <>
              <PostSheetMedia
                gallery={gallery}
                mediaCount={post.mediaCount}
                platform={post.platform}
                format={post.format}
                active={active}
                cache={props.cache}
                presignEnabled={props.presignEnabled}
                onScroll={onStripScroll}
                onOpen={setViewer}
              />
              <PostSheetDetails
                view={view}
                timeZone={timeZone}
                workspaceZone={workspaceZone}
                brand={brand}
                stage={stage}
                aside={aside}
              />
              {isLaptop ? (
                <PostDecisionRow
                  model={null}
                  busy={decisions.busy}
                  error={decisions.error}
                  note={decisions.note}
                />
              ) : decisions.note !== null ? (
                <p className="text-base text-fg-2">{decisions.note}</p>
              ) : null}
              <PostSheetExtras
                onComment={canComment ? () => setCommenting(true) : undefined}
                onTalkAbout={
                  props.onTalkAbout !== undefined
                    ? () => {
                        props.onTalkAbout?.();
                        onClose();
                      }
                    : undefined
                }
                hint={agencyWaitingHint(side, post, timeZone)}
              />
            </>
          )}
        </div>
      </Sheet>
      {decisions.confirms}
      {open && viewer !== null && items.length > 0
        ? createPortal(
            <div
              data-post-sheet-viewer=""
              className="fixed inset-0 z-[60] flex flex-col items-center overflow-y-auto bg-overlay pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
            >
              {/* Centred when it fits; a very tall slide scrolls rather than crops.
                  The width cap keeps a 4:5 slide plus its bar inside a wide screen. */}
              <div className="my-auto w-full max-w-[calc((100dvh-6rem)*0.8)]">
                <PostLightbox
                  items={items}
                  index={Math.min(viewer, items.length - 1)}
                  presignEnabled={props.presignEnabled}
                  cache={props.cache}
                  deps={props.deps}
                  onIndexChange={setViewer}
                  onClose={() => setViewer(null)}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
