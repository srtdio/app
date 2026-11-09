// The Plan tab's Bank (the idea bank: concepts outside any plan), on phone and
// laptop alike: the Bank chip's list under the page's toolbar, one ui/ListCard
// per idea in LIST_CARD_GRID (the laptop side panel, its Expand table and the
// drag onto the retired calendar are gone, 7 Nov 2026). One data hook
// (use-bank-data.ts). A card: the idea's picture in bankThumbOf's order (its
// first picture, else its first link's picture asked once the card is in view
// through previewClient, else the file glyph, else the idea icon), its title,
// its text (stripFormat) as the preview, then when it was added (formatAdded:
// "10:27 AM" today, else "2 Nov") and its first bucket as the one tag.
// A card taps open its idea (/plan/bank?item=). No ⋮: a long-press (phone)
// or right-click / Shift-click / Cmd-click (laptop) enters select mode with
// the idea ticked (ListCard `select`), and the chip row's Select starts it
// with nothing ticked (the page's useBankSelect); a tap then toggles.
// The bottom select bar (BankSelectBar on ui/SelectBar) holds "N selected"
// and every old menu row: Open, Plan it, Send to chat (the chat picker, then
// chat_plan_item_share; IdeaShareFlow) for one idea; Show to client or Hide
// from client, Star or Unstar, Archive or Unarchive, Delete last for any
// count; All ticks every loaded idea. Plan it is usePlanIt (shared with a bank
// idea's item screen). Writes go through the bank procs only and are
// optimistic over the kept page; Delete, Archive, Hide and every bulk write
// sit behind the Undo strip first. A client reads only, with no select mode
// or Add idea. Tokens only. The Untouched for 90 days filter (the Filter and sort
// sheet) lists live ideas last active over 90 days ago and ends with "Archive
// all {n}" (n = the rows loaded; bulk bank_idea_set behind the Undo strip).
// Nothing in the Bank is ever counted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { stripFormat } from '@srtdio/comments';
import { Bone, BoxSkeleton } from '@/lib/motion';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { Thumbnail } from '@/components/media/Thumbnail';
import { CONTROL_IN_LINE, GUTTER } from '@/components/ui/layout';
import { Button } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import {
  LIST_CARD_GRID,
  ListCard,
  ListCardBox,
  type ListCardPicture,
  type ListCardSelect,
} from '@/components/ui/ListCard';
import { useInView } from '@/lib/use-in-view';
import { PREVIEW_ROOT_MARGIN, previewClient, type LinkPreview } from '@/lib/links/preview';
import { NoResults } from '@/components/ui/NoResults';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { Tag } from '@/components/ui/Tag';
import { ICON_SIZE, IconBank, IconFile, IconTrash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { IdeaShareFlow, type IdeaShareTarget } from '@/components/chat/IdeaShareFlow';
import type { BucketOption } from '@/lib/buckets';
import type { BankIdea, PlanRow } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-copy';
import { formatAdded } from '@/lib/time';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { supabase } from '@/lib/supabase';
import { PlanTabLoadMore } from './PlanTabList';
import {
  approverNames,
  archiveAllLabel,
  bankZeroCopy,
  filterPills,
  ideaBucketTag,
  moreFilesLabel,
  noPlanTitle,
  planAudienceLabel,
  planItChoice,
  planItError,
  plannedToast,
  needsSharedWarning,
  runLimited,
  sharedPlanWarning,
  showToClientWarning,
  withoutPill,
  type BankFilter,
  type FilterPill,
} from './bank-parts';
import { BankSelectBar } from './BankSelectBar';
import {
  makeWeekPlan,
  placeBankIdea,
  removeBankIdea,
  setBankFlags,
  unplanBankIdea,
  withFlags,
  type BankData,
} from './use-bank-data';
import type { BankSelection } from './use-bank-select';
import { getFillCount } from '@/lib/use-fill-count';

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/**
 * From bank's small tile (BankPickSheet, 44): first picture, else its first
 * link's picture, else a file glyph, else a plain grey box. The Bank's own rows
 * take ListCard's 40 squircle picture (bankCardPicture).
 */
export function BankThumb(props: { idea: BankIdea; size: 44 }): ReactElement {
  const box = 'h-11 w-11';
  const thumb = props.idea.thumb;
  if (thumb === null) return <EmptyThumb box={box} />;
  if (thumb.kind === 'link') {
    return <LinkThumb url={thumb.url} box={box} fileCount={props.idea.file_count} />;
  }
  return (
    <FilledThumb box={box} fileCount={props.idea.file_count}>
      {thumb.kind === 'image' ? (
        <Thumbnail
          assetVersionId={thumb.versionId}
          cache={sharedCardPresignCache()}
          presignEnabled={PRESIGN_ENABLED}
          fallback={{ kind: 'glyph' }}
          alt=""
        />
      ) : (
        <FileGlyph />
      )}
    </FilledThumb>
  );
}

function EmptyThumb(props: { box: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-bank-thumb="none"
      className={cn(
        props.box,
        'flex shrink-0 items-center justify-center rounded-lg bg-panel-2 text-fg-3',
      )}
    >
      <IconBank size={ICON_SIZE.inline} />
    </span>
  );
}

function FileGlyph(): ReactElement {
  return (
    <span className="flex h-full w-full items-center justify-center text-fg-2">
      <IconFile size={ICON_SIZE.control} />
    </span>
  );
}

/** The lit-media tile with the "+N" more-files badge. */
function FilledThumb(props: { box: string; fileCount: number; children: ReactNode }): ReactElement {
  const more = moreFilesLabel(props.fileCount);
  return (
    <span
      data-bank-thumb=""
      className={cn(props.box, 'relative shrink-0 overflow-hidden rounded-lg bg-panel-2 lit-media')}
    >
      {props.children}
      {more !== null ? (
        <span
          data-bank-thumb-more=""
          className="lit-badge absolute bottom-0.5 right-0.5 rounded-sm bg-panel px-1 font-mono text-xs tabular-nums text-fg"
        >
          {more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The picture of the idea's first link: asked once the row is in view (the
 * chat cards' preview client and Worker cache, never before first paint), the
 * cached og:image through /image. No picture, or one that fails: the file
 * glyph when the idea holds files, else the dashed box. Never a per-row read
 * for ideas off screen.
 */
function LinkThumb(props: { url: string; box: string; fileCount: number }): ReactElement {
  const client = previewClient();
  const { ref, inView } = useInView<HTMLSpanElement>(PREVIEW_ROOT_MARGIN);
  const [preview, setPreview] = useState<LinkPreview | null>(() => client.peek(props.url));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (preview !== null || !inView) return;
    const controller = new AbortController();
    client.request(props.url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, inView, preview, props.url]);
  const src = preview?.type === 'full' && !failed ? client.imageUrl(props.url) : null;
  const settled = preview !== null && (preview.type !== 'full' || failed);
  if (settled && props.fileCount === 0) {
    return (
      <span ref={ref} className="contents">
        <EmptyThumb box={props.box} />
      </span>
    );
  }
  return (
    <span ref={ref} data-bank-thumb-link="" className="contents">
      <FilledThumb box={props.box} fileCount={props.fileCount}>
        {src !== null ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : settled ? (
          <FileGlyph />
        ) : (
          <Bone lit="lit-media" as="span" className="absolute inset-0" />
        )}
      </FilledThumb>
    </span>
  );
}

/** ListCard's icon box drawn inside an image slot (a link with no picture). */
function PictureIcon(props: { icon: typeof IconBank }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2"
    >
      <props.icon size={ICON_SIZE.control} />
    </span>
  );
}

/**
 * A card's link picture: asked once the card is in view (the chat cards'
 * preview client and Worker cache, never before first paint), the cached
 * og:image through /image. No picture, or one that fails: the file glyph when
 * the idea holds files, else the idea icon. Never a per-card read for ideas
 * off screen.
 */
function BankLinkPicture(props: { url: string; fileCount: number }): ReactElement {
  const client = previewClient();
  const { ref, inView } = useInView<HTMLSpanElement>(PREVIEW_ROOT_MARGIN);
  const [preview, setPreview] = useState<LinkPreview | null>(() => client.peek(props.url));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (preview !== null || !inView) return;
    const controller = new AbortController();
    client.request(props.url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, inView, preview, props.url]);
  const src = preview?.type === 'full' && !failed ? client.imageUrl(props.url) : null;
  const settled = preview !== null && (preview.type !== 'full' || failed);
  return (
    <span ref={ref} data-bank-thumb-link="" className="relative flex h-full w-full">
      {src !== null ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : settled ? (
        <PictureIcon icon={props.fileCount > 0 ? IconFile : IconBank} />
      ) : (
        <Bone lit="flat" as="span" className="absolute inset-0" />
      )}
    </span>
  );
}

/**
 * An idea card's picture in bankThumbOf's order: its first picture, else its
 * first link's picture (BankLinkPicture), else the file glyph, else the idea
 * icon. Render only; the link read waits for the card to be in view.
 */
export function bankCardPicture(idea: BankIdea): ListCardPicture {
  const thumb = idea.thumb;
  if (thumb === null) return { kind: 'icon', icon: IconBank };
  if (thumb.kind === 'file') return { kind: 'icon', icon: IconFile };
  if (thumb.kind === 'link') {
    return {
      kind: 'image',
      node: <BankLinkPicture url={thumb.url} fileCount={idea.file_count} />,
    };
  }
  return {
    kind: 'image',
    node: (
      <Thumbnail
        assetVersionId={thumb.versionId}
        cache={sharedCardPresignCache()}
        presignEnabled={PRESIGN_ENABLED}
        aspect="square"
        fallback={{ kind: 'glyph' }}
        fallbackTile={<PictureIcon icon={IconBank} />}
        alt=""
      />
    ),
  };
}

/** The applied filter line: small pills each removed by a bin (no X), then Clear. Nothing when nothing is applied. */
export function BankFilterLine(props: {
  filter: BankFilter;
  buckets: readonly BucketOption[];
  onFilter: (next: BankFilter) => void;
  onClear: () => void;
}): ReactElement | null {
  const pills = filterPills(props.filter, props.buckets);
  if (pills.length === 0) return null;
  return (
    <div
      data-bank-filter-line=""
      className={cn('flex min-w-0 flex-wrap items-center gap-2 pb-1 pt-1', GUTTER)}
    >
      <span className="text-sm text-fg-3">Showing</span>
      <span aria-hidden="true" className="text-sm text-fg-3">
        ·
      </span>
      {pills.map((pill: FilterPill) => (
        <span
          key={pill.key}
          data-bank-filter-pill={pill.key}
          className="lit-badge inline-flex h-6 items-center gap-1 rounded-sm border border-border-strong bg-panel px-1 text-sm text-fg"
        >
          <span className="pl-1">{pill.label}</span>
          <IconButton
            label={`Remove ${pill.label}`}
            className={CONTROL_IN_LINE}
            onClick={() => props.onFilter(withoutPill(props.filter, pill.key))}
          >
            <IconTrash size={ICON_SIZE.inline} />
          </IconButton>
        </span>
      ))}
      <Button variant="link" type="button" data-bank-filter-clear="" onClick={props.onClear}>
        Clear
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardProps {
  idea: BankIdea;
  buckets: readonly BucketOption[];
  now: Date;
  /** Select mode (creators only); absent: long-press and right-click do nothing. */
  select: ListCardSelect | undefined;
  onOpen: () => void;
}

/**
 * One idea on ui/ListCard: picture, title and when it was added (formatAdded),
 * then its text as the preview and its first bucket as the one tag. Tap opens;
 * with `select`, long-press / right-click ticks it and, while selecting, a tap
 * toggles (ListCard wires both).
 */
function BankCard(props: CardProps): ReactElement {
  const { idea } = props;
  const thumb = idea.thumb;
  return (
    <ListCard
      surface={{ 'data-bank-row': idea.id }}
      select={props.select}
      onPress={props.onOpen}
      press={{ 'data-bank-open': idea.id }}
      picture={bankCardPicture(idea)}
      pictureHooks={{ 'data-bank-thumb': thumb === null ? 'none' : thumb.kind }}
      title={idea.title ?? ''}
      preview={stripFormat(idea.description ?? '')}
      time={formatAdded(idea.created_at, props.now)}
      timeHooks={{ 'data-bank-added': '' }}
      tag={ideaBucketTag(idea, props.buckets)}
      tagHooks={{ 'data-bank-bucket-tag': '' }}
    />
  );
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export interface BankSurfaceProps {
  data: BankData;
  filter: BankFilter;
  onFilter: (next: BankFilter) => void;
  buckets: readonly BucketOption[];
  canWrite: boolean;
  workspaceId: string;
  today: string;
  /** The page's one list clock (useMinuteClock): the cards' added day (formatAdded). */
  now: Date;
  /** The open plans for Plan it: one read on the tap. */
  getPlans: () => Promise<
    { ok: true; data: PlanRow[] } | { ok: false; error: { message: string } }
  >;
  onOpenIdea: (id: string) => void;
  /** Bumped by the page on a chip change: select mode ends. */
  epoch: string;
  /** The page's select mode (useBankSelect), shared with the chip row's Select. */
  selection: BankSelection;
}

/** What Plan it is showing. */
export type PlanItStep =
  | { kind: 'date'; idea: BankIdea; day: string }
  | { kind: 'none'; idea: BankIdea; day: string }
  | { kind: 'several'; idea: BankIdea; day: string; plans: PlanRow[] }
  | { kind: 'shared'; idea: BankIdea; day: string; plan: PlanRow };

export function BankSurface(props: BankSurfaceProps): ReactElement {
  const { data, filter, canWrite, now, selection } = props;
  const showToast = useToast().show;
  const undoable = useUndoableAction();
  const [showAsk, setShowAsk] = useState<readonly BankIdea[] | null>(null);
  const [sendIdea, setSendIdea] = useState<IdeaShareTarget | null>(null);
  const ideas = data.ideas;

  const leaveSelect = selection.clear;
  // A chip change (or a filter change) leaves select mode.
  const filterKey = `${filter.sort}:${filter.bucketId ?? ''}:${String(filter.archived)}:${String(filter.review)}`;
  useEffect(() => leaveSelect(), [props.epoch, filterKey, leaveSelect]);

  const replaceIdea = useCallback(
    (next: BankIdea) => data.patch((list) => list.map((i) => (i.id === next.id ? next : i))),
    [data],
  );
  const dropIdeas = useCallback(
    (ids: ReadonlySet<string>) => data.patch((list) => list.filter((i) => !ids.has(i.id))),
    [data],
  );

  // Star and Show to client land at once (each idea patched first, the
  // bank_idea_set writes BANK_BULK_LIMIT at a time, a failed one put back with
  // one error toast); Archive, Hide and Delete wait behind Undo.
  const flagNow = (
    list: readonly BankIdea[],
    change: { starred: boolean } | { show: true },
    action: string,
  ): void => {
    if (list.length === 0) return;
    const at = new Date().toISOString();
    for (const idea of list) replaceIdea(withFlags(idea, change, at));
    let failure: unknown = null;
    void runLimited(
      list.map(
        (idea) => () =>
          setBankFlags(supabase, idea, change).catch((error: unknown) => {
            replaceIdea(idea);
            failure ??= error;
          }),
      ),
    ).then(() => {
      if (failure !== null) showToast({ title: errorText(action, failure), tone: 'error' });
    });
  };
  const starMany = (list: readonly BankIdea[], on: boolean): void =>
    flagNow(list, { starred: on }, on ? 'star' : 'unstar');
  const showToClient = (list: readonly BankIdea[]): void =>
    flagNow(list, { show: true }, 'show it to the client');
  const hideMany = (list: readonly BankIdea[]): void => {
    if (list.length === 0) return;
    const at = new Date().toISOString();
    for (const idea of list) replaceIdea(withFlags(idea, { show: false }, at));
    selection.clear();
    undoable.run({
      label: list.length === 1 ? 'Idea hidden' : `${list.length} ideas hidden`,
      commit: () =>
        runLimited(list.map((idea) => () => setBankFlags(supabase, idea, { show: false }))).then(
          () => undefined,
        ),
      revert: () => {
        for (const idea of list) replaceIdea(idea);
      },
    });
  };
  const archiveMany = (list: readonly BankIdea[], on: boolean): void => {
    if (list.length === 0) return;
    const ids = new Set(list.map((i) => i.id));
    // Archived ideas leave the live list (and live ones leave the archived list).
    dropIdeas(ids);
    leaveSelect();
    undoable.run({
      label:
        list.length === 1
          ? on
            ? 'Idea archived'
            : 'Idea restored'
          : `${list.length} ideas ${on ? 'archived' : 'restored'}`,
      commit: async () => {
        await runLimited(list.map((idea) => () => setBankFlags(supabase, idea, { archived: on })));
        data.reload();
      },
      revert: () =>
        data.patch((cur) => [...cur, ...list.filter((i) => !cur.some((c) => c.id === i.id))]),
    });
  };
  const deleteMany = (list: readonly BankIdea[]): void => {
    if (list.length === 0) return;
    const ids = new Set(list.map((i) => i.id));
    dropIdeas(ids);
    leaveSelect();
    undoable.run({
      label: list.length === 1 ? 'Idea deleted' : `${list.length} ideas deleted`,
      commit: () =>
        runLimited(list.map((idea) => () => removeBankIdea(supabase, idea.id))).then(
          () => undefined,
        ),
      revert: () =>
        data.patch((cur) => [...cur, ...list.filter((i) => !cur.some((c) => c.id === i.id))]),
    });
  };

  // Plan it (PR 816): the shared flow (usePlanIt); a placed idea leaves the list,
  // its Undo puts it back.
  const planIt = usePlanIt({
    workspaceId: props.workspaceId,
    today: props.today,
    getPlans: props.getPlans,
    onPlaced: (idea) => dropIdeas(new Set([idea.id])),
    onUnplaced: (idea) => data.patch((cur) => [idea, ...cur]),
  });

  const pickedIdeas = (ideas ?? []).filter((i) => selection.ids.has(i.id));

  // The select bar: every old ⋮ row. Open and the sheet flows leave select
  // mode first (its Back entry popped), so their own history steps sit clean.
  const selectBar =
    canWrite && selection.active ? (
      <BankSelectBar
        picked={pickedIdeas}
        onCancel={selection.clear}
        onAll={() => selection.setMany((ideas ?? []).map((i) => i.id))}
        onOpen={(idea) => selection.leaveThen(() => props.onOpenIdea(idea.id))}
        onPlanIt={(idea) => selection.leaveThen(() => planIt.start(idea))}
        onSend={(idea) =>
          selection.leaveThen(() =>
            setSendIdea({
              id: idea.id,
              title: idea.title ?? '',
              commentCount: idea.comment_count,
              plan: null,
            }),
          )
        }
        onShow={(list) => selection.leaveThen(() => setShowAsk(list.length > 0 ? list : null))}
        onHide={hideMany}
        onStar={(list, on) => {
          selection.clear();
          starMany(list, on);
        }}
        onArchive={archiveMany}
        onDelete={deleteMany}
      />
    ) : null;
  // Untouched for 90 days: Archive all {n} after the rows (n = the rows loaded).
  const archiveAll =
    canWrite && filter.review && ideas !== null && ideas.length > 0 ? (
      <div>
        <Button type="button" data-bank-archive-all="" onClick={() => archiveMany(ideas, true)}>
          {archiveAllLabel(ideas.length)}
        </Button>
      </div>
    ) : null;

  let body: ReactElement;
  if (ideas === null) {
    body =
      data.load.status === 'failed' ? (
        <div className="py-6">
          <Button variant="ghost" type="button" onClick={data.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <BankBoxes />
      );
  } else if (ideas.length === 0) {
    const copy = bankZeroCopy(filter);
    body =
      filter.bucketId !== null || filter.review ? (
        <div data-bank-zero="">
          <NoResults
            filtersActive
            onClear={() => props.onFilter({ ...filter, bucketId: null, review: false })}
          />
          <p className="sr-only">{copy}</p>
        </div>
      ) : (
        <div data-bank-zero="">
          <EmptyState icon={<IconBank size={ICON_SIZE.tray} />} title={copy} />
        </div>
      );
  } else {
    body = (
      <div data-bank-list="" className={LIST_CARD_GRID}>
        {ideas.map((idea) => (
          <BankCard
            key={idea.id}
            idea={idea}
            buckets={props.buckets}
            now={now}
            select={canWrite ? selection.selectFor(idea.id) : undefined}
            onOpen={() => props.onOpenIdea(idea.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-bank="list" className="flex flex-col gap-2 pb-8 pt-2">
      <div className={cn('flex flex-col gap-3', GUTTER)}>
        {body}
        {data.more !== null ? <PlanTabLoadMore more={data.more} /> : null}
        {archiveAll}
      </div>
      {selectBar}
      {canWrite ? (
        <>
          {planIt.sheets}
          <IdeaShareFlow
            idea={sendIdea}
            onClose={() => setSendIdea(null)}
            onShown={() => {
              const shown =
                sendIdea !== null ? ideas?.find((i) => i.id === sendIdea.id) : undefined;
              if (shown !== undefined) {
                replaceIdea(withFlags(shown, { show: true }, new Date().toISOString()));
              }
            }}
          />
          <BankShowSheet
            idea={showAsk?.[0] ?? null}
            ideas={showAsk ?? undefined}
            workspaceId={props.workspaceId}
            onClose={() => setShowAsk(null)}
            onShow={() => {
              const list = showAsk ?? [];
              setShowAsk(null);
              showToClient(list);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/** Loading boxes: ListCard's own box in the grid (only while nothing is held). */
function BankBoxes(): ReactElement {
  return (
    <BoxSkeleton lit="flat" label="Loading ideas" data-bank-loading="" className={LIST_CARD_GRID}>
      {Array.from({ length: getFillCount() }, (_unused, k) => (
        <ListCardBox key={k} />
      ))}
    </BoxSkeleton>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Plan it as a flow: open it for an idea, or run it for a picked day; its sheets. */
export interface PlanItFlow {
  /** Open the day sheet for this idea. */
  start: (idea: BankIdea) => void;
  /** Run Plan it for a known day (the day sheet's pick): one plan, none, several, shared. */
  runFor: (idea: BankIdea, day: string) => Promise<void>;
  /** The PR 816 sheets (date, no plan, pick a plan, shared warning); render once. */
  sheets: ReactElement;
}

/**
 * PR 816's Plan it, shared by the Bank (BankSurface) and a bank idea's item
 * screen: the open plans read on the tap (getPlans), one plan places at once,
 * none offers Make plan, several a picker, and a shared plan asks first when
 * the idea is team only; a past day says so (PAST_DAY_ERROR). A placed idea
 * toasts "Planned in {plan}, {date}" with Undo (plan_item_to_bank).
 */
export function usePlanIt(input: {
  workspaceId: string;
  today: string;
  getPlans: BankSurfaceProps['getPlans'];
  onPlaced: (idea: BankIdea, plan: PlanRow, day: string) => void;
  onUnplaced: (idea: BankIdea) => void;
}): PlanItFlow {
  const showToast = useToast().show;
  const [step, setStep] = useState<PlanItStep | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  const place = useCallback(
    async (idea: BankIdea, plan: PlanRow, day: string): Promise<void> => {
      setBusy(true);
      const res = await placeBankIdea(supabase, idea.id, plan.id, day);
      setBusy(false);
      setStep(null);
      if (!res.ok) {
        showToast({ title: planItError(res.error.message), tone: 'error' });
        return;
      }
      inputRef.current.onPlaced(idea, plan, day);
      showToast({
        title: plannedToast(plan.title, day),
        kind: 'undo',
        action: {
          label: 'Undo',
          onPress: () => {
            void unplanBankIdea(supabase, idea.id, idea).then((back) => {
              if (back.ok) inputRef.current.onUnplaced(idea);
              else showToast({ title: errorText('undo', back.error.message), tone: 'error' });
            });
          },
        },
      });
    },
    [showToast],
  );
  const choosePlan = useCallback(
    (idea: BankIdea, plan: PlanRow, day: string): void => {
      if (needsSharedWarning(plan, idea)) setStep({ kind: 'shared', idea, day, plan });
      else void place(idea, plan, day);
    },
    [place],
  );
  const runFor = useCallback(
    async (idea: BankIdea, day: string): Promise<void> => {
      const { getPlans, today } = inputRef.current;
      const plans = await getPlans();
      if (!plans.ok) {
        setStep(null);
        showToast({ title: planItError(plans.error.message), tone: 'error' });
        return;
      }
      const choice = planItChoice(plans.data, day, today);
      switch (choice.kind) {
        case 'past':
          setStep(null);
          showToast({ title: planItError('past_date'), tone: 'error' });
          return;
        case 'one':
          choosePlan(idea, choice.plan, day);
          return;
        case 'none':
          setStep({ kind: 'none', idea, day });
          return;
        default:
          setStep({ kind: 'several', idea, day, plans: choice.plans });
      }
    },
    [showToast, choosePlan],
  );
  const makePlan = async (idea: BankIdea, day: string): Promise<void> => {
    setBusy(true);
    const made = await makeWeekPlan(supabase, inputRef.current.workspaceId, day);
    setBusy(false);
    if (!made.ok) {
      setStep(null);
      showToast({ title: errorText('make the plan', made.error.message), tone: 'error' });
      return;
    }
    void place(idea, made.data, day);
  };
  const start = useCallback((idea: BankIdea) => setStep({ kind: 'date', idea, day: '' }), []);
  const sheets = (
    <BankPlanItSheets
      step={step}
      busy={busy}
      today={input.today}
      onClose={() => setStep(null)}
      onDay={(idea, day) => void runFor(idea, day)}
      onMakePlan={(idea, day) => void makePlan(idea, day)}
      onPickPlan={(idea, plan, day) => choosePlan(idea, plan, day)}
      onConfirmShared={(idea, plan, day) => void place(idea, plan, day)}
    />
  );
  return { start, runFor, sheets };
}

export function BankPlanItSheets(props: {
  step: PlanItStep | null;
  busy: boolean;
  today: string;
  onClose: () => void;
  onDay: (idea: BankIdea, day: string) => void;
  onMakePlan: (idea: BankIdea, day: string) => void;
  onPickPlan: (idea: BankIdea, plan: PlanRow, day: string) => void;
  onConfirmShared: (idea: BankIdea, plan: PlanRow, day: string) => void;
}): ReactElement {
  const step = props.step;
  const [day, setDay] = useState('');
  useEffect(() => {
    if (step?.kind === 'date') setDay(step.day);
  }, [step]);
  return (
    <>
      <Sheet
        open={step?.kind === 'date'}
        onClose={props.onClose}
        title="Plan it"
        busy={props.busy}
        footer={
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="ghost" type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-plan-it-go=""
              busy={props.busy}
              disabled={day === '' || day < props.today}
              onClick={() => {
                if (step !== null && day !== '') props.onDay(step.idea, day);
              }}
            >
              Plan it
            </Button>
          </div>
        }
      >
        <div data-bank-plan-it="" className="flex flex-col gap-2 p-4">
          <p className="text-base text-fg">{step?.idea.title ?? ''}</p>
          <DatePicker
            value={day}
            onChange={setDay}
            disablePast
            label="Day"
            placeholder="Pick a day"
          />
        </div>
      </Sheet>
      <Sheet
        open={step?.kind === 'none'}
        onClose={props.onClose}
        title={step?.kind === 'none' ? noPlanTitle(step.day) : ''}
        busy={props.busy}
        footer={
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="ghost" type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-make-plan=""
              busy={props.busy}
              onClick={() => {
                if (step?.kind === 'none') props.onMakePlan(step.idea, step.day);
              }}
            >
              Make plan
            </Button>
          </div>
        }
      >
        <p className="p-4 text-base text-fg-2">
          Make a Draft plan for that week and put the idea in it.
        </p>
      </Sheet>
      <Sheet open={step?.kind === 'several'} onClose={props.onClose} title="Pick a plan">
        <div data-bank-plan-picker="" className="-mx-4 flex flex-col">
          {step?.kind === 'several'
            ? step.plans.map((plan) => (
                <PressableRow
                  key={plan.id}
                  flat
                  type="button"
                  data-bank-plan-option={plan.id}
                  onClick={() => props.onPickPlan(step.idea, plan, step.day)}
                  className="flex items-center gap-2 border-b border-border px-4 py-3"
                >
                  <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">
                    {plan.title}
                  </span>
                  <Tag
                    label={planAudienceLabel(plan)}
                    tone={planAudienceLabel(plan) === 'Draft' ? 'warn' : 'neutral'}
                  />
                </PressableRow>
              ))
            : null}
        </div>
      </Sheet>
      <Sheet
        open={step?.kind === 'shared'}
        onClose={props.onClose}
        title="Put it in the plan?"
        busy={props.busy}
        footer={
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="ghost" type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-shared-go=""
              busy={props.busy}
              onClick={() => {
                if (step?.kind === 'shared') props.onConfirmShared(step.idea, step.plan, step.day);
              }}
            >
              Put it in the plan
            </Button>
          </div>
        }
      >
        <p data-bank-shared-warning="" className="p-4 text-base text-fg">
          {step?.kind === 'shared'
            ? sharedPlanWarning(step.plan.title, step.idea.comment_count)
            : ''}
        </p>
      </Sheet>
    </>
  );
}

/** Show to client: the warning naming the workspace's approvers (never a ConfirmDialog). */
export function BankShowSheet(props: {
  idea: BankIdea | null;
  /** Every idea being shown (the Bank's select bar); absent: just `idea`. */
  ideas?: readonly BankIdea[] | undefined;
  workspaceId: string;
  onClose: () => void;
  onShow: (idea: BankIdea) => void;
}): ReactElement {
  const idea = props.idea;
  return (
    <Sheet
      open={idea !== null}
      onClose={props.onClose}
      title="Show to client"
      footer={
        <div className="grid w-full grid-cols-2 gap-2">
          <Button variant="ghost" type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            data-bank-show-go=""
            onClick={() => {
              if (idea !== null) props.onShow(idea);
            }}
          >
            Show to client
          </Button>
        </div>
      }
    >
      {idea !== null ? (
        <ShowWarning ideas={props.ideas ?? [idea]} workspaceId={props.workspaceId} />
      ) : null}
    </Sheet>
  );
}

/** The warning line; the members read runs only while the sheet is open. */
function ShowWarning(props: { ideas: readonly BankIdea[]; workspaceId: string }): ReactElement {
  const members = useWorkspaceMembers(props.workspaceId);
  const names = useMemo(
    () => approverNames(members.rows, members.profiles),
    [members.rows, members.profiles],
  );
  return (
    <p data-bank-show-warning="" className="p-4 text-base text-fg">
      {showToClientWarning(
        names,
        props.ideas.reduce((sum, idea) => sum + idea.comment_count, 0),
        props.ideas.length,
      )}
    </p>
  );
}
