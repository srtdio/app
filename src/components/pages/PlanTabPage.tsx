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
// Search (?q=, both widths, src/lib/search/server-search.ts): from 2
// characters, plan_search then the matched plans in one plan_bundle_read, shown
// as a list of plans with their matched items (tapping an item opens it in its
// plan, as the calendar does). Sort (Newest first, Oldest first, Name) orders
// the phone list and the search results, never the laptop calendar.

import { mark } from '@/lib/perf-marks';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useHadBoxes, useSettleOnLanding } from '@/lib/motion';
import type { ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { postRoute } from '@/components/chat/post-card';
import { useInduction } from '@/components/induction/InductionProvider';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { Highlight } from '@/components/ui/SearchHighlight';
import { SortMenu } from '@/components/ui/SortMenu';
import { ICON_SIZE, IconPlan, IconPlus } from '@/components/ui/icons';
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
  type CalendarEntry,
  type PlanTabView,
} from '@/lib/plan-tab';
import {
  PLAN_SORT_DEFAULT,
  PLAN_SORT_OPTIONS,
  sanitizePlanSort,
  searchPlanTab,
  sortPlanBundles,
  type PlanSearchData,
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
import { usePlanTabData } from './plan-tab/use-plan-tab-data';

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
  onClear: () => void;
}): ReactElement {
  const words = queryWords(props.query);
  if (props.bundles.length === 0) {
    return <NoResults query={props.query} filtersActive={false} onClear={props.onClear} />;
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
  const { value: storedSort, setValue: setSort } = useSort<PlanTabSort>('plan', PLAN_SORT_DEFAULT);
  const sort = sanitizePlanSort(storedSort);
  const planSearch = useServerSearch<PlanSearchData>(
    search,
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
  const { load, reload, retry, loadMore, moreBusy } = usePlanTabData({
    workspaceId,
    range: desktop ? visibleRange(view, anchor) : null,
    onlyShared: !creator,
    enabled: ready,
  });
  const data = load.status === 'ready' ? load.data : null;
  useKeptScroll(keptKey('scroll'), data !== null);
  const more = useMemo(
    () => (data !== null && data.nextCursor !== null ? { busy: moreBusy, onMore: loadMore } : null),
    [data, moreBusy, loadMore],
  );
  const bundles = useMemo(
    () => (data !== null ? visibleBundles(data.bundles, side) : []),
    [data, side],
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
        ? sortPlanBundles(visibleBundles(planSearch.data.bundles, side), sort)
        : null,
    [planSearch.data, side, sort],
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
  const head = (
    <SectionHeader<PlanTabSort>
      search={{ value: search, onChange: setSearch, placeholder: 'Search plans' }}
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
    />
  );

  if (data !== null && !zero && !searching) mark('plan-tab:paint');
  // Boxes only while nothing is held for the tab (a kept or session value
  // paints at once); the cards settle once when they land after them.
  const searchBoxes =
    searching &&
    !(planSearch.status === 'error' && planSearch.data === null) &&
    (results === null || planSearch.data === null);
  const listBoxes = !searching && load.status !== 'failed' && !desktop && data === null;
  const hadBoxes = useHadBoxes(searchBoxes || listBoxes);
  const landedRef = useRef<HTMLDivElement>(null);
  const landed = searching ? results !== null && results.length > 0 : data !== null && !zero;
  useSettleOnLanding(landedRef, landed && !searchBoxes && !listBoxes, hadBoxes);
  let body: ReactElement;
  if (searching) {
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
          onOpenItem={(planId, itemId) => navigate(itemRoute(planId, itemId))}
          onClear={() => setSearch('')}
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
        onOpen={(entry) => navigate(entryRoute(entry))}
        onAddTo={setAddTo}
        onNewPlan={openCompose}
        reload={reload}
        more={more}
      />
    );
  } else if (data === null) {
    body = <PlanTabBoxes />;
  } else if (sort === PLAN_SORT_DEFAULT) {
    body = (
      <PlanTabList
        bundles={bundles}
        thumbs={data.thumbs}
        today={today}
        onOpen={(planId) => navigate(`/plan/${planId}`)}
        more={more}
      />
    );
  } else {
    body = (
      <PlanTabFlatList
        bundles={sortPlanBundles(bundles, sort)}
        thumbs={data.thumbs}
        onOpen={(planId) => navigate(`/plan/${planId}`)}
        more={more}
      />
    );
  }

  return (
    <>
      {head}
      <div ref={landedRef} className="contents">
        {body}
      </div>
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
    <div className="lit-well flex overflow-hidden rounded-lg border border-border bg-panel-2">
      {options.map((o) => (
        <PressableRow
          key={o.view}
          inline
          flat
          align="center"
          type="button"
          data-plan-tab-view={o.view}
          aria-pressed={props.view === o.view}
          onClick={() => props.onView(o.view)}
          className={cn(
            'min-w-[64px] border px-3 text-base font-medium mv-tint focus-visible:-outline-offset-2',
            props.view === o.view
              ? 'lit-selected'
              : 'border-transparent text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </PressableRow>
      ))}
    </div>
  );
}
