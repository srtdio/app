// Pure logic for the pre-app screens (src/components/onboarding/OnboardingFlow.tsx).
// No network, no React: every rule the screens depend on (username format and
// suggestion, which screens a person sees, the role lists) lives here so it is
// unit tested. The in-app guide is src/lib/induction.ts.

import { INDUCTION_KEYS, type InductionKey } from './induction-keys';
import type { CopyContext } from './induction-model';
import { ROUTE_SCRIPTS } from './induction-routes';

/** Mirrors users_username_format in the 20261014140000 migration. */
export const USERNAME_PATTERN = /^[a-z0-9._]{3,20}$/;

/** Mirrors the reserved list in username_available / user_onboarding_save. */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin',
  'support',
  'sorted',
  'srtd',
  'help',
  'team',
  'everyone',
];

/** Lowercase, dots between words, letters and digits only, 20 chars max. */
export function suggestUsername(fullName: string): string {
  return fullName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join('.')
    .slice(0, 20);
}

/** Keep only characters a username may hold, lowercased, as the person types. */
export function normalizeUsernameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .slice(0, 20);
}

export type UsernameFormat = 'empty' | 'invalid' | 'reserved' | 'ok';

export function usernameFormat(value: string): UsernameFormat {
  if (value.length === 0) return 'empty';
  if (!USERNAME_PATTERN.test(value)) return 'invalid';
  if (RESERVED_USERNAMES.includes(value)) return 'reserved';
  return 'ok';
}

/** Who a person is here as: Creators make the posts, Approvers approve them. */
export type Side = 'creator' | 'approver';

export const SIDE_TILES: readonly { side: Side; title: string; sub: string }[] = [
  { side: 'creator', title: 'Creator', sub: 'We make the posts' },
  { side: 'approver', title: 'Approver', sub: 'We approve them' },
];

/** The role list per side, shown under a person's name. */
export const ROLE_TILES: Readonly<Record<Side, readonly string[]>> = {
  creator: [
    'Founder or director',
    'Account manager',
    'Client servicing',
    'Social media manager',
    'Content strategist',
    'Copywriter',
    'Graphic designer',
    'Art director',
    'Creative director',
    'Video editor',
    'Motion designer',
    'Photographer',
  ],
  approver: [
    'Brand manager',
    'Marketing manager',
    'Marketing head',
    'Founder or owner',
    'Social media lead',
    'Product manager',
  ],
};

/** The free-text choice at the end of every role list. */
export const OTHER_ROLE = 'Something else';

export type OnboardingStep = 'welcome' | 'side' | 'name' | 'role' | 'brand' | 'waiting';

export interface OnboardingContext {
  /** profile_completed_at is still null. */
  profileIncomplete: boolean;
  /** The person already belongs to at least one workspace (an invitee). */
  hasWorkspace: boolean;
  /** The side picked on the first screen (an invitee's comes from the invite). */
  side: Side;
  /** An approver who signed up alone: naming their team, or waiting for it. */
  approverStage: 'none' | 'brand' | 'waiting';
}

/**
 * The pre-app screens, in order. An invitee (the invite link already signed
 * them in and accepted the invite) sees the welcome, names themselves and picks
 * a role, then goes straight into the shell. A self sign-up picks a side and
 * names themselves; a Creator then makes the workspace in the shell, an
 * Approver names who makes their posts and waits for them. An approver back
 * after a reload resumes where they were.
 */
export function stepsFor(ctx: OnboardingContext): OnboardingStep[] {
  if (ctx.hasWorkspace) return ctx.profileIncomplete ? ['welcome', 'name', 'role'] : [];
  const approverTail: OnboardingStep[] = ctx.side === 'approver' ? ['brand', 'waiting'] : [];
  if (!ctx.profileIncomplete) {
    if (ctx.approverStage === 'brand') return ['brand', 'waiting'];
    return ctx.approverStage === 'waiting' ? ['waiting'] : [];
  }
  return ['side', 'name', 'role', ...approverTail];
}

/**
 * Steps that count towards "Step N of M": only the form steps. The welcome sits
 * before them and the waiting screen after them, so neither shows a count.
 */
export function progressSteps(steps: readonly OnboardingStep[]): OnboardingStep[] {
  return steps.filter((step) => step !== 'waiting' && step !== 'welcome');
}

/** An invitee's side comes only from workspace_members.role: client approves. */
export function sideForMemberRole(role: string): Side {
  return role === 'client' ? 'approver' : 'creator';
}

/** A CopyContext for fillCopy from the fields an entry screen has; the rest stay ''. */
export function entryCopyContext(values: Partial<CopyContext>): CopyContext {
  return { brand: '', platform: '', post: '', creator: '', inviter: '', email: '', ...values };
}

/**
 * Where "Not you?" sends a signed-out invitee: back to sign in, then on to the
 * same invite. Without the invite id it falls back to the pipeline.
 */
export function notYouPath(inviteId: string): string {
  const id = inviteId.trim();
  return id === ''
    ? '/signin?next=/pipeline'
    : `/signin?next=/invite/accept/${encodeURIComponent(id)}`;
}

/** The designation saved for a role pick: the free text for "Something else". */
export function designationFor(role: string, other: string): string {
  return role === OTHER_ROLE ? other.trim() : role;
}

/**
 * Where the guide's hand sits on a pre-app screen, or null for none. Every new
 * sign-up gets it on the side screen's Continue once a side is picked; then only
 * a Creator (the creator route) gets it, on each later Continue once it is
 * enabled (name screen: photo, name and a free username; role screen: a role),
 * from where the shell's guide takes over at c_workspace. Before a pick the
 * screen stays clear, so nothing is dimmed while the person chooses.
 */
export function entryHandTarget(input: {
  step: OnboardingStep;
  signUp: boolean;
  creatorRoute: boolean;
  continueEnabled: boolean;
}): InductionKey | null {
  if (!input.continueEnabled) return null;
  if (input.step === 'side') return input.signUp ? INDUCTION_KEYS.onboardingSideContinue : null;
  if (!input.creatorRoute) return null;
  const [name, role] = ROUTE_SCRIPTS.creator.entryTargets;
  if (input.step === 'name') return name ?? null;
  if (input.step === 'role') return role ?? null;
  return null;
}
