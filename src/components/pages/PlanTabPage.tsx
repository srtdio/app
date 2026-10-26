// The Plan tab (/plan). Laptop (md and up): the shared top bar (no page title)
// with Month | Week and, for creators, New plan; then the calendar
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

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { postRoute } from '@/components/chat/post-card';
import { useInduction } from '@/components/induction/InductionProvider';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPlan, IconPlus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ComposeRange } from '@/lib/chat/plans';
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
import { civilToday } from '@/lib/plan-week';
import { useSession } from '@/lib/session-context';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useWorkspace } from '@/lib/workspace-context';
import { PlanCalendar } from './plan-tab/PlanCalendar';
import { PlanTabAdd, type AddTarget } from './plan-tab/PlanTabAdd';
import { PlanTabList } from './plan-tab/PlanTabList';
import { usePlanTabData } from './plan-tab/use-plan-tab-data';

/** The route a calendar entry opens: its item in its plan, or a post's page. Pure. */
export function entryRoute(entry: CalendarEntry): string {
  return entry.kind === 'item'
    ? `/plan/${entry.bundle.plan.id}?item=${entry.item.id}`
    : postRoute(entry.post.id);
}

export function PlanTabPage(): ReactElement {
  const desktop = useIsLaptop();
  const navigate = useNavigate();
  const { workspaceId, workspaces } = useWorkspace();
  const timeZone = safeTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side, ready } = useViewerSide(workspaceId);
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

  // No page title (as Pipeline and Briefs): the shared top bar carries the
  // laptop Month | Week switch, then New plan for creators, right-aligned.
  const head = (
    <SectionHeader
      {...(desktop
        ? {
            sort: {
              node: (
                <div className="ml-auto">
                  <ViewSwitch view={view} onView={setView} />
                </div>
              ),
            },
          }
        : {})}
      {...(creator
        ? {
            primaryAction: {
              node: (
                <Button
                  variant="primary"
                  type="button"
                  data-plan-tab-new=""
                  onClick={() => openCompose()}
                  className={cn('shrink-0 whitespace-nowrap', !desktop && 'ml-auto')}
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

  let body: ReactElement;
  if (load.status === 'failed') {
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
    body = <div data-plan-tab-loading="" className="min-h-[320px]" />;
  } else {
    body = (
      <PlanTabList
        bundles={bundles}
        thumbs={data.thumbs}
        today={today}
        onOpen={(planId) => navigate(`/plan/${planId}`)}
        more={more}
      />
    );
  }

  return (
    <>
      {desktop || creator ? head : null}
      {body}
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
    <div className="flex overflow-hidden rounded-lg border border-border bg-panel-2">
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
            'min-w-[64px] px-3 text-base font-medium transition-colors duration-fast focus-visible:ring-inset',
            props.view === o.view ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </PressableRow>
      ))}
    </div>
  );
}
