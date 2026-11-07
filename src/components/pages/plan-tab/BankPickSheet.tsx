// From bank (agency): the third Add entry after New concept and Pick a post,
// on the Plan screen's Add sheet, the Plan tab's Add sheet and the laptop
// empty-day menu. A Sheet over the bank's live ideas, starred first, then
// Recently active, 12 a page with Load more. It reads when it opens
// (readBankPage: the same plan_items select the Bank chip makes, plus its one
// read per table for the page), never before. Search is the palette in pick
// mode (the header's search button, bank ideas only); its pick takes the same
// path as a tap (an idea not on the loaded page is first found by its title
// with searchBank). A tap puts the idea on that day:
// one plan_item_from_bank. The plan: the one the Add came from; from the day
// menu the plans covering the day (one places at once, several open the
// Bank's plan picker, none offers Make plan). Into a shared plan an idea the
// client cannot see asks first (PR 816's "{plan} is shared with approvers"
// sheet). Done: "Planned in {plan}, {date}" with Undo (plan_item_to_bank).
// A planned idea starts with no review ("Not checked yet"). Tokens only;
// rows are lit-card cards, the sheet lit-overlay (ui/Sheet).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Bone } from '@/lib/motion';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconStarFilled } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { withReadTimeout } from '@/lib/chat-reads';
import {
  dispatchPlanChanged,
  readBankPage,
  searchBank,
  type BankCursor,
  type BankIdea,
  type BankQuery,
  type PlanRow,
} from '@/lib/chat/plans';
import { errorText } from '@/lib/error-copy';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import type { WorkspaceHit } from '@/lib/search/workspace-search';
import { supabase } from '@/lib/supabase';
import { PalettePickButton } from '@/components/shell/CommandPalette';
import { BankPlanItSheets, BankThumb, type PlanItStep } from './BankList';
import {
  ideaFormatLine,
  needsSharedWarning,
  planItChoice,
  planItError,
  plannedToast,
} from './bank-parts';
import { PlanTabLoadMore } from './PlanTabList';
import { makeWeekPlan, placeBankIdea, readPlansForPlanIt, unplanBankIdea } from './use-bank-data';

/** The sheet's title. */
export const FROM_BANK_LABEL = 'From bank';
/** The Add sheet row's line under it. */
export const FROM_BANK_SUB = 'Put an idea from the bank on this day.';
/** The header's search button (the palette in pick mode, bank ideas only). */
export const FROM_BANK_SEARCH = 'Search the bank';
/** The zero line (no ideas in the bank). */
export const FROM_BANK_ZERO = 'Ideas show up here.';

/** The bank as From bank reads it: live ideas, Recently active, starred first. Pure. */
export function fromBankQuery(workspaceId: string): BankQuery {
  return { workspaceId, sort: 'active', bucketId: null, archived: false, staleBefore: null };
}

/**
 * The bank idea a palette pick names (a plan item with no plan): the loaded
 * row when it is on the page (`idea`), else the hit to find by title. Null
 * when the pick is not a bank idea. Pure.
 */
export function bankPickOf(
  hits: readonly WorkspaceHit[],
  loaded: readonly BankIdea[],
): { idea: BankIdea } | { find: WorkspaceHit } | null {
  const hit = hits.find(
    (h) => h.kind === 'plan_item' && (h.parentId === null || h.parentId === ''),
  );
  if (hit === undefined) return null;
  const idea = loaded.find((i) => i.id === hit.id);
  return idea !== undefined ? { idea } : { find: hit };
}

/** What a tap on an idea does next. */
export type FromBankStep =
  | { kind: 'past' }
  | { kind: 'place'; plan: PlanRow }
  | { kind: 'shared'; plan: PlanRow }
  | { kind: 'none' }
  | { kind: 'several'; plans: PlanRow[] };

/**
 * The branch for a picked idea on a day: a past day is refused; one plan
 * places (a shared plan with a team-only idea asks first); none offers Make
 * plan; several open the plan picker. Pure.
 */
export function fromBankStep(
  plans: readonly PlanRow[],
  day: string,
  today: string,
  idea: Pick<BankIdea, 'show_to_client'>,
): FromBankStep {
  const choice = planItChoice(plans, day, today);
  switch (choice.kind) {
    case 'past':
      return { kind: 'past' };
    case 'none':
      return { kind: 'none' };
    case 'several':
      return { kind: 'several', plans: choice.plans };
    default:
      return needsSharedWarning(choice.plan, idea)
        ? { kind: 'shared', plan: choice.plan }
        : { kind: 'place', plan: choice.plan };
  }
}

