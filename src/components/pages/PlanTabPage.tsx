// The Plan tab (/plan), phone and laptop alike (the laptop Month | Week
// calendar retired 7 Nov 2026, so there is no Month | Week well to keep):
// the app top bar carries the tab's sort and, for creators, its "+" (New plan;
// on the Bank chip, Filter and sort and Add idea) through useTopbarActions;
// there is no page title and no search of its own (the top bar's
// CommandPalette is the one search). Under it the chip row (Bank, Upcoming,
// Past; the tab opens on Upcoming) with the Bank's Select pinned at its end;
// then the plans as ui/ListCard cards in LIST_CARD_GRID (one column on a
// phone, auto-fill columns on a laptop; PlanTabList): Upcoming groups This
// week, Next week and Later under their headings, Past is one list. Both
// chips read every plan a page at a time (usePlanTabData): while more remain,
// the page hands the list its Load more (the hook's loadMore and moreBusy).
// Opening a plan goes to /plan/:planId, which PlanBesideLayout docks beside
// this page on a laptop (the page stays mounted) and shows alone on a phone.
// New plan opens the existing New plan screen (plan_create_with_items: a
// Draft); nothing is ever posted to a chat. No plan at all shows the zero
// state (line 2 only until onboarding is done), with no create button of its
// own: the top bar's New plan is the one. Approvers see shared plans only, and
// never Create. A return to the tab lands on the same chip and the same scroll
// (src/lib/kept-view.ts), over the chip's kept read. The cards' times read off
// one minute clock (useMinuteClock) held here.
// The Bank (the idea bank, plan-tab/BankList.tsx): the first chip; the top
// bar's sort opens its Filter and sort sheet, its "+" is Add idea; the chip
// row's Select starts its select mode (BankSelectBar), as a long-press does.
// ?week=bank lands on it. A client sees it only when their bank read holds an
// idea. The Bank reads after the tab paints (use-bank-data.ts) and re-reads
// on its live topic (bank:<workspace_id>) while open.
// Sort (Newest first, Oldest first, Name) orders the plan list.

import { mark } from '@/lib/perf-marks';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { useInduction } from '@/components/induction/InductionProvider';
import { PageHead } from '@/components/shell/PageHead';
import { SectionHeader, SectionSelect } from '@/components/shell/SectionHeader';
import { TopbarPlus, useTopbarActions } from '@/components/shell/topbar-actions';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortMenu } from '@/components/ui/SortMenu';
import { GUTTER } from '@/components/ui/layout';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { ICON_SIZE, IconPlan } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ComposeRange, PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { keptViewKey, useKeptScroll, useKeptState } from '@/lib/kept-view';
import { safeTimeZone } from '@/lib/time';
import { useViewerSide } from '@/lib/chat/viewer-role';
import {
  NEW_PLAN_LABEL,
  canCreatePlans,
  onboardingFinished,
  visibleBundles,
  zeroStateCopy,
  PLAN_BANK_CHIP,
  PLAN_WEEK_CHIP_DEFAULT,
  PLAN_WEEK_CHIP_ZERO,
  PLAN_WEEK_PARAM,
  parsePlanWeekChip,
  planChipHolds,
  planSectionOf,
  visiblePlanChips,
  planWeekChipLabel,
  type PlanWeekChip,
} from '@/lib/plan-tab';
import { Chip } from '@/components/ui/Chip';
import {
  PLAN_SORT_DEFAULT,
  PLAN_SORT_OPTIONS,
  sanitizePlanSort,
  sortPlanBundles,
  type PlanTabData,
  type PlanTabSort,
} from '@/lib/plan-tab-read';
import { civilToday } from '@/lib/plan-week';
import { useSession } from '@/lib/session-context';
import { useSort } from '@/lib/use-sort';
import { useWorkspace } from '@/lib/workspace-context';
import {
  PlanTabBoxes,
  PlanTabCard,
  PlanTabList,
  PlanTabLoadMore,
  planCover,
  type PlanTabMore,
} from './plan-tab/PlanTabList';
import { usePlanTabData } from './plan-tab/use-plan-tab-data';
import { BankAddSheet } from './plan-tab/BankAddSheet';
import { BankFilterSheet, BankFilterTrigger } from './plan-tab/BankFilterSheet';
import { BankFilterLine, BankSurface } from './plan-tab/BankList';
import {
  BANK_FILTER_DEFAULT,
  bankItemHref,
  bucketIdeaCount,
  sanitizeBankFilter,
  type BankFilter,
} from './plan-tab/bank-parts';
import {
  bucketWritesFor,
  useBankBuckets,
  useBankData,
  readPlansForPlanIt,
} from './plan-tab/use-bank-data';
import { useBankSelect } from './plan-tab/use-bank-select';
import { peekEntityUnreadComment, withCommentTarget } from '@/lib/inbox/unread-entities';

