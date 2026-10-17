// The contract between the guide engine (src/lib/induction.ts,
// src/components/induction/**), the route scripts (src/lib/induction-routes.ts)
// and the copy module (src/lib/induction-copy.ts). Types only, plus the route
// prefixes the stored step ids carry so completion and drop-off read per route.

import type { InductionKey } from './induction-keys';

/** creator: the owner who signed up. invited: an invited admin or agency member. approver: an invited client. */
export type Route = 'creator' | 'invited' | 'approver';

/** Stored step ids start with their route's prefix (induction_step_set takes ^[a-z0-9_]{1,40}$). */
export const ROUTE_PREFIX = {
  creator: 'c_',
  invited: 'i_',
  approver: 'a_',
} as const satisfies Record<Route, string>;

export type RoutePrefix = (typeof ROUTE_PREFIX)[Route];

/** The look-around chapters. Creator routes run Ask, Review, Talk; the approver Review, Ask, Talk. */
export type Chapter = 'ask' | 'review' | 'talk';

/**
 * setup: finished by the data (the workspace). gate: finished by the data and
 * never skipped by the 4 s rule while its screen is up (the first post, the
 * approver invite). teach: finished by the person's tap on the control.
 * optional: like teach, plus one secondary chip with the step's laterLabel.
 */
export type StepKind = 'setup' | 'gate' | 'teach' | 'optional';

/** Where a step lives; the engine builds the route from it. 'shell' lives anywhere. */
export type StepPlace =
  | 'shell'
  | 'pipeline'
  | 'members'
  | 'post'
  | 'briefs'
  | 'activity'
  | 'chat'
  | 'group';

/**
 * The data that finishes a step, read from induction_state and the workspace.
 * 'none' means the DOM finishes it (the tap, the next target appearing or this
 * one disappearing).
 */
export type DataDoneKey =
  | 'none'
  | 'hasWorkspace'
  | 'firstPostSent'
  | 'clientInvited'
  | 'teamInvited';

/**
 * Facts that drop a step when true: the look-around runs on the person's real
 * workspace and skips what does not exist.
 */
export type SkipWhen =
  | 'noBrief'
  | 'noPlan'
  | 'noReviewPost'
  | 'noOwnPost'
  | 'noGroup'
  | 'noVoiceNote'
  | 'cannotCreateBrief';

export interface Step {
  /** Route-prefixed (c_, i_, a_), unique, ^[a-z0-9_]{1,40}$. */
  id: string;
  route: Route;
  /** Setup steps: the phase name shown in the bar, e.g. "Step 3". */
  phase?: string;
  /** Look-around steps: the chapter. */
  chapter?: Chapter;
  kind: StepKind;
  /** The controls to box, first visible wins (an open sheet's control before the page's). */
  targets: readonly InductionKey[];
  /** The pill beside the control, e.g. "Tap to create a post". May hold {placeholders}. */
  label: string;
  /** One sentence in the guide bar. May hold {placeholders}. '' only where the copy gives none. */
  why: string;
  /** The optional step's secondary chip. */
  laterLabel?: string;
  place: StepPlace;
  dataDone: DataDoneKey;
  skipWhen?: readonly SkipWhen[];
  /** Hook for the later sample week: the engine ignores sampleOnly steps for now. */
  sampleOnly?: boolean;
}

export interface Card {
  id: string;
  route: Route;
  kind: 'intro' | 'closing';
  eyebrow?: string;
  title: string;
  body: string;
  /** Intro only: the chapter pills in route order. */
  pills?: readonly string[];
  button: string;
}

export interface RouteScript {
  route: Route;
  /** Taps already made before the guide (sign-up and onboarding screens); they count in the progress fill. */
  entrySteps: number;
  /**
   * The entry taps the hand already shows on the pre-app screens, in order
   * (OnboardingFlow). Counted in entrySteps, never in steps, so the fill holds.
   */
  entryTargets: readonly InductionKey[];
  /** Setup steps (phases), then the look-around (chapters), in order. */
  steps: readonly Step[];
  /** Shown before the first look-around step. */
  intro: Card;
  /** Shown after the last step. */
  closing: Card;
}

/** What the placeholders read. Every field is a plain string; '' when unknown (the copy falls back). */
export interface CopyContext {
  brand: string;
  platform: string;
  post: string;
  creator: string;
  inviter: string;
  email: string;
}

/** What the person's workspace can show right now; drives SkipWhen. */
export interface InductionFacts {
  hasWorkspace: boolean;
  hasBrief: boolean;
  hasPlan: boolean;
  hasReviewPost: boolean;
  hasOwnPost: boolean;
  hasGroup: boolean;
  hasVoiceNote: boolean;
  /** null while unknown keeps the step. */
  canCreateBrief: boolean | null;
}
