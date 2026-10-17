// The induction's shared state for the shell: which route the person runs,
// what the guide shows (resolveGuide over induction_state and the workspace
// facts), the screens it can open (the default group, the post), the copy
// context, and the moves (to a step, Start, Done). Pages read the active step
// through useInductionStepId and the post sheet's preset through
// useInductionPostPreset; both are safe without a provider (tests, screens
// outside the shell).

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  approverStageOf,
  dispatchInductionRefresh,
  INDUCTION_KEYS,
  INDUCTION_REFRESH_EVENT,
  isGated,
  pastFilled,
  presetPrimaryFor,
  resolveGuide,
  stepDataDone,
  storedIdFor,
  type InductionKey,
  type InductionState,
  type PlaceContext,
  type PostSheetPreset,
  type Resolution,
} from '@/lib/induction';
import type { CopyContext, InductionFacts, Route, RouteScript, Step } from '@/lib/induction-model';
import { ROUTE_SCRIPTS, routeFor } from '@/lib/induction-routes';
import { supabase } from '@/lib/supabase';
import type { InductionData } from './useInductionData';
import { generateTraceId as newTraceId } from '@/lib/trace';
import {
  clearSampleWeek,
  NO_SAMPLE,
  readGuideFacts,
  seedSampleWeek,
  type GuideFactsRead,
  type SampleWeek,
} from './induction-data';
import type { Qualifiers } from './guide-dom';

export interface InductionContextValue {
  route: Route | 'none';
  /** The route's script; undefined when the guide is off for an unknown role. */
  script: RouteScript | undefined;
  resolution: Resolution;
  place: PlaceContext;
  /** Narrows row targets to the review post and the default group. */
  qualifiers: Qualifiers;
  copy: CopyContext;
  /** Whether the data already finished a step. */
  isDone: (step: Step) => boolean;
  postPreset: PostSheetPreset | undefined;
  /** Move from the current step (or intro) to the step at this index; past the end is the closing card. */
  moveTo: (index: number) => void;
  /** Start on the intro card: the first look-around step. */
  start: () => void;
  /** Done on the closing card. */
  finish: () => void;
  /** The creator's sample week (Kestrel & Rowe) in this workspace. */
  sample: SampleWeek;
  /** Clear it on the clear card: every sample row and person goes, the person's own work stays. */
  clearSample: () => Promise<void>;
  /** Epoch ms the look-around started on this device (the clear card's time); null when unknown. */
  startedAt: number | null;
}

const InductionContext = createContext<InductionContextValue | null>(null);

export function useInduction(): InductionContextValue | null {
  return useContext(InductionContext);
}

/** The active step's id, or '' when no step is up. */
export function useInductionStepId(): string {
  const ctx = useContext(InductionContext);
  return ctx !== null && ctx.resolution.kind === 'step' ? ctx.resolution.step.id : '';
}

/** The post sheet preset while a first post step is up; undefined otherwise. */
export function useInductionPostPreset(): PostSheetPreset | undefined {
  return useContext(InductionContext)?.postPreset;
}

const OFF: Resolution = { kind: 'off' };

/** "<Brand> - <Platform>" split into its two halves. */
export function splitWorkspaceLabel(label: string): { brand: string; platform: string } {
  const at = label.lastIndexOf(' - ');
  if (at < 0) return { brand: label.trim(), platform: '' };
  return { brand: label.slice(0, at).trim(), platform: label.slice(at + 3).trim() };
}