/**
 * A list open with unread comments lands on the newest one (the
 * jump-to-latest rule); read at tap time, since the open marks them read.
 */
function withNewestUnread(route: string, type: 'post' | 'plan_item', id: string): string {
  return withCommentTarget(route, peekEntityUnreadComment(type, id));
}

/** The list in a flat order (Newest first, Name), in the same grid, with the same Load more. */
function PlanTabFlatList(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  timeZone: string;
  now: Date;
  onOpen: (planId: string) => void;
  more: PlanTabMore | null;
}): ReactElement {
  return (
    <div data-plan-tab-list="" className={cn('flex flex-col gap-3 pb-8 pt-4', GUTTER)}>
      {props.bundles.length === 0 ? (
        <div data-plan-tab-chip-zero="">
          <EmptyState icon={<IconPlan size={ICON_SIZE.tray} />} title={PLAN_WEEK_CHIP_ZERO} />
        </div>
      ) : (
        <div className={LIST_CARD_GRID}>
          {props.bundles.map((bundle) => (
            <PlanTabCard
              key={bundle.plan.id}
              bundle={bundle}
              cover={planCover(bundle, props.thumbs)}
              timeZone={props.timeZone}
              now={props.now}
              onOpen={() => props.onOpen(bundle.plan.id)}
            />
          ))}
        </div>
      )}
      {props.more !== null ? <PlanTabLoadMore more={props.more} /> : null}
    </div>
  );
}

