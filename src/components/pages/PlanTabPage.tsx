// The Plan tab (/plan), phone and laptop alike (the laptop Month | Week
// calendar retired 7 Nov 2026): the shared top bar (no page title) with the
// search, the sort and, for creators, New plan; the chips under it (Bank, This
// week, Next week, Upcoming, Past, All; the tab opens on This week); then the
// plans as ui/ListCard cards in LIST_CARD_GRID (one column on a phone,
// auto-fill columns on a laptop; PlanTabList), grouped under All. A chip
// reads its own range a page at a time (usePlanTabData): while more remain,
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
// The Bank (the idea bank, plan-tab/BankList.tsx): the first chip, whose
// toolbar is search, Filter and sort, then Add idea, over the same ListCard
// grid; ?week=bank lands on it. A client sees it only when their bank read
// holds an idea. The Bank reads after the tab paints (use-bank-data.ts).
// Search (?q=, src/lib/search/server-search.ts): from 2 characters,
// plan_search then the matched plans in one plan_bundle_read, shown as a list
// of plans with their matched items (tapping an item opens it in its plan).
// Sort (Newest first, Oldest first, Name) orders the list and the search
// results.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { useInduction } from '@/components/induction/InductionProvider';
import { PageHead } from '@/components/shell/PageHead';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { Highlight } from '@/components/ui/SearchHighlight';
import { SortMenu } from '@/components/ui/SortMenu';
import { IconButton } from '@/components/ui/IconButton';
import { GUTTER } from '@/components/ui/layout';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { ICON_SIZE, IconFilterLines, IconPlan, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ComposeRange, PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { queryWords } from '@/lib/chat/search';
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
  planSectionOf,
  visiblePlanChips,
  planWeekChipLabel,
  planWeekChipRange,
  type PlanWeekChip,
} from '@/lib/plan-tab';
import { Chip } from '@/components/ui/Chip';
import {
  PLAN_SORT_DEFAULT,
  PLAN_SORT_OPTIONS,
  sanitizePlanSort,
  searchPlanTab,
  sortPlanBundles,
  type PlanSearchData,
  type PlanTabData,
  type PlanTabSort,
} from '@/lib/plan-tab-read';
import { civilToday } from '@/lib/plan-week';
import { useServerSearch } from '@/lib/search/server-search';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
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
import { usePlanTabData, warmPlanTabRead } from './plan-tab/use-plan-tab-data';
import { BankAddSheet } from './plan-tab/BankAddSheet';
import { BankFilterSheet } from './plan-tab/BankFilterSheet';
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
import { peekEntityUnreadComment, withCommentTarget } from '@/lib/inbox/unread-entities';

/** The route an item opens: the item in its plan (a search match). Pure. */
export function itemRoute(planId: string, itemId: string): string {
  return `/plan/${planId}?item=${itemId}`;
}

/**
 * A list open with unread comments lands on the newest one (the
 * jump-to-latest rule); read at tap time, since the open marks them read.
 */
function withNewestUnread(route: string, type: 'post' | 'plan_item', id: string): string {
  return withCommentTarget(route, peekEntityUnreadComment(type, id));
}

/** The list search's URL param (?q=), as on every list screen. */
const SEARCH_PARAM = 'q';

/** An item's label in a search result: its title, or its post's. Pure. */
export function matchedItemTitle(bundle: PlanBundle, itemId: string): string | null {
  const item = bundle.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) return null;
  if (item.title !== null && item.title !== '') return item.title;
  return item.post_id !== null ? (bundle.postInfo[item.post_id]?.title ?? null) : null;
}

/**
 * Plan search results: one card per plan (the list's ListCard) in the list's
 * grid, in the sort's order, each followed by its matched items, the searched
 * words marked; a card opens its plan, an item opens in its plan. Zero
 * matches: NoResults.
 */
