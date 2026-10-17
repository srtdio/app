import { describe, expect, it } from 'vitest';
import { CHECK_EMAIL_COPY, WELCOME_COPY, fillCopy } from './induction-copy';
import {
  OTHER_ROLE,
  ROLE_TILES,
  SIDE_TILES,
  designationFor,
  entryCopyContext,
  entryHandTarget,
  normalizeUsernameInput,
  notYouPath,
  progressSteps,
  sideForMemberRole,
  stepsFor,
  suggestUsername,
  usernameFormat,
  type OnboardingContext,
} from './onboarding';

describe('suggestUsername', () => {
  it('joins words with dots and drops other characters', () => {
    expect(suggestUsername('Meera Shah')).toBe('meera.shah');
    expect(suggestUsername("  Riya  D'Souza ")).toBe('riya.dsouza');
  });
  it('caps at 20 characters', () => {
    expect(suggestUsername('Aditya Anilkumar Lakhiwal').length).toBeLessThanOrEqual(20);
  });
  it('is empty for a blank name', () => {
    expect(suggestUsername('   ')).toBe('');
  });
});

describe('usernameFormat', () => {
  it('classifies input', () => {
    expect(usernameFormat('')).toBe('empty');
    expect(usernameFormat('ab')).toBe('invalid');
    expect(usernameFormat('Riya')).toBe('invalid');
    expect(usernameFormat('admin')).toBe('reserved');
    expect(usernameFormat('riya.menon')).toBe('ok');
  });
  it('normalizes typing to allowed characters', () => {
    expect(normalizeUsernameInput('Riya Menon!')).toBe('riyamenon');
    expect(normalizeUsernameInput('a_b.c')).toBe('a_b.c');
  });
});

const SELF: OnboardingContext = {
  profileIncomplete: true,
  hasWorkspace: false,
  side: 'creator',
  approverStage: 'none',
};

describe('stepsFor', () => {
  it('walks a Creator who signed up through side, name and role, then into the shell', () => {
    expect(stepsFor(SELF)).toEqual(['side', 'name', 'role']);
  });

  it('walks an Approver who signed up alone on to their team and the wait', () => {
    expect(stepsFor({ ...SELF, side: 'approver' })).toEqual([
      'side',
      'name',
      'role',
      'brand',
      'waiting',
    ]);
  });

  it('walks an invitee through the welcome, name and role, with no password step', () => {
    expect(stepsFor({ ...SELF, hasWorkspace: true })).toEqual(['welcome', 'name', 'role']);
    expect(stepsFor({ ...SELF, hasWorkspace: true, side: 'approver' })).toEqual([
      'welcome',
      'name',
      'role',
    ]);
    expect(stepsFor({ ...SELF, hasWorkspace: true }).join(' ')).not.toContain('password');
  });

  it('resumes an approver who reloaded on the screen they left', () => {
    const done = { ...SELF, profileIncomplete: false };
    expect(stepsFor({ ...done, approverStage: 'brand' })).toEqual(['brand', 'waiting']);
    expect(stepsFor({ ...done, approverStage: 'waiting' })).toEqual(['waiting']);
    expect(stepsFor(done)).toEqual([]);
  });

  it('never asks how they heard about Sorted here', () => {
    expect(stepsFor({ ...SELF, side: 'approver' }).join(' ')).not.toContain('quick');
  });

  it('keeps the waiting screen out of the step count', () => {
    expect(progressSteps(['side', 'name', 'role', 'brand', 'waiting'])).toEqual([
      'side',
      'name',
      'role',
      'brand',
    ]);
  });

  it('counts only the form steps after the welcome: name and role', () => {
    expect(progressSteps(['welcome', 'name', 'role'])).toEqual(['name', 'role']);
  });

  it('keeps the self sign-up counts: side, name, role', () => {
    expect(progressSteps(stepsFor(SELF))).toEqual(['side', 'name', 'role']);
  });
});