export function PlanTabPage(): ReactElement {
  const navigate = useNavigate();
  mark('plan-tab:mount');
  const { workspaceId, workspaces } = useWorkspace();
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side, ready } = useViewerSide(workspaceId);
  if (ready) mark('plan-tab:side');
  const onboarded = onboardingFinished(useInduction()?.resolution.kind ?? null);
  const today = civilToday(new Date(), timeZone);
  // The one clock every card's time reads (one shared interval, no per-card timer).
  const nowMs = useMinuteClock();
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const userId = useSession().session?.user.id ?? null;
  const keptKey = (what: string): string | null =>
    userId !== null && workspaceId !== null
      ? keptViewKey(userId, workspaceId, `plan-tab:${what}`)
      : null;
  // The New plan screen: closed (null) or open with its dates (undefined: this week).
  const [compose, setCompose] = useState<{ range: ComposeRange | undefined } | null>(null);
  const creator = canCreatePlans(side);
  const [params, setParams] = useSearchParams();
  // The chip: in the URL (?week=) so Back lands on it, else this session's
  // last pick (a tab return), else Upcoming. A retired chip value (this, next,
  // later, all, earlier) lands on Upcoming or Past (parsePlanWeekChip).
  const [keptChip, setKeptChip] = useKeptState<string>(keptKey('week'), PLAN_WEEK_CHIP_DEFAULT);
  const chip =
    parsePlanWeekChip(params.get(PLAN_WEEK_PARAM)) ??
    parsePlanWeekChip(keptChip) ??
    PLAN_WEEK_CHIP_DEFAULT;
  // The Bank's select mode, shared by its cards and the chip row's Select.
  const bankSelect = useBankSelect();
  const leaveBankSelect = bankSelect.clear;
  const setChip = useCallback(
    (value: PlanWeekChip): void => {
      // A chip change leaves the Bank's select mode (its Back entry too).
      if (value !== PLAN_BANK_CHIP) leaveBankSelect();
      setKeptChip(value);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(PLAN_WEEK_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [leaveBankSelect, setKeptChip, setParams],
  );
  // The Bank: the Bank chip, on both widths.
  const onBank = chip === PLAN_BANK_CHIP;
  const [storedBankFilter, setBankFilter] = useKeptState<BankFilter>(
    keptKey('bank-filter'),
    BANK_FILTER_DEFAULT,
  );
  const bankFilter = useMemo(() => sanitizeBankFilter(storedBankFilter), [storedBankFilter]);
  const [bankSheet, setBankSheet] = useState<'filter' | 'add' | null>(null);
  const { value: storedSort, setValue: setSort } = useSort<PlanTabSort>('plan', PLAN_SORT_DEFAULT);
  const sort = sanitizePlanSort(storedSort);
  const bank = useBankData({
    workspaceId,
    userId,
    enabled: ready,
    filter: bankFilter,
    // Live only while the Bank chip is picked, agency side; the
    // subscription starts in an effect, after the Bank paints.
    live: onBank && creator,
  });
  const bankBuckets = useBankBuckets({ workspaceId, userId, enabled: ready });
  // A client sees the Bank only when their bank read holds an idea.
  const showBank = creator || (bank.ideas?.length ?? 0) > 0;
  if (onBank && bank.ideas !== null) mark('plan-bank:paint');
  const bucketWrites = useMemo(
    () =>
      creator && workspaceId !== null
        ? bucketWritesFor(workspaceId, (id) => bucketIdeaCount(bank.ideas ?? [], id))
        : null,
    [creator, workspaceId, bank.ideas],
  );
  // Upcoming and Past read every plan (no range), a page at a time: one read
  // for both chips, so a chip pick paints at once from the same pages.
  const { load, retry, loadMore, moreBusy } = usePlanTabData({
    workspaceId,
    range: null,
    onlyShared: !creator,
    enabled: ready,
  });
  // The tab's own read. While a new read is on its way (a side or workspace
  // change re-keys it) the page paints at once from the last read this mount
  // held, and its own read replaces it when it lands (speed rule: paint what
  // the device holds, fetch the rest behind it). Never across workspaces or
  // sides.
  const own = load.status === 'ready' ? load.data : null;
  const heldKey = `${workspaceId ?? ''}:${String(creator)}`;
  const held = useRef<{ key: string; data: PlanTabData } | null>(null);
  if (own !== null) held.current = { key: heldKey, data: own };
  const borrowed =
    own === null && load.status === 'loading' && held.current?.key === heldKey
      ? held.current.data
      : null;
  const data = own ?? borrowed;
  useKeptScroll(keptKey('scroll'), data !== null);
  // Load more belongs to the tab's own read only.
  const more = useMemo(
    () => (own !== null && own.nextCursor !== null ? { busy: moreBusy, onMore: loadMore } : null),
    [own, moreBusy, loadMore],
  );
  const bundles = useMemo(
    () => (data !== null ? visibleBundles(data.bundles, side) : []),
    [data, side],
  );
  // The chip narrows the list to its sections (Upcoming: This week, Next
  // week, Later; Past: the rest).
  const inChip = useCallback(
    (b: PlanBundle): boolean => planChipHolds(chip, planSectionOf(b.plan, today)),
    [chip, today],
  );
  const zero = data !== null && !data.anyPlan;
  const openCompose = (range?: ComposeRange): void => setCompose({ range });

  // The top bar (decision A): the sort, then the filled "+" for creators
  // (none for anyone who can't create). On the Bank chip the sort opens its
  // Filter and sort sheet and the "+" is Add idea. Pure render: published in
  // a layout effect, no read, no await.
  useTopbarActions(
    onBank
      ? {
          sort: <BankFilterTrigger onOpen={() => setBankSheet('filter')} />,
          primary:
            creator && workspaceId !== null && bucketWrites !== null ? (
              <TopbarPlus label="Add idea" onClick={() => setBankSheet('add')} />
            ) : undefined,
        }
      : {
          sort: (
            <SortMenu<PlanTabSort>
              options={PLAN_SORT_OPTIONS}
              value={sort}
              onChange={setSort}
              label="Sort plans"
            />
          ),
          primary:
            creator && workspaceId !== null ? (
              <TopbarPlus label={NEW_PLAN_LABEL} onClick={() => openCompose()} />
            ) : undefined,
        },
  );

  const chipRow = <PlanWeekChips chip={chip} onChip={setChip} showBank={showBank} />;
  // Decision E: the Bank's visible Select at the chip row's end, where the
  // person can select (creators; a client reads only). The plan list has no
  // select mode, so its head shows none (hide what a person can't do).
  const head = (
    <SectionHeader
      {...(onBank && creator
        ? {
            select: <SectionSelect active={bankSelect.active} onToggle={bankSelect.toggleMode} />,
          }
        : {})}
    >
      {chipRow}
    </SectionHeader>
  );

  if (data !== null && !zero) mark('plan-tab:paint');
  // A borrowed read with nothing in the picked chip is not this chip's answer
  // yet: boxes until its own read lands, never the zero line.
  const borrowedEmpty = borrowed !== null && !bundles.some(inChip);
  const listBoxes = !onBank && load.status !== 'failed' && (data === null || borrowedEmpty);
  const hadBoxes = useHadBoxes(listBoxes);
  const landedRef = useRef<HTMLDivElement>(null);
  const landed = data !== null && !zero;
  useSettleOnLanding(landedRef, landed && !listBoxes, hadBoxes);
  const openIdea = (id: string): void =>
    navigate(withNewestUnread(bankItemHref(id), 'plan_item', id));
  const bankSurfaceProps =
    workspaceId !== null
      ? {
          data: bank,
          filter: bankFilter,
          onFilter: setBankFilter,
          buckets: bankBuckets.buckets,
          canWrite: creator,
          workspaceId,
          today,
          now,
          getPlans: () => readPlansForPlanIt(workspaceId, today),
          onOpenIdea: openIdea,
          epoch: chip,
          selection: bankSelect,
        }
      : null;
  const bankLine = (
    <BankFilterLine
      filter={bankFilter}
      buckets={bankBuckets.buckets}
      onFilter={setBankFilter}
      onClear={() => setBankFilter(BANK_FILTER_DEFAULT)}
    />
  );
  let body: ReactElement;
  if (onBank && bankSurfaceProps !== null) {
    body = (
      <>
        {bankLine}
        <BankSurface {...bankSurfaceProps} />
      </>
    );
  } else if (load.status === 'failed') {
    body = <ScreenFailed onRetry={retry} />;
  } else if (zero) {
    const copy = zeroStateCopy(side, onboarded);
    body = (
      <div data-plan-tab-zero="">
        <EmptyState
          icon={<IconPlan size={ICON_SIZE.tray} />}
          title={copy.title}
          {...(copy.line2 !== null ? { description: copy.line2 } : {})}
        />
      </div>
    );
  } else if (data === null || borrowedEmpty) {
    // Only the grouped Upcoming list has headings; elsewhere the boxes draw none (no shift on landing).
    body = <PlanTabBoxes heading={chip === 'upcoming' && sort === PLAN_SORT_DEFAULT} />;
  } else if (sort === PLAN_SORT_DEFAULT) {
    body = (
      <PlanTabList
        bundles={bundles}
        thumbs={data.thumbs}
        today={today}
        timeZone={timeZone}
        now={now}
        onOpen={(planId) => navigate(`/plan/${planId}`)}
        more={more}
        chip={chip}
      />
    );
  } else {
    body = (
      <PlanTabFlatList
        bundles={sortPlanBundles(bundles.filter(inChip), sort)}
        thumbs={data.thumbs}
        timeZone={timeZone}
        now={now}
        onOpen={(planId) => navigate(`/plan/${planId}`)}
        more={more}
      />
    );
  }

  return (
    <>
      <PageHead title="Plan" hidden />
      {head}
      <div ref={landedRef} className="contents">
        {body}
      </div>
      {workspaceId !== null ? (
        <BankFilterSheet
          open={bankSheet === 'filter'}
          onClose={() => setBankSheet(null)}
          filter={bankFilter}
          onFilter={setBankFilter}
          buckets={bankBuckets.buckets}
          writes={bucketWrites}
          onBuckets={bankBuckets.set}
        />
      ) : null}
      {creator && workspaceId !== null && bucketWrites !== null ? (
        <BankAddSheet
          open={bankSheet === 'add'}
          onClose={() => setBankSheet(null)}
          workspaceId={workspaceId}
          buckets={bankBuckets.buckets}
          writes={bucketWrites}
          onBuckets={bankBuckets.set}
          onAdded={(idea) => bank.patch((list) => [idea, ...list.filter((i) => i.id !== idea.id)])}
        />
      ) : null}
      {creator && workspaceId !== null ? (
        <PlanComposeScreen
          open={compose !== null}
          workspaceId={workspaceId}
          timeZone={timeZone}
          {...(compose?.range !== undefined ? { initialRange: compose.range } : {})}
          onClose={() => setCompose(null)}
          onCreated={(planId, stale) => {
            // A create from a form since closed opens nothing.
            if (stale) return;
            setCompose(null);
            navigate(`/plan/${planId}`);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The chip row, phone and laptop (Bank, Upcoming, Past), on the same line as
 * Pipeline's stage chips so switching tabs never moves the page. No counts: the list reads a page at a
 * time. Bank shows for a creator, or a client whose bank holds an idea.
 */
function PlanWeekChips(props: {
  chip: PlanWeekChip;
  onChip: (chip: PlanWeekChip) => void;
  showBank: boolean;
}): ReactElement {
  return (
    <>
      {visiblePlanChips(props.showBank).map((key) => (
        <Chip
          key={key}
          label={planWeekChipLabel(key)}
          selected={props.chip === key}
          size="tap"
          data-plan-tab-when={key}
          className="flex-none whitespace-nowrap"
          onClick={() => props.onChip(key)}
        />
      ))}
    </>
  );
}
