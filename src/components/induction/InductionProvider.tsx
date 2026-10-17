// The induction's shared state for the shell: which route the person runs,
// what the guide shows (resolveGuide over induction_state and the workspace
// facts), the screens it can open (the default group, the post), the copy
// context, and the moves (to a step, Start, Skip). Pages read the active step
// through useInductionStepId and the post sheet's preset through
// useInductionPostPreset; both are safe without a provider (tests, screens
// outside the shell).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  approverStageOf,
  INDUCTION_KEYS,
  isGated,
  presetPrimaryFor,
  resolveGuide,
  stepDataDone,
  storedIdFor,
  type InductionState,
  type PlaceContext,
  type PostSheetPreset,
  type Resolution,
} from '@/lib/induction';
import type { CopyContext, InductionFacts, Route, RouteScript, Step } from '@/lib/induction-model';
import { ROUTE_SCRIPTS, routeFor } from '@/lib/induction-routes';
import { supabase } from '@/lib/supabase';
import type { InductionData } from './useInductionData';
import { readGuideFacts, type GuideFactsRead } from './induction-data';
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
  /** Skip, and Done on the closing card. */
  finish: () => void;
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
        env: { state, facts, workspaceLabel, data },
      }),
    [route, script, resolution, read.facts, state, facts, workspaceLabel, data],
  );

  return <InductionContext.Provider value={value}>{children}</InductionContext.Provider>;
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
  return {
    ...base,
    place: {
      postId: approver ? reviewId : env.state.postId,
      groupChannelId: group?.channelId ?? null,
    },
    qualifiers,
    copy: {
      brand,
      platform,
      post: approver ? (read.reviewPost?.title ?? '') : read.ownPostTitle,
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
          },
    moveTo: (to) => {
      if (script === undefined || resolution.kind === 'off' || resolution.kind === 'closing')
        return;
      void env.data.setStep(storedIdFor(script, resolution.steps, { from, to }));
    },
    start: () => {
      if (resolution.kind !== 'intro') return;
      void env.data.setStep(resolution.steps[resolution.index]?.id ?? resolution.card.id);
    },
    finish: env.data.finish,
  };
}

const EMPTY_FACTS: GuideFactsRead = {
  group: undefined,
  reviewPost: undefined,
  hasBrief: false,
  hasPlan: false,
  hasVoiceNote: false,
  ownPostTitle: '',
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
 * The workspace facts, read while the induction runs. Read again on each
 * induction_state refetch until the default group shows up (its chat channel
 * can land a moment after the workspace), and whenever the route or the
 * person's own post changes.
 */
function useGuideFacts(input: {
  active: boolean;
  workspaceId: string | null;
  route: Route | 'none';
  state: InductionState;
}): { workspaceId: string; facts: GuideFactsRead } {
  const { active, workspaceId, route, state } = input;
  const [read, setRead] = useState<FactsState>(NO_FACTS);
  const key = `${workspaceId ?? ''}|${route}|${state.postId ?? ''}`;
  const settled = read.key === key && read.facts.group !== undefined;

  useEffect(() => {
    if (!active || workspaceId === null || settled) return;
    let cancelled = false;
    void readGuideFacts(supabase, {
      workspaceId,
      approver: route === 'approver',
      postId: state.postId,
    }).then((facts) => {
      if (!cancelled) setRead({ workspaceId, key, facts });
    });
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, route, key, settled, state]);

  return read.key === key ? read : { workspaceId: '', facts: read.facts };
}