export function InductionProvider({
  data,
  workspaceId,
  workspaceLabel,
  canCreateBrief = null,
  children,
}: {
  data: InductionData;
  workspaceId: string | null;
  workspaceLabel: string;
  /** brief.create for the viewer; false drops the approver's brief steps. null while unknown. */
  canCreateBrief?: boolean | null;
  children: ReactNode;
}) {
  const { state } = data;
  const hasWorkspace = workspaceId !== null;
  const route = routeFor({ role: state.role, hasWorkspace });
  const script = route === 'none' ? undefined : ROUTE_SCRIPTS[route];
  const active =
    data.status === 'ready' &&
    !state.done &&
    script !== undefined &&
    approverStageOf(state) === 'none';
  const read = useGuideFacts({ active, workspaceId, route, state });
  // The approver's post leaves Review once approved; the closing card still names it.
  const lastReviewTitle = useRef('');
  if (read.facts.reviewPost?.title) lastReviewTitle.current = read.facts.reviewPost.title;
  const known = !hasWorkspace || read.workspaceId === workspaceId;
  const facts = useMemo<InductionFacts>(
    () => ({
      hasWorkspace,
      hasBrief: read.facts.hasBrief,
      hasPlan: read.facts.hasPlan,
      hasReviewPost: read.facts.reviewPost !== undefined,
      hasOwnPost: state.postId !== null,
      hasGroup: read.facts.group !== undefined,
      hasVoiceNote: read.facts.hasVoiceNote,
      canCreateBrief,
    }),
    [hasWorkspace, read.facts, state.postId, canCreateBrief],
  );

  const resolution = useMemo(
    () => (active && known && script !== undefined ? resolveGuide(script, { state, facts }) : OFF),
    [active, known, script, state, facts],
  );

  useStoredStepSync(resolution, data);
  useSampleSeed({
    // Every first tour runs in a lived-in workspace: the creator's from the setup
    // steps (once the workspace exists), an invited member's from their first screen.
    on:
      active &&
      workspaceId !== null &&
      known &&
      resolution.kind !== 'off' &&
      resolution.kind !== 'closing' &&
      !read.facts.sample.seeded,
    workspaceId,
  });
  const { setPolling } = data;
  const gated = resolution.kind === 'step' && isGated(resolution.step);
  useEffect(() => {
    setPolling(gated);
  }, [gated, setPolling]);

  const value = useMemo<InductionContextValue>(
    () =>
      buildValue({
        base: { route, script, resolution },
        read: read.facts,
        env: {
          state,
          facts,
          workspaceLabel,
          data,
          workspaceId,
          reviewTitle: lastReviewTitle.current,
        },
      }),
    [route, script, resolution, read.facts, state, facts, workspaceLabel, data, workspaceId],
  );

  return <InductionContext.Provider value={value}>{children}</InductionContext.Provider>;
}

/**
 * A new owner's workspace fills with the sample week while they are still in
 * the setup steps (the prototype's pipeline is full from Step 2). One call per
 * workspace per page load; the proc itself refuses a second seed and any seed
 * after a clear, so a reload or another device never brings it back.
 */
function useSampleSeed(input: { on: boolean; workspaceId: string | null }): void {
  const asked = useRef<string | null>(null);
  const { on, workspaceId } = input;
  useEffect(() => {
    if (!on || workspaceId === null || asked.current === workspaceId) return;
    asked.current = workspaceId;
    void seedSampleWeek(supabase, { workspaceId, traceId: newTraceId() }).then((seeded) => {
      if (seeded) dispatchInductionRefresh();
    });
  }, [on, workspaceId]);
}

const STARTED_KEY = 'srtdio.induction.lookAroundStartedAt';

