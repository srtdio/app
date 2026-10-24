// The post sheet a shared post card opens in chat: every slide of the post, the
// title and its key facts, and the one action the viewer is waited on for.
// Approvers in review approve or reject (each after a confirm step) or leave
// checkpoint points through the same SlotComposer the post page uses; an
// approved post can still be rejected. A reject's optional reason posts as a
// comment through the post page's comment write. Agency in review may approve
// on the client's behalf (same confirm, plus one on-behalf line); agency in draft
// sends for review (also confirmed). The post itself is never refetched: the card's PR 2
// row carries every value shown. Only the gallery is read, once per open, and
// the strip paints a same-height skeleton until it lands, so the sheet never
// shortens after first paint. A successful stage change announces
// sorted:post-changed so every live card refetches, then closes and toasts.
// Colours are design tokens only, so light and dark match.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { Textarea } from '@/components/ui/Textarea';
import { IconPlay } from '@/components/ui/icons';
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
  actionLabel,
  approvedPillLabel,
  commentToast,
  confirmCopy,
  detailRows,
  friendlyCommentError,
  isVideoItem,
  postSubject,
  REJECT_REASON_HELPER,
  REJECT_REASON_LABEL,
  reelLabel,
  runStageChange,
  sheetActions,
  sheetTitle,
  stageTagLabel,
  stripCounter,
  type ConfirmKind,
  type SheetAction,
  type SheetActionSet,
} from '@/components/chat/post-sheet';
import { onBehalfConfirmLine } from '@/components/pages/pcs/stage-actions';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import { formatShortDate } from '@/lib/chat/time-format';
import { actsOnBehalfOfClient, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { getPostGallery, type GalleryItem } from '../../../packages/posts/src/reads';
import { stageTransition } from '../../../packages/posts/src/stage-machine';

type PostView = Extract<SharedPostView, { kind: 'post' }>;

/** The gallery for one open: loading until the single read settles. */
export type SheetGallery = { status: 'loading' } | { status: 'ready'; items: GalleryItem[] };

/** What the action area shows: the actions, a confirm block, or the composer. */
export type SheetMode =
  | { kind: 'actions' }
  | { kind: 'confirm'; confirm: ConfirmKind }
  | { kind: 'comment' };

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
export function stripFrame(
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
  'pointer-events-none inline-flex h-6 items-center gap-1 rounded-md bg-panel px-2 text-legacy-xs font-medium text-fg';

/** The sheet's talk-about label. */
export function talkAboutLabel(): string {
  return 'Talk about this post';
}

/**
 * The emphasis each action takes: Approve is the success fill, Reject the
 * secondary with bad ink, the first other action is filled, the rest quieter.
 * Pure.
 */
export function actionButton(
  action: SheetAction,
  first: boolean,
): { variant: ButtonVariant; className: string } {
  if (action === 'approve') return { variant: 'success', className: 'w-full' };
  if (action === 'reject') return { variant: 'secondary', className: 'w-full text-bad' };
  if (action === 'open_post') return { variant: 'link', className: 'w-full' };
  if (first) return { variant: 'primary', className: 'w-full' };
  return action === 'comment'
    ? { variant: 'secondary', className: 'w-full' }
    : { variant: 'link', className: 'w-full' };
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
    <button
      ref={thumb.ref}
      type="button"
      data-strip-slide=""
      aria-label={`Open slide ${index + 1}`}
      onClick={() => props.onOpen(index)}
      className={cn(
        'relative h-full w-full shrink-0 snap-center overflow-hidden',
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
            <IconPlay size={20} />
          </span>
        </span>
      ) : null}
    </button>
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

/** The full title, the Stage tag, then the key/value rows. Presentational. */
export function PostSheetDetails(props: {
  view: PostView;
  timeZone: string;
  /** The workspace's brand name for "on behalf of <Brand>"; null falls back. */
  brand?: string | null;
}): ReactElement {
  const { post, approverName, approverRole } = props.view;
  const rows = detailRows(post, approverName, props.timeZone, approverRole ?? null, props.brand);
  return (
    <div className="flex flex-col gap-3">
      <h3 data-sheet-title="" className="text-[17px] font-semibold leading-6 text-fg">
        {post.title}
      </h3>
      <dl className="flex flex-col text-legacy-sm">
        <div className="flex min-h-[36px] items-center justify-between gap-3 border-b border-border">
          <dt className="text-fg-3">Stage</dt>
          <dd>
            <Tag
              label={stageTagLabel(post.stage)}
              {...(isTagDot(post.stage) ? { dot: post.stage } : {})}
            />
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
// Actions

export interface PostSheetActionsProps {
  set: SheetActionSet;
  mode: SheetMode;
  /** How the confirm names the post (postSubject of its title). */
  subject: string;
  approverName: string | null;
  /** The approver's role: an agency-side approver's pill adds "on behalf of client". */
  approverRole?: string | null;
  /** Agency side: the approve confirm adds the on-behalf-of-client line. */
  onBehalf?: boolean;
  /** The workspace's brand name; null falls back to "the approvers". */
  brand?: string | null;
  mediaCount: number;
  targetDate: string;
  /** The creator's name for the reject confirm; null or absent reads "The creator". */
  creatorName?: string | null;
  /** The reject confirm's typed reason. */
  reason?: string;
  onReasonChange?: (reason: string) => void;
  busy: boolean;
  error: string | null;
  onAction: (action: SheetAction) => void;
  onConfirm: () => void;
  onBack: () => void;
  /** Bring the post into the chat's conversation; absent hides the button. */
  onTalkAbout?: (() => void) | undefined;
}

/**
 * The bottom action area. Actions mode lists the set's buttons, the approved
 * pill and the hint; confirm mode swaps them for the question, its consequence,
 * Back and the confirm button; comment mode leaves only Back (the composer owns
 * its own send). Presentational; safe-area padding keeps it above the home bar.
 */
export function PostSheetActions(props: PostSheetActionsProps): ReactElement {
  const { set, mode } = props;
  const brand = props.brand ?? null;
  const error =
    props.error !== null ? (
      <p role="alert" data-sheet-error="" className="text-legacy-sm text-bad">
        {props.error}
      </p>
    ) : null;
  let content: ReactElement;
  if (mode.kind === 'confirm' && mode.confirm === 'reject') {
    const copy = confirmCopy('reject', {
      subject: props.subject,
      mediaCount: props.mediaCount,
      targetDate: props.targetDate,
      creatorName: props.creatorName ?? null,
    });
    content = (
      <div data-sheet-confirm="reject" className="flex flex-col gap-2">
        <p className="text-legacy-sm font-medium text-fg">{copy.question}</p>
        <p className="text-legacy-sm text-fg-2">{copy.detail}</p>
        <label className="mt-1 flex flex-col gap-1.5">
          <span className="text-legacy-sm text-fg-2">{REJECT_REASON_LABEL}</span>
          <Textarea
            data-sheet-reason=""
            aria-describedby="post-sheet-reason-helper"
            value={props.reason ?? ''}
            disabled={props.busy}
            onChange={(event) => props.onReasonChange?.(event.target.value)}
          />
        </label>
        <p id="post-sheet-reason-helper" className="text-legacy-xs text-fg-3">
          {REJECT_REASON_HELPER}
        </p>
        {error}
        <div className="mt-1 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={props.busy}
            onClick={props.onBack}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-sheet-reject-confirm=""
            disabled={props.busy}
            onClick={props.onConfirm}
            className="flex-1 text-bad"
          >
            {copy.confirmLabel}
          </Button>
        </div>
      </div>
    );
  } else if (mode.kind === 'confirm') {
    const copy = confirmCopy(mode.confirm, {
      subject: props.subject,
      mediaCount: props.mediaCount,
      targetDate: props.targetDate,
    });
    content = (
      <div data-sheet-confirm={mode.confirm} className="flex flex-col gap-2">
        <p className="text-legacy-sm font-medium text-fg">{copy.question}</p>
        <p className="text-legacy-sm text-fg-2">{copy.detail}</p>
        {mode.confirm === 'approve' && props.onBehalf === true ? (
          <p data-sheet-on-behalf="" className="text-legacy-sm text-fg-2">
            {onBehalfConfirmLine(brand)}
          </p>
        ) : null}
        {error}
        <div className="mt-1 flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={props.busy}
            onClick={props.onBack}
            className="flex-1"
          >
            Back
          </Button>
          <Button
            type="button"
            variant={mode.confirm === 'approve' ? 'success' : 'primary'}
            disabled={props.busy}
            onClick={props.onConfirm}
            className="flex-1"
          >
            {copy.confirmLabel}
          </Button>
        </div>
      </div>
    );
  } else if (mode.kind === 'comment') {
    content = (
      <Button type="button" variant="secondary" onClick={props.onBack} className="w-full">
        Back
      </Button>
    );
  } else {
    content = (
      <div className="flex flex-col gap-2">
        {error}
        {set.approvedPill ? (
          <Button
            type="button"
            variant="ghost"
            disabled
            data-approved-pill=""
            className="w-full cursor-default bg-good-soft text-good disabled:opacity-100"
          >
            {approvedPillLabel(props.approverName, props.approverRole ?? null, brand)}
          </Button>
        ) : null}
        {set.actions.map((action, index) => {
          const look = actionButton(action, index === 0);
          return (
            <Button
              key={action}
              type="button"
              variant={look.variant}
              data-sheet-action={action}
              disabled={props.busy}
              onClick={() => props.onAction(action)}
              className={look.className}
            >
              {actionLabel(action)}
            </Button>
          );
        })}
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
        {set.hint !== null ? (
          <p data-sheet-hint="" className="text-center text-legacy-xs text-fg-3">
            {set.hint}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div data-sheet-actions="" className="w-full pb-[env(safe-area-inset-bottom)]">
      {content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stateful sheet

export interface PostSheetProps {
  open: boolean;
  onClose: () => void;
  view: PostView;
  side: ViewerSide;
  timeZone: string;
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
  const { workspaceId, workspaceName, workspaceKey } = useWorkspace();
  const brand = workspaceName ?? null;
  const gallery = useSheetGallery(open, view.postId);
  const [mode, setMode] = useState<SheetMode>({ kind: 'actions' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [active, setActive] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);

  // A closed sheet forgets its confirm, error, strip position and viewer.
  useEffect(() => {
    if (open) return;
    setMode({ kind: 'actions' });
    setBusy(false);
    setError(null);
    setReason('');
    setActive(0);
    setViewer(null);
  }, [open]);

  const subject = postSubject(post.title);
  const set = sheetActions(side, post, timeZone);
  const targetDate = post.target_date !== null ? formatShortDate(post.target_date, timeZone) : '';
  const items = gallery.status === 'ready' ? gallery.items : [];

  // Escape belongs to the viewer while it is open (it closes itself on Escape).
  const closeSheet = useCallback(() => {
    if (viewer === null) onClose();
  }, [viewer, onClose]);

  const openPost = (): void => {
    onClose();
    navigate(postHref(view.postId, post.number, workspaceKey));
  };

  const onAction = (action: SheetAction): void => {
    setError(null);
    switch (action) {
      case 'approve':
        setMode({ kind: 'confirm', confirm: 'approve' });
        return;
      case 'reject':
        setReason('');
        setMode({ kind: 'confirm', confirm: 'reject' });
        return;
      case 'send_review':
        setMode({ kind: 'confirm', confirm: 'send_review' });
        return;
      case 'comment':
        setMode({ kind: 'comment' });
        return;
      case 'open_post':
      case 'open_pipeline':
        openPost();
        return;
    }
  };

  const onConfirm = (): void => {
    if (mode.kind !== 'confirm' || busy) return;
    setBusy(true);
    setError(null);
    void runStageChange(
      {
        transition: (input) => stageTransition(supabase, input),
        target: window,
        toast: (title) => toast.show({ title }),
        close: onClose,
        postReason: async (body) => {
          if (workspaceId === null) return { ok: false };
          const result = await runCreateCommentBatch(supabase, {
            workspaceId,
            postId: view.postId,
            points: [{ body }],
            traceId: newTrace(),
          });
          return { ok: result.ok };
        },
      },
      { kind: mode.confirm, postId: view.postId, traceId: newTrace(), reason },
    ).then((message) => {
      setBusy(false);
      if (message !== null) setError(message);
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

  const commenting = mode.kind === 'comment';
  return (
    <>
      <Sheet
        open={open}
        onClose={closeSheet}
        title={sheetTitle(post.format)}
        footer={
          <PostSheetActions
            set={set}
            brand={brand}
            mode={mode}
            subject={subject}
            approverName={view.approverName}
            approverRole={view.approverRole ?? null}
            onBehalf={actsOnBehalfOfClient(side)}
            mediaCount={post.mediaCount}
            targetDate={targetDate}
            creatorName={view.creatorName ?? null}
            reason={reason}
            onReasonChange={setReason}
            busy={busy}
            error={error}
            onAction={onAction}
            onConfirm={onConfirm}
            onTalkAbout={
              props.onTalkAbout !== undefined
                ? () => {
                    props.onTalkAbout?.();
                    onClose();
                  }
                : undefined
            }
            onBack={() => {
              setError(null);
              setReason('');
              setMode({ kind: 'actions' });
            }}
          />
        }
      >
        <div data-post-sheet={view.postId} className="flex flex-col gap-4">
          {commenting ? (
            <div data-sheet-composer="" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold text-fg">Comment on {subject}</h3>
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
              <PostSheetDetails view={view} timeZone={timeZone} brand={brand} />
            </>
          )}
        </div>
      </Sheet>
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
