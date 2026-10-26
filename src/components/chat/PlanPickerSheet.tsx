// "Plans", the agency's Plan tile: this workspace's upcoming plans (not
// deleted, ending today or later in the workspace zone, ending soonest first,
// at most 100), one plans select then their bundles through the batched plan
// reads, never one read per plan. Each row: the plan icon, title, date range
// in mono, chips (concepts, posts, "Draft", "In this chat") and a chevron; the
// last row opens the New plan screen. A tap opens that plan's Plan screen
// (the same as a card's "Open plan"); this sheet never sends. The body keeps
// one fixed height in every state: a skeleton until the read settles, so the
// list never reorders or shortens. Tokens only; translateY motion only.

import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconChevronRight, IconPlan, IconPlus } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useScreenRead } from '@/components/chat/PlanScreen';
import {
  pickerChips,
  planRangeLabel,
  todayInZone,
  type PlanChip,
} from '@/components/chat/plan-card';
import { readUpcomingPlans, type PlanBundle } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';

export const PICKER_TITLE = 'Plans';
export const PICKER_EMPTY = 'Upcoming plans show up here.';
export const NEW_PLAN_LABEL = 'New plan';

/**
 * The list's fixed height in every state (loading, list, empty, error); at sm+
 * it fills the sheet's fixed box instead.
 */
const BODY_BOX =
  'flex h-[min(420px,56vh)] flex-col overflow-y-auto overscroll-contain sm:h-auto sm:min-h-0 sm:flex-1';

/** Skeleton rows while the list loads: enough to fill the fixed body. */
const SKELETON_ROWS = 5;

const CHIP_TONES: Record<PlanChip['tone'], string> = {
  neutral: 'bg-panel-2 text-fg-2',
  warn: 'border-warn bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent',
};

/** The upcoming plans in list order, and whether each is already in this chat. Pure. */
export function pickerRows(
  plans: readonly PlanBundle[],
  inChat: ReadonlySet<string>,
): Array<{ bundle: PlanBundle; chips: PlanChip[] }> {
  return plans.map((bundle) => ({
    bundle,
    chips: pickerChips(bundle, inChat.has(bundle.plan.id)),
  }));
}

export function PlanPickerSheet(props: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  timeZone: string;
  /** Plans this chat already holds a card for (loaded thread and ticker). */
  inChatPlanIds: readonly string[];
  onClose: () => void;
  onNewPlan: () => void;
  /** A row was tapped: open that plan's Plan screen (never a send). */
  onOpenPlan: (planId: string) => void;
}): ReactElement {
  const { workspaceId, timeZone } = props;
  // Fixed per open: the day the list was asked for.
  const today = useMemo(
    () => todayInZone(new Date(), timeZone),
    // A new day starts with the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.open, timeZone],
  );
  const { read, reload } = useScreenRead<PlanBundle[]>(
    props.open,
    `${workspaceId}:${today}`,
    (signal) => readUpcomingPlans(supabase, workspaceId, today, signal),
  );
  const inChat = useMemo(() => new Set(props.inChatPlanIds), [props.inChatPlanIds]);

  return (
    <Sheet open={props.open} onClose={props.onClose} title={PICKER_TITLE} fixedHeight>
      <div
        data-plan-picker=""
        className={cn('-mx-[18px] -my-4 sm:flex sm:min-h-0 sm:flex-1 sm:flex-col', NO_TOUCH_SELECT)}
      >
        <p className="px-[18px] pb-1 pt-3 text-sm leading-4 text-fg-3">
          Upcoming plans in {props.workspaceName}
        </p>
        <div className={BODY_BOX}>
          {read.status === 'loading' ? (
            <div role="status" aria-busy="true" aria-label="Loading plans" className="px-[18px]">
              {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                <PickerSkeletonRow key={i} />
              ))}
            </div>
          ) : read.status === 'error' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-[18px] text-center">
              <p className="text-base text-fg-2">Couldn&apos;t load. Try again.</p>
              <Button type="button" variant="link" onClick={reload}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex flex-col px-[18px] pb-4">
              {read.data.length === 0 ? (
                <div data-plan-picker-empty="" className="pb-4 pt-6 text-center">
                  <p className="text-base leading-5 text-fg-2">{PICKER_EMPTY}</p>
                </div>
              ) : (
                pickerRows(read.data, inChat).map(({ bundle, chips }) => (
                  <PressableRow
                    key={bundle.plan.id}
                    flat
                    type="button"
                    data-plan-pick={bundle.plan.id}
                    onClick={() => {
                      props.onClose();
                      props.onOpenPlan(bundle.plan.id);
                    }}
                    className="flex min-h-[72px] items-center gap-3 border-b border-border py-3"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <IconPlan size={ICON_SIZE.control} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-lg font-semibold leading-5 text-fg">
                        {bundle.plan.title}
                      </span>
                      <span className="font-mono text-sm leading-4 text-fg-3">
                        {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {chips.map((chip) => (
                          <span
                            key={chip.label}
                            data-plan-chip={chip.tone}
                            className={cn(
                              'inline-flex min-h-[20px] items-center rounded-lg border border-transparent px-1.5 text-xs',
                              CHIP_TONES[chip.tone],
                            )}
                          >
                            {chip.label}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="shrink-0 text-fg-3">
                      <IconChevronRight />
                    </span>
                  </PressableRow>
                ))
              )}
              <PressableRow
                type="button"
                data-plan-pick-new=""
                onClick={() => {
                  props.onClose();
                  props.onNewPlan();
                }}
                className="flex min-h-[48px] items-center gap-3 py-2 text-lg font-semibold text-accent"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-panel-2">
                  <IconPlus size={ICON_SIZE.control} />
                </span>
                <span className="flex-1">{NEW_PLAN_LABEL}</span>
                <span className="shrink-0 text-fg-3">
                  <IconChevronRight />
                </span>
              </PressableRow>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** A placeholder with a plan row's box, so the rows swap in without a shift. */
function PickerSkeletonRow(): ReactElement {
  return (
    <div
      data-plan-pick-skeleton=""
      className="flex min-h-[72px] w-full items-center gap-3 border-b border-border py-3"
    >
      <span className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-panel-2" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="h-5 w-40 animate-pulse rounded bg-panel-2" />
        <span className="h-4 w-24 animate-pulse rounded bg-panel-2" />
        <span className="h-5 w-32 animate-pulse rounded bg-panel-2" />
      </span>
    </div>
  );
}