function readStartedAt(): number | null {
  try {
    const raw = window.sessionStorage.getItem(STARTED_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function markStarted(): void {
  try {
    window.sessionStorage.setItem(STARTED_KEY, String(Date.now()));
  } catch {
    // Storage off: the clear card shows its time without it.
  }
}

/** When the data moved the guide (or an old id resolved), store the step it landed on. */
function useStoredStepSync(resolution: Resolution, data: InductionData): void {
  const { setStep } = data;
  const stored = data.state.step;
  const landed = resolution.kind === 'step' ? resolution.step.id : '';
  useEffect(() => {
    if (landed !== '' && stored !== landed) void setStep(landed);
  }, [landed, stored, setStep]);
}

function buildValue(input: {
  base: Pick<InductionContextValue, 'route' | 'script' | 'resolution'>;
  read: GuideFactsRead;
  env: {
    state: InductionState;
    facts: InductionFacts;
    workspaceLabel: string;
    data: InductionData;
    workspaceId: string | null;
    reviewTitle: string;
  };
}): InductionContextValue {
  const { base, read, env } = input;
  const { resolution, script } = base;
  const approver = base.route === 'approver';
  const group = read.group;
  const reviewId = read.reviewPost?.id ?? null;
  const qualifiers: Qualifiers = {
    [INDUCTION_KEYS.chatDefaultGroupRow]: {
      attr: 'data-induction-channel',
      value: group?.channelId ?? '',
      strict: true,
    },
    ...(reviewId !== null
      ? {
          [INDUCTION_KEYS.pipelinePostRow]: {
            attr: 'data-induction-post',
            value: reviewId,
            strict: false,
          },
        }
      : {}),
  };
  const { brand, platform } = splitWorkspaceLabel(env.workspaceLabel);
  const primary = resolution.kind === 'step' ? presetPrimaryFor(resolution.step) : undefined;
  const from = resolution.kind === 'step' || resolution.kind === 'intro' ? resolution.index : -1;
  const moveTo = (to: number): void => {
    if (script === undefined || resolution.kind === 'off' || resolution.kind === 'closing') return;
    void env.data.setStep(storedIdFor(script, resolution.steps, { from, to }));
  };
  /** The first post's fill on tap: move past the steps whose controls the tap filled. */
  const passFilled = (filled: readonly InductionKey[]): void => {
    if (resolution.kind !== 'step') return;
    const to = pastFilled(resolution.steps, resolution.index, filled);
    if (to >= 0) moveTo(to);
  };
  return {
    ...base,
    place: {
      // The creator's Review chapter comments on the sample week's post while it is there.
      postId: approver ? reviewId : (read.sample.reviewPostId ?? env.state.postId),
      groupChannelId: group?.channelId ?? null,
    },
    qualifiers,
    copy: {
      brand,
      platform,
      post: approver ? (read.reviewPost?.title ?? env.reviewTitle) : read.ownPostTitle,
      creator: approver ? (read.reviewPost?.creatorName ?? '') : '',
      inviter: '',
      email: '',
    },
    isDone: (step) => stepDataDone(step, { state: env.state, facts: env.facts }),
    postPreset:
      primary === undefined
        ? undefined
        : {
            primary,
            share:
              group !== undefined
                ? { channelId: group.channelId, groupName: group.name }
                : 'no_group',
            ...(primary === 'send_for_review' ? { fillOnTap: { onFilled: passFilled } } : {}),
          },
    moveTo,
    start: () => {
      if (resolution.kind !== 'intro') return;
      markStarted();
      void env.data.setStep(resolution.steps[resolution.index]?.id ?? resolution.card.id);
    },
    // Done clears what is left of the sample (the creator cleared theirs on the clear card).
    finish: () => {
      const ws = env.workspaceId;
      if (ws !== null && read.sample.seeded) {
        void clearSampleWeek(supabase, { workspaceId: ws, traceId: newTraceId() }).then(() =>
          dispatchInductionRefresh(),
        );
      }
      env.data.finish();
    },
    sample: read.sample,
    clearSample: async () => {
      const ws = env.workspaceId;
      if (ws === null) return;
      await clearSampleWeek(supabase, { workspaceId: ws, traceId: newTraceId() });
      dispatchInductionRefresh();
    },
    startedAt: readStartedAt(),
  };
}

const EMPTY_FACTS: GuideFactsRead = {
  group: undefined,
  reviewPost: undefined,
  hasBrief: false,
  hasPlan: false,
  hasVoiceNote: false,
  ownPostTitle: '',
  sample: NO_SAMPLE,
};

interface FactsState {
  /** The workspace these were read for; '' before the first read. */
  workspaceId: string;
  /** The read's inputs, so a new route or a newly sent post reads again. */
  key: string;
  facts: GuideFactsRead;
}

const NO_FACTS: FactsState = { workspaceId: '', key: '', facts: EMPTY_FACTS };

/**
 * The workspace facts, read once per workspace, route and own post while the
 * induction runs, and again on each sorted:induction-refresh. While the
 * default group is still unknown, each induction_state refetch reads again;
 * once it is found, the poll and route changes never do.
 */
function useGuideFacts(input: {
  active: boolean;
  workspaceId: string | null;
  route: Route | 'none';
  state: InductionState;
}): { workspaceId: string; facts: GuideFactsRead } {
  const { active, workspaceId, route } = input;
  const postId = input.state.postId;
  const [read, setRead] = useState<FactsState>(NO_FACTS);
  const [refreshes, setRefreshes] = useState(0);
  const key = `${workspaceId ?? ''}|${route}|${postId ?? ''}`;
  // Until the default group is known, each induction_state refetch reads again:
  // its chat channel can land a moment after the workspace.
  const groupPending = read.key === key && read.facts.group === undefined;
  const refetch = groupPending ? input.state : null;

  useEffect(() => {
    if (!active) return;
    const onRefresh = (): void => setRefreshes((n) => n + 1);
    window.addEventListener(INDUCTION_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(INDUCTION_REFRESH_EVENT, onRefresh);
  }, [active]);

  useEffect(() => {
    if (!active || workspaceId === null) return;
    let cancelled = false;
    void readGuideFacts(supabase, { workspaceId, approver: route === 'approver', postId }).then(
      (facts) => {
        if (!cancelled) setRead({ workspaceId, key, facts });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, route, postId, key, refreshes, refetch]);

  return read.key === key ? read : { workspaceId: '', facts: read.facts };
}
