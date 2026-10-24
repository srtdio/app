// The Plan tab (/plan). Laptop (md and up): the page head "Plan" with Month |
// Week and, for creators, New plan; then the calendar (PlanCalendar) over the
// visible range. Phone: the head with a soft New plan (creators) and the plans
// as cards in sections (PlanTabList). Opening a plan or an item goes to
// /plan/:planId(?item=), which PlanBesideLayout docks beside this page on a
// laptop (the page stays mounted) and shows alone on a phone. New plan, Create
// plan and the empty-day menu's "+ New plan" open the existing New plan
// screen (plan_create_with_items: a Draft); nothing is ever posted to a chat.
// No plan at all shows the zero state (line 2 only until onboarding is done).
// Approvers see shared plans only, and never Create, drag or the day menu.

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlanComposeScreen } from '@/components/chat/PlanComposeScreen';
import { ScreenFailed } from '@/components/chat/PlanScreen';
import { postRoute } from '@/components/chat/post-card';
import { useInduction } from '@/components/induction/InductionProvider';
import { PageHead } from '@/components/shell/PageHead';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPlan } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { ComposeRange } from '@/lib/chat/plans';
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { useViewerSide } from '@/lib/chat/viewer-role';
import {
  CREATE_PLAN_BUTTON,
  MONTH_LABEL,
  NEW_PLAN_LABEL,
  PLAN_TAB_TITLE,
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
import { LAPTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';
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
  const desktop = useMediaQuery(LAPTOP_QUERY);
  const navigate = useNavigate();
  const { workspaceId, workspaces } = useWorkspace();
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  const { side, ready } = useViewerSide(workspaceId);
  const onboarded = onboardingFinished(useInduction()?.resolution.kind ?? null);
  const today = civilToday(new Date(), timeZone);
  const [view, setView] = useState<PlanTabView>('month');
  const [anchor, setAnchor] = useState(today);
  // The New plan screen: closed (null) or open with its dates (undefined: this week).
  const [compose, setCompose] = useState<{ range: ComposeRange | undefined } | null>(null);
  const [addTo, setAddTo] = useState<AddTarget | null>(null);
  const creator = canCreatePlans(side);
  const { load, reload, retry } = usePlanTabData({
    workspaceId,
    range: desktop ? visibleRange(view, anchor) : null,
    timeZone,
    onlyShared: !creator,
    enabled: ready,
  });
  const data = load.status === 'ready' ? load.data : null;
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

  const head = (
    <PageHead
      title={PLAN_TAB_TITLE}
      actions={
        <>
          {desktop ? <ViewSwitch view={view} onView={setView} /> : null}
          {creator && desktop ? (
            <Button variant="primary" data-plan-tab-new="" onClick={() => openCompose()}>
              {NEW_PLAN_LABEL}
            </Button>
          ) : null}
          {creator && !desktop ? (
            <Button
              variant="primary"
              type="button"
              data-plan-tab-new=""
              onClick={() => openCompose()}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {NEW_PLAN_LABEL}
            </Button>
          ) : null}
        </>
      }
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
          {...(copy.create
            ? {
                action: (
                  <Button variant="primary" onClick={() => openCompose()}>
                    {CREATE_PLAN_BUTTON}
                  </Button>
                ),
              }
            : {})}
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
      />
    );
  }

  return (
    <>
      {head}
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
        <button
          key={o.view}
          type="button"
          data-plan-tab-view={o.view}
          aria-pressed={props.view === o.view}
          onClick={() => props.onView(o.view)}
          className={cn(
            'h-11 min-w-[64px] px-3 text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            props.view === o.view ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
