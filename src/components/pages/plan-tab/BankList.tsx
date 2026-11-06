// The Plan tab's Bank (the idea bank: concepts outside any plan). One
// surface in three layouts sharing one data hook (use-bank-data.ts):
// - phone: the Bank chip's list under the page's toolbar (rows in lit-card
//   cards, 56px thumbnail);
// - panel: the laptop ui/SidePanel beside the calendar (44px thumbnail,
//   rows draggable onto a month day, "Drag a card onto a day to plan it.");
// - table: Expand's full-width table in place of the calendar.
// A row taps open its idea (/plan/bank?item=); its ⋯ menu (ui/ActionMenu,
// right-click on laptop) holds Open, Select, Plan it, Show to client or Hide
// from client, Star or Unstar, Archive or Unarchive, Delete last. Long-press
// enters select mode (ui/Checkbox per row, the picked rows lit-selected; the
// select bar sits above the rows). Writes are optimistic over the kept page;
// Delete, Archive, Hide and every bulk write sit behind the Undo strip first.
// A client reads only, with no menu, select mode or Add idea. Tokens only;
// lit heights per docs/lighting.md (cards lit-card, sheets lit-overlay, the
// filter pills lit-badge, thumbnails lit-media). The Untouched for 90 days
// filter (the Filter and sort sheet) lists live ideas last active over 90
// days ago and ends with "Archive all {n}" (n = the rows loaded; bulk
// bank_idea_set behind the Undo strip). Nothing in the Bank is ever counted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactElement, ReactNode } from 'react';
import { Bone, BoxSkeleton } from '@/lib/motion';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { Thumbnail } from '@/components/media/Thumbnail';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { DatePicker } from '@/components/ui/DatePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { SidePanel } from '@/components/ui/SidePanel';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { NoResults } from '@/components/ui/NoResults';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { Tag } from '@/components/ui/Tag';
import {
  ICON_SIZE,
  IconArchive,
  IconBank,
  IconCalendar,
  IconCheckCircle,
  IconChevronLeft,
  IconEye,
  IconExpand,
  IconEyeOff,
  IconFile,
  IconStar,
  IconStarFilled,
  IconTrash,
  IconArrowUpRight,
  IconX,
} from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useLongPress } from '@/components/ui/useLongPress';
import type { BucketOption } from '@/lib/buckets';
import type { BankIdea, PlanRow } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-copy';
import { formatRelative } from '@/lib/time';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { useWorkspaceMembers } from '@/lib/workspace-members';
import { supabase } from '@/lib/supabase';
import { PlanTabLoadMore } from './PlanTabList';
import {
  BANK_DRAG_TYPE,
  CLIENT_CAN_SEE,
  TEAM_ONLY,
  approverNames,
  archiveAllLabel,
  bankZeroCopy,
  cameFromLabel,
  filterPills,
  ideaFilesLine,
  ideaFormatLine,
  ideaMetaLine,
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

export type BankLayout = 'phone' | 'panel' | 'table';

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** The idea's first file (lit-media), a dashed placeholder when none, "+N" when more. */
export function BankThumb(props: { idea: BankIdea; size: 56 | 44 }): ReactElement {
  const box = props.size === 56 ? 'h-14 w-14' : 'h-11 w-11';
  const more = moreFilesLabel(props.idea.file_count);
  const thumb = props.idea.thumb;
  if (thumb === null) {
    return (
      <span
        aria-hidden="true"
        data-bank-thumb="none"
        className={cn(
          box,
          'flex shrink-0 items-center justify-center rounded-lg border border-dashed border-border-strong bg-panel-2 text-fg-3 lit-well-soft',
        )}
      >
        <IconBank size={ICON_SIZE.inline} />
      </span>
    );
  }
  return (
    <span
      data-bank-thumb=""
      className={cn(box, 'relative shrink-0 overflow-hidden rounded-lg bg-panel-2 lit-media')}
    >
      {thumb.kind === 'image' ? (
        <Thumbnail
          assetVersionId={thumb.versionId}
          cache={sharedCardPresignCache()}
          presignEnabled={PRESIGN_ENABLED}
          fallback={{ kind: 'glyph' }}
          alt=""
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-fg-2">
          <IconFile size={ICON_SIZE.control} />
        </span>
      )}
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

/** The bucket Tags and the Client can see Tag of one idea. */
function IdeaTags(props: {
  idea: BankIdea;
  buckets: readonly BucketOption[];
}): ReactElement | null {
  const names = (props.idea.bucket_ids ?? []).flatMap((id) => {
    const b = props.buckets.find((x) => x.id === id);
    return b !== undefined ? [b] : [];
  });
  if (names.length === 0 && props.idea.show_to_client !== true) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {names.map((b) => (
        <Tag key={b.id} label={b.name} />
      ))}
      {props.idea.show_to_client === true ? <Tag label={CLIENT_CAN_SEE} tone="good" /> : null}
    </span>
  );
}

/** The applied filter line: small removable pills, then Clear. Nothing when nothing is applied. */
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
      className="flex min-w-0 flex-wrap items-center gap-1.5 px-4 pb-1 pt-1 md:px-0"
    >
      <span className="text-sm text-fg-3">Showing</span>
      <span aria-hidden="true" className="text-sm text-fg-3">
        ·
      </span>
      {pills.map((pill: FilterPill) => (
        <span
          key={pill.key}
          data-bank-filter-pill={pill.key}
          className="lit-badge inline-flex h-6 items-center gap-0.5 rounded-sm border border-border-strong bg-panel pl-2 text-sm text-fg"
        >
          {pill.label}
          <IconButton
            label={`Remove ${pill.label}`}
            className="-my-2.5"
            onClick={() => props.onFilter(withoutPill(props.filter, pill.key))}
          >
            <IconX size={ICON_SIZE.text} />
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
// Rows
// ---------------------------------------------------------------------------

interface RowProps {
  idea: BankIdea;
  layout: BankLayout;
  buckets: readonly BucketOption[];
  now: Date;
  canWrite: boolean;
  selecting: boolean;
  selected: boolean;
  menuItems: ActionMenuItem[];
  onOpen: () => void;
  onToggle: () => void;
  onHold: () => void;
}

/** One idea card: thumbnail, title (star first when starred), format, tags, meta, then ⋯. */
function BankRow(props: RowProps): ReactElement {
  const { idea } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const hold = useLongPress(() => props.onHold(), { ignoreMouse: true });
  const thumb = props.layout === 'phone' ? 56 : 44;
  const onDragStart = (event: ReactDragEvent<HTMLElement>): void => {
    event.dataTransfer.setData(BANK_DRAG_TYPE, idea.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div
      data-bank-row={idea.id}
      data-selected={props.selected ? 'true' : undefined}
      draggable={props.layout === 'panel' && props.canWrite && !props.selecting}
      onDragStart={props.layout === 'panel' ? onDragStart : undefined}
      onContextMenu={
        props.canWrite
          ? (event) => {
              event.preventDefault();
              hold.cancel();
              setMenuOpen(true);
            }
          : undefined
      }
      className={cn(
        'lit-card flex items-start gap-1 rounded-xl border bg-panel',
        props.selected && 'lit-selected',
      )}
    >
      {props.selecting ? (
        <label className="flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center self-center">
          <Checkbox
            checked={props.selected}
            onChange={props.onToggle}
            aria-label={`Select ${idea.title ?? 'idea'}`}
          />
        </label>
      ) : null}
      <PressableRow
        type="button"
        flat
        data-bank-open={idea.id}
        {...(props.canWrite ? hold.handlers : {})}
        onClick={() => {
          if (hold.consumeClickSuppression()) return;
          if (props.selecting) props.onToggle();
          else props.onOpen();
        }}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-3 py-3',
          props.selecting ? 'pl-0' : 'pl-3.5',
        )}
      >
        <BankThumb idea={idea} size={thumb} />
        <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <span className="flex min-w-0 items-center gap-1.5">
            {idea.starred_at != null ? (
              <span className="shrink-0 text-warn" aria-label="Starred">
                <IconStarFilled size={ICON_SIZE.inline} />
              </span>
            ) : null}
            <span className="truncate text-base font-medium text-fg">{idea.title ?? ''}</span>
          </span>
          <span className="truncate text-sm text-fg-2">{ideaFormatLine(idea)}</span>
          <IdeaTags idea={idea} buckets={props.buckets} />
          <span className="truncate text-sm text-fg-3">{ideaMetaLine(idea, props.now)}</span>
        </span>
      </PressableRow>
      {props.canWrite && !props.selecting ? (
        <span className="shrink-0 pr-1 pt-1.5">
          <ActionMenu
            title={idea.title ?? 'Idea'}
            items={props.menuItems}
            open={menuOpen}
            onOpenChange={setMenuOpen}
          />
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/** A drop from the calendar (laptop): plan this idea on this day. */
export interface BankDropRequest {
  ideaId: string;
  day: string;
  nonce: number;
}

export interface BankSurfaceProps {
  layout: BankLayout;
  data: BankData;
  filter: BankFilter;
  onFilter: (next: BankFilter) => void;
  buckets: readonly BucketOption[];
  canWrite: boolean;
  workspaceId: string;
  today: string;
  /** The open plans for Plan it: one read on the tap. */
  getPlans: () => Promise<
    { ok: true; data: PlanRow[] } | { ok: false; error: { message: string } }
  >;
  onOpenIdea: (id: string) => void;
  /** Bumped by the page on a chip change: select mode ends. */
  epoch: string;
  /** Above the rows (the panel's and the table's own toolbar). */
  toolbar?: ReactNode;
  /** The table's Calendar button. */
  onCollapse?: () => void;
  drop?: BankDropRequest | null;
}

/** What Plan it is showing. */
type PlanItStep =
  | { kind: 'date'; idea: BankIdea; day: string }
  | { kind: 'none'; idea: BankIdea; day: string }
  | { kind: 'several'; idea: BankIdea; day: string; plans: PlanRow[] }
  | { kind: 'shared'; idea: BankIdea; day: string; plan: PlanRow };

export function BankSurface(props: BankSurfaceProps): ReactElement {
  const { data, filter, layout, canWrite } = props;
  const now = new Date();
  const showToast = useToast().show;
  const undoable = useUndoableAction();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [planIt, setPlanIt] = useState<PlanItStep | null>(null);
  const [showAsk, setShowAsk] = useState<BankIdea | null>(null);
  const [busy, setBusy] = useState(false);
  const ideas = data.ideas;

  const leaveSelect = useCallback(() => {
    setSelecting(false);
    setPicked(new Set());
  }, []);
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

  // Star and Show to client land at once; Archive, Hide and Delete wait behind Undo.
  const star = (idea: BankIdea, on: boolean): void => {
    replaceIdea(withFlags(idea, { starred: on }, new Date().toISOString()));
    void setBankFlags(supabase, idea, { starred: on }).catch(() => {
      replaceIdea(idea);
      showToast({ title: errorText(on ? 'star' : 'unstar', null), tone: 'error' });
    });
  };
  const showToClient = (idea: BankIdea): void => {
    replaceIdea(withFlags(idea, { show: true }, new Date().toISOString()));
    void setBankFlags(supabase, idea, { show: true }).catch(() => {
      replaceIdea(idea);
      showToast({ title: errorText('show it to the client', null), tone: 'error' });
    });
  };
  const hide = (idea: BankIdea): void => {
    replaceIdea(withFlags(idea, { show: false }, new Date().toISOString()));
    undoable.run({
      label: 'Idea hidden',
      commit: () => setBankFlags(supabase, idea, { show: false }),
      revert: () => replaceIdea(idea),
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

  // Plan it: one plan places at once; none offers Make plan; several a picker;
  // a shared plan asks first when the idea is team only.
  const place = useCallback(
    async (idea: BankIdea, plan: PlanRow, day: string): Promise<void> => {
      setBusy(true);
      const res = await placeBankIdea(supabase, idea.id, plan.id, day);
      setBusy(false);
      setPlanIt(null);
      if (!res.ok) {
        showToast({ title: planItError(res.error.message), tone: 'error' });
        return;
      }
      dropIdeas(new Set([idea.id]));
      showToast({
        title: plannedToast(plan.title, day),
        kind: 'undo',
        action: {
          label: 'Undo',
          onPress: () => {
            void unplanBankIdea(supabase, idea.id).then((back) => {
              if (back.ok) data.patch((cur) => [idea, ...cur]);
              else showToast({ title: errorText('undo', back.error.message), tone: 'error' });
            });
          },
        },
      });
    },
    [data, dropIdeas, showToast],
  );
  const choosePlan = useCallback(
    (idea: BankIdea, plan: PlanRow, day: string): void => {
      if (needsSharedWarning(plan, idea)) setPlanIt({ kind: 'shared', idea, day, plan });
      else void place(idea, plan, day);
    },
    [place],
  );
  const runPlanIt = useCallback(
    async (idea: BankIdea, day: string): Promise<void> => {
      const plans = await props.getPlans();
      if (!plans.ok) {
        setPlanIt(null);
        showToast({ title: planItError(plans.error.message), tone: 'error' });
        return;
      }
      const choice = planItChoice(plans.data, day, props.today);
      switch (choice.kind) {
        case 'past':
          setPlanIt(null);
          showToast({ title: planItError('past_date'), tone: 'error' });
          return;
        case 'one':
          choosePlan(idea, choice.plan, day);
          return;
        case 'none':
          setPlanIt({ kind: 'none', idea, day });
          return;
        default:
          setPlanIt({ kind: 'several', idea, day, plans: choice.plans });
      }
    },
    [props, showToast, choosePlan],
  );
  const makePlan = async (idea: BankIdea, day: string): Promise<void> => {
    setBusy(true);
    const made = await makeWeekPlan(supabase, props.workspaceId, day);
    setBusy(false);
    if (!made.ok) {
      setPlanIt(null);
      showToast({ title: errorText('make the plan', made.error.message), tone: 'error' });
      return;
    }
    void place(idea, made.data, day);
  };

  // A drop from the calendar runs Plan it for that day.
  const lastDrop = useRef<number | null>(null);
  useEffect(() => {
    const drop = props.drop;
    if (drop === null || drop === undefined || lastDrop.current === drop.nonce) return;
    lastDrop.current = drop.nonce;
    const idea = ideas?.find((i) => i.id === drop.ideaId);
    if (idea !== undefined) void runPlanIt(idea, drop.day);
  }, [props.drop, ideas, runPlanIt]);

  const menuFor = (idea: BankIdea): ActionMenuItem[] => [
    {
      id: 'open',
      label: 'Open',
      icon: IconArrowUpRight,
      onSelect: () => props.onOpenIdea(idea.id),
    },
    {
      id: 'select',
      label: 'Select',
      icon: IconCheckCircle,
      onSelect: () => {
        setSelecting(true);
        setPicked(new Set([idea.id]));
      },
    },
    {
      id: 'plan-it',
      label: 'Plan it',
      icon: IconCalendar,
      onSelect: () => setPlanIt({ kind: 'date', idea, day: '' }),
    },
    idea.show_to_client === true
      ? { id: 'hide', label: 'Hide from client', icon: IconEyeOff, onSelect: () => hide(idea) }
      : { id: 'show', label: 'Show to client', icon: IconEye, onSelect: () => setShowAsk(idea) },
    idea.starred_at != null
      ? { id: 'unstar', label: 'Unstar', icon: IconStar, onSelect: () => star(idea, false) }
      : { id: 'star', label: 'Star', icon: IconStarFilled, onSelect: () => star(idea, true) },
    {
      id: 'archive',
      label: idea.archived_at != null ? 'Unarchive' : 'Archive',
      icon: IconArchive,
      onSelect: () => archiveMany([idea], idea.archived_at == null),
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: IconTrash,
      tone: 'danger',
      onSelect: () => deleteMany([idea]),
    },
  ];

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pickedIdeas = (ideas ?? []).filter((i) => picked.has(i.id));
  const searching = data.search.active;

  const head = selecting ? (
    <BankSelectBar
      count={picked.size}
      onCancel={leaveSelect}
      onAll={() => setPicked(new Set((ideas ?? []).map((i) => i.id)))}
      onNone={() => setPicked(new Set())}
      onArchive={() => archiveMany(pickedIdeas, !filter.archived)}
      onDelete={() => deleteMany(pickedIdeas)}
    />
  ) : null;
  // Untouched for 90 days: Archive all {n} after the rows (n = the rows loaded).
  const archiveAll =
    canWrite && filter.review && !searching && ideas !== null && ideas.length > 0 ? (
      <div className="pt-2">
        <Button type="button" data-bank-archive-all="" onClick={() => archiveMany(ideas, true)}>
          {archiveAllLabel(ideas.length)}
        </Button>
      </div>
    ) : null;

  let body: ReactElement;
  if (ideas === null) {
    body =
      data.load.status === 'failed' || data.search.status === 'error' ? (
        <div className="px-4 py-6 md:px-0">
          <Button type="button" onClick={searching ? data.search.refresh : data.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <BankBoxes layout={layout} />
      );
  } else if (ideas.length === 0) {
    const copy = bankZeroCopy(filter, searching);
    body =
      searching || filter.bucketId !== null || filter.review ? (
        <div data-bank-zero="">
          <NoResults
            {...(searching ? { query: data.search.query } : {})}
            filtersActive={filter.bucketId !== null || filter.review}
            onClear={() => props.onFilter({ ...filter, bucketId: null, review: false })}
          />
          <p className="sr-only">{copy}</p>
        </div>
      ) : (
        <div data-bank-zero="">
          <EmptyState icon={<IconBank size={ICON_SIZE.tray} />} title={copy} />
        </div>
      );
  } else if (layout === 'table') {
    body = (
      <BankTable
        ideas={ideas}
        buckets={props.buckets}
        now={now}
        canWrite={canWrite}
        picked={picked}
        onToggle={(id) => {
          setSelecting(true);
          toggle(id);
        }}
        onOpen={props.onOpenIdea}
        onPlanIt={(idea) => setPlanIt({ kind: 'date', idea, day: '' })}
        menuFor={menuFor}
        onStar={(idea) => star(idea, idea.starred_at == null)}
      />
    );
  } else {
    body = (
      <div data-bank-list={layout} className="flex flex-col gap-2">
        {ideas.map((idea) => (
          <BankRow
            key={idea.id}
            idea={idea}
            layout={layout}
            buckets={props.buckets}
            now={now}
            canWrite={canWrite}
            selecting={selecting}
            selected={picked.has(idea.id)}
            menuItems={menuFor(idea)}
            onOpen={() => props.onOpenIdea(idea.id)}
            onToggle={() => toggle(idea.id)}
            onHold={() => {
              setSelecting(true);
              setPicked(new Set([idea.id]));
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      data-bank={layout}
      className={cn(
        'flex flex-col gap-2',
        layout === 'phone' ? 'pb-8 pt-2' : layout === 'panel' ? 'h-full' : 'px-6 pb-8 pt-2',
      )}
    >
      {layout === 'table' && props.onCollapse !== undefined ? (
        <div className="flex items-center gap-2">
          <Button type="button" data-bank-calendar="" onClick={props.onCollapse}>
            <IconChevronLeft size={ICON_SIZE.inline} />
            Calendar
          </Button>
          <div className="min-w-0 flex-1">{props.toolbar}</div>
        </div>
      ) : (
        props.toolbar
      )}
      {head}
      <div
        className={cn(
          layout === 'phone' && 'px-4',
          layout === 'panel' && 'min-h-0 flex-1 overflow-y-auto px-4 pb-2',
        )}
      >
        {body}
        {data.more !== null ? (
          <div className="pt-2">
            <PlanTabLoadMore more={data.more} />
          </div>
        ) : null}
        {archiveAll}
      </div>
      {layout === 'panel' && canWrite ? (
        <p data-bank-drag-hint="" className="border-t border-border px-4 py-2 text-sm text-fg-3">
          Drag a card onto a day to plan it.
        </p>
      ) : null}
      {canWrite ? (
        <>
          <BankPlanItSheets
            step={planIt}
            busy={busy}
            today={props.today}
            onClose={() => setPlanIt(null)}
            onDay={(idea, day) => void runPlanIt(idea, day)}
            onMakePlan={(idea, day) => void makePlan(idea, day)}
            onPickPlan={(idea, plan, day) => choosePlan(idea, plan, day)}
            onConfirmShared={(idea, plan, day) => void place(idea, plan, day)}
          />
          <BankShowSheet
            idea={showAsk}
            workspaceId={props.workspaceId}
            onClose={() => setShowAsk(null)}
            onShow={(idea) => {
              setShowAsk(null);
              showToClient(idea);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The laptop Bank: ui/SidePanel on the right (380px, nothing dims, Esc
 * closes), header "Bank" with its count, Expand, X. Laptop only
 * (useIsLaptop); the phone shows the same rows under the Bank chip, and its
 * Plan it, Filter and Add flows are Sheets.
 */
export function BankPanel(props: {
  open: boolean;
  onClose: () => void;
  count: string | null;
  onExpand: () => void;
  surface: Omit<BankSurfaceProps, 'layout' | 'toolbar'>;
  toolbar: ReactNode;
}): ReactElement | null {
  const laptop = useIsLaptop();
  if (!laptop) return null;
  return (
    <SidePanel
      open={props.open}
      onClose={props.onClose}
      title="Bank"
      headerExtra={
        <>
          {props.count !== null ? (
            <span data-bank-panel-count="" className="text-lg font-semibold tabular-nums text-fg-3">
              {props.count}
            </span>
          ) : null}
          <IconButton
            label="Expand"
            data-bank-expand=""
            className="ml-auto"
            onClick={props.onExpand}
          >
            <IconExpand size={ICON_SIZE.control} />
          </IconButton>
        </>
      }
    >
      <BankSurface layout="panel" {...props.surface} toolbar={props.toolbar} />
    </SidePanel>
  );
}

/** Loading boxes in the rows' own shape (only while nothing is held). */
function BankBoxes(props: { layout: BankLayout }): ReactElement {
  const size = props.layout === 'phone' ? 'h-14 w-14' : 'h-11 w-11';
  return (
    <BoxSkeleton
      lit="flat"
      label="Loading ideas"
      data-bank-loading=""
      className="flex flex-col gap-2"
    >
      {[0, 1, 2].map((k) => (
        <div
          key={k}
          className="lit-card flex items-center gap-3 rounded-xl border bg-panel px-3.5 py-3"
        >
          <Bone lit="lit-media" className={cn(size, 'shrink-0 rounded-lg')} />
          <span className="flex flex-1 flex-col gap-2">
            <Bone lit="flat" className="h-4 w-2/3 rounded" />
            <Bone lit="flat" className="h-3 w-1/3 rounded" />
          </span>
        </div>
      ))}
    </BoxSkeleton>
  );
}

// ---------------------------------------------------------------------------
// The table (laptop Expand)
// ---------------------------------------------------------------------------

function BankTable(props: {
  ideas: readonly BankIdea[];
  buckets: readonly BucketOption[];
  now: Date;
  canWrite: boolean;
  picked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onPlanIt: (idea: BankIdea) => void;
  onStar: (idea: BankIdea) => void;
  menuFor: (idea: BankIdea) => ActionMenuItem[];
}): ReactElement {
  const th = 'px-3 py-2 text-left text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';
  return (
    <div data-bank-table="" className="lit-card overflow-x-auto rounded-xl border bg-panel">
      <table className="w-full border-collapse text-base">
        <thead className="lit-header border-b bg-panel-2">
          <tr>
            {props.canWrite ? (
              <th className={th}>
                <span className="sr-only">Select</span>
              </th>
            ) : null}
            <th className={th}>
              <span className="sr-only">Star</span>
            </th>
            <th className={th}>Idea</th>
            <th className={th}>Buckets</th>
            <th className={th}>Came from</th>
            <th className={th}>Who sees it</th>
            <th className={th}>Comments</th>
            <th className={th}>Last active</th>
            <th className={th}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.ideas.map((idea) => {
            const on = props.picked.has(idea.id);
            return (
              <tr
                key={idea.id}
                data-bank-table-row={idea.id}
                data-selected={on ? 'true' : undefined}
                className={cn(
                  'border-b last:border-b-0',
                  on ? 'border-transparent lit-selected' : 'border-border',
                )}
              >
                {props.canWrite ? (
                  <td className="px-1">
                    <label className="flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center">
                      <Checkbox
                        checked={on}
                        onChange={() => props.onToggle(idea.id)}
                        aria-label={`Select ${idea.title ?? 'idea'}`}
                      />
                    </label>
                  </td>
                ) : null}
                <td className="px-1">
                  {props.canWrite ? (
                    <IconButton
                      label={idea.starred_at != null ? 'Unstar' : 'Star'}
                      className={
                        idea.starred_at != null ? 'text-warn hover:text-warn' : 'text-fg-3'
                      }
                      onClick={() => props.onStar(idea)}
                    >
                      {idea.starred_at != null ? (
                        <IconStarFilled size={ICON_SIZE.inline} />
                      ) : (
                        <IconStar size={ICON_SIZE.inline} />
                      )}
                    </IconButton>
                  ) : idea.starred_at != null ? (
                    <span className="flex justify-center text-warn">
                      <IconStarFilled size={ICON_SIZE.inline} />
                    </span>
                  ) : null}
                </td>
                <td className="max-w-[320px] px-3 py-2">
                  <PressableRow
                    type="button"
                    flat
                    inline
                    data-bank-open={idea.id}
                    onClick={() => props.onOpen(idea.id)}
                    className="flex min-w-0 items-center gap-3 text-left"
                  >
                    <BankThumb idea={idea} size={44} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-fg">{idea.title ?? ''}</span>
                      <span className="truncate text-sm text-fg-3">{ideaFilesLine(idea)}</span>
                    </span>
                  </PressableRow>
                </td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    {(idea.bucket_ids ?? []).flatMap((id) => {
                      const b = props.buckets.find((x) => x.id === id);
                      return b !== undefined ? [<Tag key={b.id} label={b.name} />] : [];
                    })}
                  </span>
                </td>
                <td className="px-3 py-2 text-fg-2">{cameFromLabel(idea)}</td>
                <td className="px-3 py-2">
                  {idea.show_to_client === true ? (
                    <Tag label={CLIENT_CAN_SEE} tone="good" />
                  ) : (
                    <Tag label={TEAM_ONLY} />
                  )}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-fg-2">{idea.comment_count}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-sm tabular-nums text-fg-3">
                  {formatRelative(idea.last_active_at ?? idea.created_at, props.now)}
                </td>
                <td className="px-2 py-1">
                  {props.canWrite ? (
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        data-bank-plan-it={idea.id}
                        onClick={() => props.onPlanIt(idea)}
                      >
                        Plan it
                      </Button>
                      <ActionMenu title={idea.title ?? 'Idea'} items={props.menuFor(idea)} />
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** Plan it's sheets: the date, No plan covers, the plan picker, the shared warning. */
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
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" className="mr-auto" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-plan-it-go=""
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
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" className="mr-auto" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-make-plan=""
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
        <div data-bank-plan-picker="" className="flex flex-col gap-2 p-4">
          {step?.kind === 'several'
            ? step.plans.map((plan) => (
                <PressableRow
                  key={plan.id}
                  card
                  type="button"
                  data-bank-plan-option={plan.id}
                  onClick={() => props.onPickPlan(step.idea, plan, step.day)}
                  className="lit-card flex items-center gap-2 border bg-panel px-3.5 py-3"
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
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" className="mr-auto" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-bank-shared-go=""
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
function BankShowSheet(props: {
  idea: BankIdea | null;
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
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" type="button" className="mr-auto" onClick={props.onClose}>
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
      {idea !== null ? <ShowWarning idea={idea} workspaceId={props.workspaceId} /> : null}
    </Sheet>
  );
}

/** The warning line; the members read runs only while the sheet is open. */
function ShowWarning(props: { idea: BankIdea; workspaceId: string }): ReactElement {
  const members = useWorkspaceMembers(props.workspaceId);
  const names = useMemo(
    () => approverNames(members.rows, members.profiles),
    [members.rows, members.profiles],
  );
  return (
    <p data-bank-show-warning="" className="p-4 text-base text-fg">
      {showToClientWarning(names, props.idea.comment_count)}
    </p>
  );
}