describe('sides and roles', () => {
  it('names the sides Creator and Approver', () => {
    expect(SIDE_TILES).toEqual([
      { side: 'creator', title: 'Creator', sub: 'We make the posts' },
      { side: 'approver', title: 'Approver', sub: 'We approve them' },
    ]);
  });

  it('has a role list per side', () => {
    expect(ROLE_TILES.creator).toContain('Copywriter');
    expect(ROLE_TILES.approver).toContain('Brand manager');
  });

  it('saves the free text for Something else', () => {
    expect(designationFor(OTHER_ROLE, '  Community lead ')).toBe('Community lead');
    expect(designationFor(OTHER_ROLE, '   ')).toBe('');
    expect(designationFor('Copywriter', 'ignored')).toBe('Copywriter');
  });
});

describe('invitee side', () => {
  it('reads the side from workspace_members.role only', () => {
    expect(sideForMemberRole('client')).toBe('approver');
    expect(sideForMemberRole('agency')).toBe('creator');
    expect(sideForMemberRole('admin')).toBe('creator');
    expect(sideForMemberRole('owner')).toBe('creator');
  });
});

describe('entryCopyContext with fillCopy', () => {
  it('fills the fields given and leaves the rest empty', () => {
    expect(entryCopyContext({ email: 'a@b.in' })).toEqual({
      brand: '',
      platform: '',
      post: '',
      creator: '',
      inviter: '',
      email: 'a@b.in',
    });
  });

  it('fills the check-your-email body with the address', () => {
    expect(fillCopy(CHECK_EMAIL_COPY.body, entryCopyContext({ email: 'a@b.in' }))).toBe(
      'We sent a sign-in link to a@b.in. Open it on this device to carry on.',
    );
  });

  it('fills the welcome heading, subline and joining line', () => {
    expect(fillCopy(WELCOME_COPY.heading, entryCopyContext({ brand: 'Kite' }))).toBe(
      'Welcome to Kite',
    );
    expect(fillCopy(WELCOME_COPY.creatorSubline, entryCopyContext({ inviter: 'Meera' }))).toBe(
      'Meera invited you to create posts with the team.',
    );
    expect(fillCopy(WELCOME_COPY.joiningAs, entryCopyContext({ email: 'a@b.in' }))).toBe(
      'Joining as a@b.in',
    );
  });

  it('gives the same fallback inviter as WELCOME_COPY.fallbackInviter', () => {
    expect(fillCopy(WELCOME_COPY.approverSubline, entryCopyContext({}))).toBe(
      `${WELCOME_COPY.fallbackInviter} invited you to review posts for the team.`,
    );
  });
});

describe('notYouPath', () => {
  it('signs in again on the way back to the same invite', () => {
    expect(notYouPath('3f1c')).toBe('/signin?next=/invite/accept/3f1c');
  });
  it('falls back to the pipeline without an invite id', () => {
    expect(notYouPath('')).toBe('/signin?next=/pipeline');
  });
});

describe('entryHandTarget', () => {
  const creator = { creatorRoute: true, continueEnabled: true };

  it('never on the side screen', () => {
    expect(entryHandTarget({ ...creator, step: 'side' })).toBeNull();
  });

  it('on the name screen only once Continue is enabled', () => {
    expect(entryHandTarget({ ...creator, step: 'name', continueEnabled: false })).toBeNull();
    expect(entryHandTarget({ ...creator, step: 'name' })).toBe('onboarding-name-continue');
  });

  it('stays on the role screen Continue', () => {
    expect(entryHandTarget({ ...creator, step: 'role', continueEnabled: false })).toBe(
      'onboarding-role-continue',
    );
  });

  it('only on the creator route', () => {
    expect(
      entryHandTarget({ step: 'name', creatorRoute: false, continueEnabled: true }),
    ).toBeNull();
    expect(
      entryHandTarget({ step: 'role', creatorRoute: false, continueEnabled: true }),
    ).toBeNull();
    expect(entryHandTarget({ ...creator, step: 'welcome' })).toBeNull();
    expect(entryHandTarget({ ...creator, step: 'brand' })).toBeNull();
  });
});
