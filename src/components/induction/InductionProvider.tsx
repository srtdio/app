// The induction's shared state for the shell: which step is up (resolveStep
// over induction_state), the screens it can open (the default group, the post),
// and Next / Later. Pages read the active step through useInductionStepId and
// the post sheet's preset through useInductionPostPreset; both are safe without
// a provider (tests, screens outside the shell).

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  isGated,
  pathFor,
  resolveStep,
  type InductionResolution,
  type InductionState,
  type PlaceContext,
  type PostSheetPreset,
} from '@/lib/induction';
import { supabase } from '@/lib/supabase';
import type { InductionData } from './useInductionData';
import { readDefaultGroup, readOldestReviewPost, type DefaultGroup } from './induction-data';

export interface InductionContextValue {
  resolution: InductionResolution;
  place: PlaceContext;
  /** "<Brand> - <Platform>", or '' before a workspace exists. */
  workspaceLabel: string;
  postPreset: PostSheetPreset | undefined;
  /** Next on a teach or optional step (finishes after the last one). */
  next: () => void;
  /** Later on an optional step: moves on the same way. */
  later: () => void;
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

/** The post sheet preset while a post step is up; undefined otherwise. */
export function useInductionPostPreset(): PostSheetPreset | undefined {
  return useContext(InductionContext)?.postPreset;
}

/** Post steps that open the sheet with a preset, and their primary action. */
const PRESET_STEPS: Readonly<Record<string, PostSheetPreset['primary']>> = {
  first_post: 'send_for_review',
  t_post: 'save_draft',
};

export function InductionProvider({
  data,
  workspaceId,
  workspaceLabel,
  children,
}: {
  data: InductionData;
  workspaceId: string | null;
  workspaceLabel: string;
  children: ReactNode;
}) {
  const { state } = data;
  const hasWorkspace = workspaceId !== null;
  const path = pathFor(state.role, hasWorkspace);
  const active = data.status === 'ready' && !state.done;
  const places = usePlaces({ active, workspaceId, path, state });
  // Resolve only once the screens are known, so resume never lands on a step
  // that is about to drop out (or in) a moment later.
  const placesKnown = !hasWorkspace || places.workspaceId === workspaceId;
  const shownGroup = placesKnown && places.group !== undefined ? places.group : null;
  const approverPost = placesKnown ? (places.reviewPostId ?? null) : null;
  const postId = path === 'approver' ? approverPost : state.postId;
  const groupChannelId = shownGroup?.channelId ?? null;

  const resolution = useMemo(
    () =>
      data.status === 'ready' && placesKnown
        ? resolveStep({ path, state, where: { hasWorkspace, postId, groupChannelId } })
        : ({ kind: 'off' } as const),
    [data.status, placesKnown, path, state, hasWorkspace, postId, groupChannelId],
  );

  const { setPolling, setStep, finish } = data;
  const gated = resolution.kind === 'step' && isGated(resolution.step);
  useEffect(() => {
    setPolling(gated);
  }, [gated, setPolling]);

  const value = useMemo<InductionContextValue>(() => {
    const advance = (): void => {
      if (resolution.kind !== 'step') return;
      if (resolution.nextId === 'finish') finish();
      else void setStep(resolution.nextId);
    };
    const primary = resolution.kind === 'step' ? PRESET_STEPS[resolution.step.id] : undefined;
    return {
      resolution,
      place: { postId, groupChannelId },
      workspaceLabel,
      postPreset:
        primary === undefined
          ? undefined
          : {
              primary,
              share:
                shownGroup !== null
                  ? { channelId: shownGroup.channelId, groupName: shownGroup.name }
                  : 'no_group',
            },
      next: advance,
      later: advance,
      finish,
    };
  }, [resolution, postId, groupChannelId, workspaceLabel, shownGroup, setStep, finish]);

  return <InductionContext.Provider value={value}>{children}</InductionContext.Provider>;
}

interface Places {
  /** The workspace these were read for; '' before the first read. */
  workspaceId: string;
  group: DefaultGroup | undefined;
  reviewPostId: string | undefined;
}

const NO_PLACES: Places = { workspaceId: '', group: undefined, reviewPostId: undefined };

/**
 * The default group (every path) and the first post in review (approvers),
 * read while the induction runs. Read again on each induction_state refetch
 * until the group shows up: its chat channel can land a moment after the
 * workspace.
 */
function usePlaces(input: {
  active: boolean;
  workspaceId: string | null;
  path: string;
  state: InductionState;
}): Places {
  const { active, workspaceId, path, state } = input;
  const [places, setPlaces] = useState<Places>(NO_PLACES);
  const settled = places.workspaceId === workspaceId && places.group !== undefined;

  useEffect(() => {
    if (!active || workspaceId === null || settled) return;
    let cancelled = false;
    void Promise.all([
      readDefaultGroup(supabase, workspaceId),
      path === 'approver'
        ? readOldestReviewPost(supabase, workspaceId)
        : Promise.resolve(undefined),
    ]).then(([group, reviewPostId]) => {
      if (!cancelled) setPlaces({ workspaceId, group, reviewPostId });
    });
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, path, settled, state]);

  return places;
}