export function PlanSearchResults(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  matchedItems: Readonly<Record<string, string[]>>;
  query: string;
  timeZone: string;
  now: Date;
  onOpenPlan: (planId: string) => void;
  onOpenItem: (planId: string, itemId: string) => void;
  /** Whether a chip also narrows the results (the phone's week chips); Clear then resets it too. */
  filtersActive?: boolean;
  onClear: () => void;
}): ReactElement {
  const words = queryWords(props.query);
  if (props.bundles.length === 0) {
    return (
      <NoResults
        query={props.query}
        filtersActive={props.filtersActive ?? false}
        onClear={props.onClear}
      />
    );
  }
  return (
    <div data-plan-tab-results="" className={cn(LIST_CARD_GRID, 'pb-8 pt-4', GUTTER)}>
      {props.bundles.map((bundle) => {
        const id = bundle.plan.id;
        const items = (props.matchedItems[id] ?? []).flatMap((itemId) => {
          const title = matchedItemTitle(bundle, itemId);
          return title !== null ? [{ itemId, title }] : [];
        });
        return (
          <div key={id} className="flex min-w-0 flex-col gap-1">
            <PlanTabCard
              bundle={bundle}
              cover={planCover(bundle, props.thumbs)}
              timeZone={props.timeZone}
              now={props.now}
              onOpen={() => props.onOpenPlan(id)}
            />
            {items.map(({ itemId, title }) => (
              <PressableRow
                key={itemId}
                type="button"
                data-plan-tab-match={itemId}
                onClick={() => props.onOpenItem(id, itemId)}
                className="flex items-center px-4 text-base text-fg"
              >
                <span className="truncate">
                  <Highlight text={title} words={words} />
                </span>
              </PressableRow>
            ))}
          </div>
        );
      })}
    </div>
  );
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
  // The search box lives in the URL (?q=) so Back lands on the same results.
  const [params, setParams] = useSearchParams();
  const search = params.get(SEARCH_PARAM) ?? '';
  const setSearch = useCallback(
    (value: string): void => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === '') next.delete(SEARCH_PARAM);
          else next.set(SEARCH_PARAM, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  // The chip: in the URL (?week=) so Back lands on it, else this
  // session's last pick (a tab return), else This week.
  const [keptChip, setKeptChip] = useKeptState<PlanWeekChip>(
    keptKey('week'),
    PLAN_WEEK_CHIP_DEFAULT,
  );
  const chip = parsePlanWeekChip(params.get(PLAN_WEEK_PARAM)) ?? keptChip;
  const setChip = useCallback(
    (value: PlanWeekChip): void => {
      setKeptChip(value);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(PLAN_WEEK_PARAM, value);
          // The search box belongs to the chip it was typed under.
          if ((chip === PLAN_BANK_CHIP) !== (value === PLAN_BANK_CHIP)) next.delete(SEARCH_PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [chip, setKeptChip, setParams],
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
  const planSearch = useServerSearch<PlanSearchData>(
    onBank ? '' : search,
    (query, signal) =>
      workspaceId === null
        ? Promise.resolve({
            ok: true as const,
            data: { bundles: [], thumbs: { posts: {}, concepts: {} }, matchedItems: {}, timeZone },
          })
        : searchPlanTab(supabase, { workspaceId, query }, signal),
    workspaceId ?? '',
  );
  const searching = planSearch.active;
  const bank = useBankData({
    workspaceId,
    userId,
    enabled: ready,
    filter: bankFilter,
    searchText: onBank ? search : '',
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
  const { load, retry, loadMore, moreBusy } = usePlanTabData({
    workspaceId,
    range: planWeekChipRange(chip, today),
    onlyShared: !creator,
    enabled: ready,
  });
  // The chip's own read. A chip whose read is still on its way
  // paints at once from the last read this mount held (narrowed to the chip),
  // and its own read replaces it when it lands (speed rule: paint what the
  // device holds, fetch the rest behind it). Never across workspaces or sides.
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
  // Load more belongs to the chip's own read only.
  const more = useMemo(
    () => (own !== null && own.nextCursor !== null ? { busy: moreBusy, onMore: loadMore } : null),
    [own, moreBusy, loadMore],
  );
  // After This week or Next week paints, every plan is read once
  // behind it (one request, not on a paint or tap path), so All, Upcoming and
  // Past paint at once when tapped.
  const weekRead = planWeekChipRange(chip, today) !== null;
  const ownReady = own !== null;
  useEffect(() => {
    if (!ownReady || !weekRead || workspaceId === null) return;
    warmPlanTabRead({ workspaceId, range: null, onlyShared: !creator });
  }, [ownReady, weekRead, workspaceId, creator]);
  const bundles = useMemo(
    () => (data !== null ? visibleBundles(data.bundles, side) : []),
    [data, side],
  );
  // The chip narrows the list and the search results to its week group.
  const inChip = useCallback(
    (b: PlanBundle): boolean => chip === 'all' || planSectionOf(b.plan, today) === chip,
    [chip, today],
  );
  const zero = data !== null && !data.anyPlan;
  const openCompose = (range?: ComposeRange): void => setCompose({ range });
  // Search results, in the sort's order; approvers see shared plans only.
  const results = useMemo(
    () =>
      planSearch.data !== null
        ? sortPlanBundles(visibleBundles(planSearch.data.bundles, side).filter(inChip), sort)
        : null,
    [planSearch.data, side, sort, inChip],
  );

  const sortMenu = (
    <SortMenu<PlanTabSort>
      options={PLAN_SORT_OPTIONS}
      value={sort}
      onChange={setSort}
      label="Sort plans"
    />
  );
  // No page title (as Pipeline and Briefs): the shared top bar starts with the
  // search, then the sort (the Bank: Filter and sort), then New plan (the
  // Bank: Add idea) for creators; the chips under it. Both widths alike.
  const filterButton = (
    <IconButton
      label="Filter and sort"
      data-bank-filter-open=""
      onClick={() => setBankSheet('filter')}
      className="shrink-0"
    >
      <IconFilterLines size={ICON_SIZE.control} />
    </IconButton>
  );
  const chipRow = <PlanWeekChips chip={chip} onChip={setChip} showBank={showBank} />;
  const head = onBank ? (
    <SectionHeader<PlanTabSort>
      search={{
        value: search,
        onChange: setSearch,
        placeholder: 'Search ideas',
        label: 'Search ideas',
      }}
      sort={{ node: filterButton }}
      {...(creator
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  type="button"
                  data-bank-add-open=""
                  onClick={() => setBankSheet('add')}
                  className="shrink-0 whitespace-nowrap"
                >
                  <IconPlus size={ICON_SIZE.inline} />
                  Add idea
                </Button>
              ),
            },
          }
        : {})}
    >
      {chipRow}
    </SectionHeader>
  ) : (
    <SectionHeader<PlanTabSort>
      search={{
        value: search,
        onChange: setSearch,
        placeholder: 'Search plans',
        label: 'Search plans',
      }}
      sort={{ node: sortMenu }}
      {...(creator
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  type="button"
                  data-plan-tab-new=""
                  onClick={() => openCompose()}
                  className="shrink-0 whitespace-nowrap"
                >
                  <IconPlus size={ICON_SIZE.inline} />
                  {NEW_PLAN_LABEL}
                </Button>
              ),
            },
          }
        : {})}
    >
      {chipRow}
    </SectionHeader>
  );

  if (data !== null && !zero && !searching) mark('plan-tab:paint');
  // Boxes only while nothing is held for the tab (a kept or session value
  // paints at once); the cards settle once when they land after them.
  const searchBoxes =
    searching &&
    !(planSearch.status === 'error' && planSearch.data === null) &&
    (results === null || planSearch.data === null);
  // A borrowed read with nothing in the picked chip is not this chip's answer
  // yet: boxes until its own read lands, never the zero line.
  const borrowedEmpty = borrowed !== null && !bundles.some(inChip);
  const listBoxes =
    !onBank && !searching && load.status !== 'failed' && (data === null || borrowedEmpty);
  const hadBoxes = useHadBoxes(searchBoxes || listBoxes);
  const landedRef = useRef<HTMLDivElement>(null);
  const landed = searching ? results !== null && results.length > 0 : data !== null && !zero;
  useSettleOnLanding(landedRef, landed && !searchBoxes && !listBoxes, hadBoxes);
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
  } else if (searching) {
    body =
      planSearch.status === 'error' && planSearch.data === null ? (
        <ScreenFailed onRetry={planSearch.refresh} />
      ) : results === null || planSearch.data === null ? (
        <PlanTabBoxes />
      ) : (
        <PlanSearchResults
          bundles={results}
          thumbs={planSearch.data.thumbs}
          matchedItems={planSearch.data.matchedItems}
          query={planSearch.query}
          timeZone={timeZone}
          now={now}
          onOpenPlan={(planId) => navigate(`/plan/${planId}`)}
          onOpenItem={(planId, itemId) =>
            navigate(withNewestUnread(itemRoute(planId, itemId), 'plan_item', itemId))
          }
          filtersActive={chip !== 'all'}
          onClear={() => {
            setSearch('');
            setChip('all');
          }}
        />
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
    // Only the grouped All list has headings; elsewhere the boxes draw none (no shift on landing).
    body = <PlanTabBoxes heading={chip === 'all' && sort === PLAN_SORT_DEFAULT} />;
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
 * The chips under the search row, phone and laptop (Bank, This week, Next
 * week, Upcoming, Past, All), on the same line as Pipeline's stage chips so
 * switching tabs never moves the page. No counts: the list reads a page at a
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