/** A day for the header "+" (no day): today when the plan holds it, else its first day. Pure. */
export function fromBankDay(plan: Pick<PlanRow, 'starts_on' | 'ends_on'>, today: string): string {
  if (today >= plan.starts_on && today <= plan.ends_on) return today;
  return today < plan.starts_on ? plan.starts_on : plan.ends_on;
}

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; ideas: BankIdea[]; next: BankCursor | null; busy: boolean };

export function BankPickSheet(props: {
  open: boolean;
  workspaceId: string | null;
  /** The day the idea goes on. */
  day: string;
  today: string;
  /**
   * The plans to place into: the Add's own plan, or the day menu's plans
   * covering the day. Null: read the open plans on the tap (readPlansForPlanIt).
   */
  plans: readonly PlanRow[] | null;
  onClose: () => void;
}): ReactElement {
  const { open, workspaceId } = props;
  const showToast = useToast().show;
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [step, setStep] = useState<PlanItStep | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const readFirst = useCallback((): void => {
    if (workspaceId === null) return;
    seq.current += 1;
    const mine = seq.current;
    setLoad({ status: 'loading' });
    mark('plan:from-bank:read:start');
    void withReadTimeout((signal) =>
      readBankPage(supabase, fromBankQuery(workspaceId), null, signal),
    ).then((res) => {
      mark('plan:from-bank:read:end');
      if (mine !== seq.current) return;
      if (!res.ok) {
        logger.warn('plan: from bank read failed', {
          workspace_id: workspaceId,
          error: res.error.message,
        });
        setLoad({ status: 'failed' });
        return;
      }
      setLoad({ status: 'ready', ideas: res.data.ideas, next: res.data.nextCursor, busy: false });
    });
  }, [workspaceId]);

  // The read starts when the sheet opens, never before.
  useEffect(() => {
    if (!open) return;
    setStep(null);
    readFirst();
  }, [open, readFirst]);

  const more = (): void => {
    if (workspaceId === null || load.status !== 'ready' || load.next === null || load.busy) return;
    const shown = load;
    const mine = seq.current;
    setLoad({ ...shown, busy: true });
    void withReadTimeout((signal) =>
      readBankPage(supabase, fromBankQuery(workspaceId), shown.next, signal),
    ).then((res) => {
      if (mine !== seq.current) return;
      if (!res.ok) {
        setLoad({ ...shown, busy: false });
        showToast({ title: errorText('load more', res.error.message), tone: 'error' });
        return;
      }
      const seen = new Set(shown.ideas.map((i) => i.id));
      setLoad({
        status: 'ready',
        ideas: [...shown.ideas, ...res.data.ideas.filter((i) => !seen.has(i.id))],
        next: res.data.nextCursor,
        busy: false,
      });
    });
  };

  const close = (): void => {
    setStep(null);
    props.onClose();
  };

  // The row being placed carries the busy state (the sheet has no primary button).
  const [pickedId, setPickedId] = useState<string | null>(null);

  const place = async (idea: BankIdea, plan: PlanRow, day: string): Promise<void> => {
    setBusy(true);
    const res = await placeBankIdea(supabase, idea.id, plan.id, day);
    setBusy(false);
    if (!res.ok) {
      setStep(null);
      showToast({ title: planItError(res.error.message), tone: 'error' });
      return;
    }
    close();
    showToast({
      title: plannedToast(plan.title, day),
      kind: 'undo',
      action: {
        label: 'Undo',
        onPress: () => {
          void unplanBankIdea(supabase, idea.id, idea).then((back) => {
            if (back.ok) dispatchPlanChanged(window, plan.id);
            else showToast({ title: errorText('undo', back.error.message), tone: 'error' });
          });
        },
      },
    });
  };

  const choose = (idea: BankIdea, plan: PlanRow, day: string): void => {
    if (needsSharedWarning(plan, idea)) setStep({ kind: 'shared', idea, day, plan });
    else void place(idea, plan, day);
  };

  const pick = async (idea: BankIdea): Promise<void> => {
    if (busy) return;
    setPickedId(idea.id);
    const day = props.day;
    let plans = props.plans;
    if (plans === null) {
      if (workspaceId === null) return;
      const read = await readPlansForPlanIt(workspaceId, props.today);
      if (!read.ok) {
        showToast({ title: planItError(read.error.message), tone: 'error' });
        return;
      }
      plans = read.data;
    }
    const next = fromBankStep(plans, day, props.today, idea);
    switch (next.kind) {
      case 'past':
        showToast({ title: planItError('past_date'), tone: 'error' });
        return;
      case 'place':
        void place(idea, next.plan, day);
        return;
      case 'shared':
        setStep({ kind: 'shared', idea, day, plan: next.plan });
        return;
      case 'none':
        setStep({ kind: 'none', idea, day });
        return;
      default:
        setStep({ kind: 'several', idea, day, plans: next.plans });
    }
  };

  // The palette's pick: the same path as a tap on its row. An idea not on the
  // loaded page is found by its title first (searchBank, the bank's own search).
  const pickFromPalette = async (hits: WorkspaceHit[]): Promise<void> => {
    const loaded = load.status === 'ready' ? load.ideas : [];
    const found = bankPickOf(hits, loaded);
    if (found === null) return;
    if ('idea' in found) {
      await pick(found.idea);
      return;
    }
    if (workspaceId === null) return;
    const res = await withReadTimeout((signal) =>
      searchBank(supabase, fromBankQuery(workspaceId), found.find.title, signal),
    );
    const idea = res.ok ? res.data.find((i) => i.id === found.find.id) : undefined;
    if (idea === undefined) {
      showToast({ title: errorText('load the idea', res.ok ? null : res.error.message), tone: 'error' });
      return;
    }
    await pick(idea);
  };

  const makePlan = async (idea: BankIdea, day: string): Promise<void> => {
    if (workspaceId === null) return;
    setBusy(true);
    const made = await makeWeekPlan(supabase, workspaceId, day);
    setBusy(false);
    if (!made.ok) {
      setStep(null);
      showToast({ title: errorText('make the plan', made.error.message), tone: 'error' });
      return;
    }
    void place(idea, made.data, day);
  };

  const ideas = load.status === 'ready' ? load.ideas : null;
  const failed = load.status === 'failed';
  let body: ReactElement;
  if (ideas === null) {
    body = failed ? (
      <div className="py-2">
        <Button type="button" onClick={readFirst}>
          Retry
        </Button>
      </div>
    ) : (
      <div data-plan-from-bank-loading="" className="flex flex-col gap-2">
        {[0, 1, 2].map((n) => (
          <Bone key={n} lit="lit-card" className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  } else if (ideas.length === 0) {
    body = (
      <p data-plan-from-bank-zero="" className="py-2 text-base text-fg-2">
        {FROM_BANK_ZERO}
      </p>
    );
  } else {
    body = (
      <div data-plan-from-bank-list="" className="flex flex-col gap-2">
        {ideas.map((idea) => (
          <PressableRow
            key={idea.id}
            card
            type="button"
            data-plan-from-bank-idea={idea.id}
            disabled={busy}
            aria-busy={busy && pickedId === idea.id ? true : undefined}
            onClick={() => void pick(idea)}
            className="lit-card flex items-center gap-3 rounded-xl border bg-panel p-3 text-left"
          >
            <BankThumb idea={idea} size={44} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-2">
                {idea.starred_at != null ? (
                  <span className="shrink-0 text-warn" aria-label="Starred">
                    <IconStarFilled size={ICON_SIZE.inline} />
                  </span>
                ) : null}
                <span className="truncate text-base font-medium text-fg">{idea.title ?? ''}</span>
              </span>
              <span className="truncate text-sm text-fg-2">{ideaFormatLine(idea)}</span>
            </span>
          </PressableRow>
        ))}
        {load.status === 'ready' && load.next !== null ? (
          <div className="pt-2">
            <PlanTabLoadMore more={{ busy: load.busy, onMore: more }} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Sheet
        open={open && (step === null || step.kind === 'date')}
        onClose={close}
        title={FROM_BANK_LABEL}
        fixedHeight
        busy={busy}
        headerAction={
          <PalettePickButton
            label={FROM_BANK_SEARCH}
            request={() => ({
              pickKinds: ['bank_idea'],
              multi: false,
              verb: 'Add',
              label: 'Ideas',
              onPick: (hits) => void pickFromPalette(hits),
            })}
          />
        }
      >
        <div data-plan-from-bank="" className="flex flex-col gap-3 px-4 pb-4">
          {body}
        </div>
      </Sheet>
      <BankPlanItSheets
        step={open ? step : null}
        busy={busy}
        today={props.today}
        onClose={() => setStep(null)}
        onDay={() => setStep(null)}
        onMakePlan={(idea, day) => void makePlan(idea, day)}
        onPickPlan={(idea, plan, day) => choose(idea, plan, day)}
        onConfirmShared={(idea, plan, day) => void place(idea, plan, day)}
      />
    </>
  );
}
