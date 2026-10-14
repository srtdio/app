// Pure logic for the onboarding flow (src/components/onboarding/OnboardingFlow.tsx)
// and the chat-home getting-started card. No network, no React: every rule the
// screens depend on (username format and suggestion, which steps a person sees,
// role lists, checklist state) lives here so it is unit tested.

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

export const ROLE_TILES = {
  agency: [
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
  brand: [
    'Brand manager',
    'Marketing manager',
    'Marketing head',
    'Founder or owner',
    'Social media lead',
    'Product manager',
  ],
} as const;

export interface RoleGroup {
  label: string;
  roles: readonly string[];
}

/** Brand-side roles first for an invited client, agency roles first for everyone else. */
export function roleGroupsFor(isClient: boolean): RoleGroup[] {
  const agency: RoleGroup = { label: 'Agency', roles: ROLE_TILES.agency };
  const brand: RoleGroup = { label: 'Brand side', roles: ROLE_TILES.brand };
  return isClient ? [brand, agency] : [agency, brand];
}

/** Values mirror the user_private check constraints. */
export const AGE_RANGES = ['18-24', '25-34', '35-44', '45-54', '55+'] as const;
export const HEARD_FROM = [
  { value: 'friend', label: 'A friend' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'google', label: 'Google' },
  { value: 'client', label: 'A client' },
  { value: 'other', label: 'Other' },
] as const;

export type OnboardingStep =
  | 'password'
  | 'name'
  | 'role'
  | 'quick'
  | 'ready'
  | 'workspace'
  | 'firstpost'
  | 'invite';

export interface OnboardingContext {
  /** profile_completed_at is still null. */
  profileIncomplete: boolean;
  /** The person already belongs to at least one workspace (an invitee). */
  hasWorkspace: boolean;
}

/**
 * The steps a person walks, in order. A self sign-up names themselves, answers
 * the optional questions, then makes a workspace, a first post and invites. An
 * invitee sets a password (the invite link signed them in without one), names
 * themselves, then sees what is waiting. Someone with a profile but no workspace
 * goes straight to making one.
 */
export function stepsFor(ctx: OnboardingContext): OnboardingStep[] {
  if (ctx.hasWorkspace) {
    return ctx.profileIncomplete ? ['password', 'name', 'role', 'ready'] : [];
  }
  const profile: OnboardingStep[] = ctx.profileIncomplete ? ['name', 'role', 'quick'] : [];
  return [...profile, 'workspace', 'firstpost', 'invite'];
}

/** Steps that fill the progress bar (the ready screen sits after it). */
export function progressSteps(steps: readonly OnboardingStep[]): OnboardingStep[] {
  return steps.filter((step) => step !== 'ready');
}

/** Map a chosen side to the member_invite role. */
export function inviteRoleFor(side: 'client' | 'team'): 'client' | 'agency' {
  return side === 'client' ? 'client' : 'agency';
}

export interface GettingStartedFacts {
  postsSent: number;
  clientsInvited: number;
  assets: number;
}

export interface ChecklistItem {
  key: 'workspace' | 'post' | 'client' | 'assets';
  title: string;
  hint: string;
  done: boolean;
  to: string;
}

/** The chat-home checklist. Creating the workspace is always done, so it never opens at zero. */
export function gettingStartedItems(facts: GettingStartedFacts): ChecklistItem[] {
  return [
    {
      key: 'workspace',
      title: 'Create your workspace',
      hint: '',
      done: true,
      to: '/chat',
    },
    {
      key: 'post',
      title: 'Send your first post for review',
      hint: 'Add the creative and caption',
      done: facts.postsSent > 0,
      to: '/pipeline',
    },
    {
      key: 'client',
      title: 'Invite your client',
      hint: 'They review and approve here',
      done: facts.clientsInvited > 0,
      to: '/settings?panel=members',
    },
    {
      key: 'assets',
      title: 'Add your brand assets',
      hint: 'Logos, fonts and photos in one place',
      done: facts.assets > 0,
      to: '/assets',
    },
  ];
}

/**
 * The default chat group's name, as workspace_create derives it: group names
 * allow letters, digits, spaces and hyphens only, so "&" reads "and".
 */
export function defaultGroupName(workspaceName: string): string {
  const cleaned = workspaceName
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned === '' ? 'Team' : cleaned;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** "Arjun", "Arjun and Dev", "Arjun, Dev and 3 more": the ready screen's people line. */
export function peopleLine(people: readonly string[]): string {
  const firsts = people.map(firstName).filter((n) => n.length > 0);
  if (firsts.length === 0) return 'Your agency team';
  if (firsts.length === 1) return firsts[0] ?? '';
  if (firsts.length === 2) return `${firsts[0]} and ${firsts[1]}`;
  return `${firsts[0]}, ${firsts[1]} and ${firsts.length - 2} more`;
}

/** Two-letter tile label for a workspace or group ("Kite and Co" -> "KC"). */
export function initialsOf(text: string): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && w.toLowerCase() !== 'and');
  return ((words[0]?.[0] ?? 'S') + (words[1]?.[0] ?? '')).toUpperCase();
}
