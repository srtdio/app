// The Plan tab (/plan). Laptop (md and up): the shared top bar (no page title)
// with the legend on the left, Month | Week and, for creators, New plan on the
// right; then the calendar, fitted to the window
// (PlanCalendar) over the visible range. Phone: the top bar with New plan
// (creators) and the plans as cards in sections (PlanTabList). Both read a
// page of plans at a time (usePlanTabData): while more remain, the page hands
// the list or the calendar its Load more (the hook's loadMore and moreBusy). Opening a plan or an item goes to
// /plan/:planId(?item=), which PlanBesideLayout docks beside this page on a
// laptop (the page stays mounted) and shows alone on a phone. New plan and the
// empty-day menu's "+ New plan" open the existing New plan screen
// (plan_create_with_items: a Draft); nothing is ever posted to a chat. No plan
// at all shows the zero state (line 2 only until onboarding is done), with no
// create button of its own: the top bar's New plan is the one.
// Approvers see shared plans only, and never Create, drag or the day menu.
// A return to the tab lands on the same Month | Week, the same range and the
// same scroll (src/lib/kept-view.ts), over the range's kept read.
// The Bank (the idea bank, plan-tab/BankList.tsx): on the phone the first chip
// (Bank, This week, Next week, Upcoming, Past, All; the tab still opens on
// This week), whose toolbar is search, Filter and sort, then Add idea; on a
// laptop a toggle chip after the plan chips that opens ui/SidePanel beside
// the calendar (Expand swaps the calendar for the Bank table). ?week=bank
// lands on it. A client sees it only when their bank read holds
// an idea. The Bank reads after the tab paints (use-bank-data.ts).
// Search (?q=, both widths, src/lib/search/server-search.ts): from 2
// characters, plan_search then the matched plans in one plan_bundle_read, shown
// as a list of plans with their matched items (tapping an item opens it in its
// plan, as the calendar does). Sort (Newest first, Oldest first, Name) orders
// the phone list and the search results, never the laptop calendar.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { postRoute } from '@/components/chat/post-card';
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
import { Input } from '@/components/ui/Input';
import { ICON_SIZE, IconBank, IconFilterLines, IconPlan, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ComposeRange, PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { queryWords } from '@/lib/chat/search';
import { keptViewKey, useKeptScroll, useKeptState } from '@/lib/kept-view';
import { safeTimeZone } from '@/lib/time';
import { useViewerSide } from '@/lib/chat/viewer-role';
import {
  MONTH_LABEL,
  NEW_PLAN_LABEL,
  WEEK_LABEL,
  canCreatePlans,
  onboardingFinished,
  visibleBundles,
  visibleRange,
  zeroStateCopy,
  PLAN_BANK_CHIP,
  PLAN_BANK_CHIP_LABEL,
  PLAN_WEEK_CHIP_DEFAULT,
  PLAN_WEEK_CHIP_ZERO,
  PLAN_WEEK_PARAM,
  parsePlanWeekChip,
  planSectionOf,
  visiblePlanChips,
  planWeekChipLabel,
  planWeekChipRange,
  type CalendarEntry,
  type PlanTabView,
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
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useSort } from '@/lib/use-sort';
import { useWorkspace } from '@/lib/workspace-context';
import { PlanCalendar, PlanTabLegend } from './plan-tab/PlanCalendar';
import { PlanTabAdd, type AddTarget } from './plan-tab/PlanTabAdd';
import {
  PlanTabBoxes,
  PlanTabCard,
  PlanTabList,
  PlanTabLoadMore,
  planCovers,
  type PlanTabMore,
} from './plan-tab/PlanTabList';
import { usePlanTabData, warmPlanTabRead } from './plan-tab/use-plan-tab-data';
import { BankAddSheet } from './plan-tab/BankAddSheet';
import { BankFilterSheet } from './plan-tab/BankFilterSheet';
import { BankFilterLine, BankPanel, BankSurface, type BankDropRequest } from './plan-tab/BankList';
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

/** The route a calendar entry opens: its item in its plan, or a post's page. Pure. */
export function entryRoute(entry: CalendarEntry): string {
  return entry.kind === 'item'
    ? itemRoute(entry.bundle.plan.id, entry.item.id)
    : postRoute(entry.post.id);
}

/** The route an item opens: the item in its plan (the calendar's and the search's). Pure. */
export function itemRoute(planId: string, itemId: string): string {
  return `/plan/${planId}?item=${itemId}`;
}

/**
 * A calendar or list open with unread comments lands on the newest one (the
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
 * Plan search results: one card per plan (the phone list's card), in the
 * sort's order, each followed by its matched items, the searched words marked;
 * a card opens its plan, an item opens in its plan. Zero matches: NoResults.
 */
export function PlanSearchResults(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  matchedItems: Readonly<Record<string, string[]>>;
  query: string;
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
    <div data-plan-tab-results="" className="flex flex-col gap-2 px-4 pb-8 pt-4 md:px-6">
      {props.bundles.map((bundle) => {
        const id = bundle.plan.id;
        const items = (props.matchedItems[id] ?? []).flatMap((itemId) => {
          const title = matchedItemTitle(bundle, itemId);
          return title !== null ? [{ itemId, title }] : [];
        });
        return (
          <div key={id} className="flex flex-col gap-1">
            <PlanTabCard
              bundle={bundle}
              covers={planCovers(bundle, props.thumbs)}
              onOpen={() => props.onOpenPlan(id)}
            />
            {items.map(({ itemId, title }) => (
              <PressableRow
                key={itemId}
                type="button"
                data-plan-tab-match={itemId}
                onClick={() => props.onOpenItem(id, itemId)}
                className="flex items-center px-3.5 text-base text-fg"
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

/** The phone list in a flat order (Newest first, Name), with the same Load more. */
function PlanTabFlatList(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  onOpen: (planId: string) => void;
  more: PlanTabMore | null;
}): ReactElement {
  return (
    <div data-plan-tab-list="" className="flex flex-col gap-2 px-4 pb-8 pt-4">
      {props.bundles.length === 0 ? (
        <div data-plan-tab-chip-zero="">
          <EmptyState icon={<IconPlan size={ICON_SIZE.tray} />} title={PLAN_WEEK_CHIP_ZERO} />
        </div>
      ) : null}
      {props.bundles.map((bundle) => (
        <PlanTabCard
          key={bundle.plan.id}
          bundle={bundle}
          covers={planCovers(bundle, props.thumbs)}
          onOpen={() => props.onOpen(bundle.plan.id)}
        />
      ))}
      {props.more !== null ? <PlanTabLoadMore more={props.more} /> : null}
    </div>
  );
}

export function PlanTabPage(): ReactElement {
  const desktop = useIsLaptop();
  const navigate = useNavigate();
  mark('plan-tab:mount');
  const { workspaceId, workspaces } = useWorkspace();
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side, ready } = useViewerSide(workspaceId);
  if (ready) mark('plan-tab:side');
  const onboarded = onboardingFinished(useInduction()?.resolution.kind ?? null);
  const today = civilToday(new Date(), timeZone);
  const userId = useSession().session?.user.id ?? null;
  const keptKey = (what: string): string | null =>
    userId !== null && workspaceId !== null
      ? keptViewKey(userId, workspaceId, `plan-tab:${what}`)
      : null;
  const [view, setView] = useKeptState<PlanTabView>(keptKey('view'), 'month');
  const [anchor, setAnchor] = useKeptState(keptKey('anchor'), today);
  // The New plan screen: closed (null) or open with its dates (undefined: this week).
  const [compose, setCompose] = useState<{ range: ComposeRange | undefined } | null>(null);
  const [addTo, setAddTo] = useState<AddTarget | null>(null);
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
  // The phone's week chip: in the URL (?week=) so Back lands on it, else this
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
  // The Bank (both widths share one hook). Laptop: the side panel's open
  // state and Expand; ?week=bank opens the panel.
  const [bankOpen, setBankOpen] = useKeptState(keptKey('bank-open'), false);
  const [bankExpanded, setBankExpanded] = useState(false);
  const [bankSearchLaptop, setBankSearchLaptop] = useState('');
  const urlBank = parsePlanWeekChip(params.get(PLAN_WEEK_PARAM)) === PLAN_BANK_CHIP;
  useEffect(() => {
    if (desktop && urlBank) setBankOpen(true);
  }, [desktop, urlBank, setBankOpen]);
  const onBank = desktop ? bankOpen || bankExpanded : chip === PLAN_BANK_CHIP;
  const [storedBankFilter, setBankFilter] = useKeptState<BankFilter>(
    keptKey('bank-filter'),
    BANK_FILTER_DEFAULT,
  );
  const bankFilter = useMemo(() => sanitizeBankFilter(storedBankFilter), [storedBankFilter]);
  const [bankSheet, setBankSheet] = useState<'filter' | 'add' | null>(null);
  const [bankDrop, setBankDrop] = useState<BankDropRequest | null>(null);
  const { value: storedSort, setValue: setSort } = useSort<PlanTabSort>('plan', PLAN_SORT_DEFAULT);
  const sort = sanitizePlanSort(storedSort);
  const onPhoneBank = !desktop && chip === PLAN_BANK_CHIP;
  const planSearch = useServerSearch<PlanSearchData>(
    onPhoneBank ? '' : search,
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
    searchText: desktop ? bankSearchLaptop : onPhoneBank ? search : '',
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
  const { load, reload, retry, loadMore, moreBusy } = usePlanTabData({
    workspaceId,
    range: desktop ? visibleRange(view, anchor) : planWeekChipRange(chip, today),
    onlyShared: !creator,
    enabled: ready,
  });
  // The chip's own read. On the phone a chip whose read is still on its way
  // paints at once from the last read this mount held (narrowed to the chip),
  // and its own read replaces it when it lands (speed rule: paint what the
  // device holds, fetch the rest behind it). Never across workspaces or sides.
  const own = load.status === 'ready' ? load.data : null;
  const heldKey = `${workspaceId ?? ''}:${String(creator)}`;
  const held = useRef<{ key: string; data: PlanTabData } | null>(null);
  if (own !== null && !desktop) held.current = { key: heldKey, data: own };
  const borrowed =
    own === null && !desktop && load.status === 'loading' && held.current?.key === heldKey
      ? held.current.data
      : null;
  const data = own ?? borrowed;
  useKeptScroll(keptKey('scroll'), data !== null);
  // Load more belongs to the chip's own read only.
  const more = useMemo(
    () => (own !== null && own.nextCursor !== null ? { busy: moreBusy, onMore: loadMore } : null),
    [own, moreBusy, loadMore],
  );
  // After This week or Next week paints on the phone, every plan is read once
  // behind it (one request, not on a paint or tap path), so All, Upcoming and
  // Past paint at once when tapped.
  const weekRead = planWeekChipRange(chip, today) !== null;
  const ownReady = own !== null;
  useEffect(() => {
    if (desktop || !ownReady || !weekRead || workspaceId === null) return;
    warmPlanTabRead({ workspaceId, range: null, onlyShared: !creator });
  }, [desktop, ownReady, weekRead, workspaceId, creator]);
  const bundles = useMemo(
    () => (data !== null ? visibleBundles(data.bundles, side) : []),
    [data, side],
  );
  // The phone's chip narrows the list and the search results to its week group.
  const inChip = useCallback(
    (b: PlanBundle): boolean => desktop || chip === 'all' || planSectionOf(b.plan, today) === chip,
    [desktop, chip, today],
  );
  const calendarData = useMemo(
    () => (data !== null ? { bundles, posts: data.posts, thumbs: data.thumbs } : null),
    [data, bundles],
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
  // search; on a laptop the legend, then the Month | Week switch (and, while
  // searching, the results' sort), then New plan for creators; on a phone the
  // sort, then New plan.
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
  const chipRow = desktop ? undefined : (
    <PlanWeekChips chip={chip} onChip={setChip} showBank={showBank} />
  );
  const head = onPhoneBank ? (
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
      sort={
        desktop
          ? {
              node: (
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <PlanTabLegend />
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <ViewSwitch view={view} onView={setView} />
                    {searching ? sortMenu : null}
                  </div>
                </div>
              ),
            }
          : { node: sortMenu }
      }
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
    !onPhoneBank &&
    !searching &&
    load.status !== 'failed' &&
    !desktop &&
    (data === null || borrowedEmpty);
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
          getPlans: () => readPlansForPlanIt(workspaceId, today),
          onOpenIdea: openIdea,
          epoch: `${chip}:${String(bankExpanded)}`,
        }
      : null;
  const laptopBankToolbar = (
    <div data-bank-toolbar="" className="flex items-center gap-2 px-4 pt-2 md:px-0">
      <Input
        tone="search"
        type="search"
        aria-label="Search ideas"
        placeholder="Search ideas"
        value={bankSearchLaptop}
        onChange={(e) => setBankSearchLaptop(e.target.value)}
        className="min-w-0 flex-1"
      />
      {filterButton}
      {creator ? (
        <IconButton
          label="Add idea"
          data-bank-add-open=""
          onClick={() => setBankSheet('add')}
          className="shrink-0 bg-accent text-accent-fg lit-pill hover:text-accent-fg"
        >
          <IconPlus size={ICON_SIZE.control} />
        </IconButton>
      ) : null}
    </div>
  );
  const bankLine = (
    <BankFilterLine
      filter={bankFilter}
      buckets={bankBuckets.buckets}
      onFilter={setBankFilter}
      onClear={() => setBankFilter(BANK_FILTER_DEFAULT)}
    />
  );
  let body: ReactElement;
  if (onPhoneBank && bankSurfaceProps !== null) {
    body = (
      <>
        {bankLine}
        <BankSurface layout="phone" {...bankSurfaceProps} />
      </>
    );
  } else if (desktop && bankExpanded && bankSurfaceProps !== null) {
    body = (
      <BankSurface
        layout="table"
        {...bankSurfaceProps}
        onCollapse={() => setBankExpanded(false)}
        toolbar={
          <div className="flex flex-col gap-1">
            {laptopBankToolbar}
            {bankLine}
          </div>
        }
      />
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
          onOpenPlan={(planId) => navigate(`/plan/${planId}`)}
          onOpenItem={(planId, itemId) =>
            navigate(withNewestUnread(itemRoute(planId, itemId), 'plan_item', itemId))
          }
          filtersActive={!desktop && chip !== 'all'}
          onClear={() => {
            setSearch('');
            if (!desktop) setChip('all');
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
  } else if (desktop) {
    body = (
      <PlanCalendar
        view={view}
        anchor={anchor}
        today={today}
        timeZone={timeZone}
        side={side}
        data={calendarData}
        onAnchor={setAnchor}
        onWeekOf={(day) => {
          setView('week');
          setAnchor(day);
        }}
        onOpen={(entry) =>
          navigate(
            entry.kind === 'item'
              ? withNewestUnread(entryRoute(entry), 'plan_item', entry.item.id)
              : withNewestUnread(entryRoute(entry), 'post', entry.post.id),
          )
        }
        onAddTo={setAddTo}
        onNewPlan={openCompose}
        reload={reload}
        more={more}
        {...(showBank
          ? {
              bankChip: (
                <Chip
                  type="button"
                  label={PLAN_BANK_CHIP_LABEL}
                  selected={bankOpen}
                  data-plan-tab-bank-chip=""
                  dot={<IconBank size={ICON_SIZE.inline} />}
                  onClick={() => setBankOpen(!bankOpen)}
                  className="shrink-0"
                />
              ),
            }
          : {})}
        {...(bankOpen && creator
          ? {
              onBankDrop: (ideaId: string, day: string) =>
                setBankDrop((prev) => ({ ideaId, day, nonce: (prev?.nonce ?? 0) + 1 })),
            }
          : {})}
      />
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
      {desktop && bankSurfaceProps !== null && showBank ? (
        <BankPanel
          open={bankOpen && !bankExpanded}
          onClose={() => setBankOpen(false)}
          onExpand={() => {
            setBankExpanded(true);
            setBankOpen(false);
          }}
          surface={{ ...bankSurfaceProps, drop: bankDrop }}
          toolbar={
            <div className="flex flex-col gap-1 px-4">
              {laptopBankToolbar}
              {bankLine}
            </div>
          }
        />
      ) : null}
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
        <>
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
          <PlanTabAdd target={addTo} timeZone={timeZone} onClose={() => setAddTo(null)} />
        </>
      ) : null}
    </>
  );
}

/**
 * The phone's chips under the search row (Bank, This week, Next week,
 * Upcoming, Past, All), on the same line as Pipeline's stage chips so
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

/** Month | Week (laptop). */
function ViewSwitch(props: {
  view: PlanTabView;
  onView: (view: PlanTabView) => void;
}): ReactElement {
  const options: Array<{ view: PlanTabView; label: string }> = [
    { view: 'month', label: MONTH_LABEL },
    { view: 'week', label: WEEK_LABEL },
  ];
  return (
    <div className="lit-well flex overflow-hidden rounded-lg border border-field bg-panel-2">
      {options.map((o) => (
        <ViewOption
          key={o.view}
          view={o.view}
          label={o.label}
          picked={props.view === o.view}
          onView={props.onView}
        />
      ))}
    </div>
  );
}

/** One Month | Week option: the pick is the solid ink fill. */
function ViewOption(props: {
  view: PlanTabView;
  label: string;
  picked: boolean;
  onView: (view: PlanTabView) => void;
}): ReactElement {
  return (
    <PressableRow
      inline
      flat
      align="center"
      type="button"
      data-plan-tab-view={props.view}
      data-selected={props.picked ? 'true' : undefined}
      aria-pressed={props.picked}
      onClick={() => props.onView(props.view)}
      className={cn(
        'min-w-[64px] border px-3 text-base font-medium mv-tint focus-visible:-outline-offset-2',
        props.picked
          ? 'border-transparent bg-accent text-accent-fg lit-pill'
          : 'border-transparent text-fg-2 hover:text-fg',
      )}
    >
      {props.label}
    </PressableRow>
  );
}
