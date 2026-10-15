import { describe, expect, it } from 'vitest';
import {
  AGE_RANGES,
  OTHER_ROLE,
  ROLE_TILES,
  SIDE_TILES,
  designationFor,
  normalizeUsernameInput,
  progressSteps,
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

  it('walks an invitee through password, name and role (their side comes from the invite)', () => {
    expect(stepsFor({ ...SELF, hasWorkspace: true })).toEqual(['password', 'name', 'role']);
    expect(stepsFor({ ...SELF, hasWorkspace: true, side: 'approver' })).toEqual([
      'password',
      'name',
      'role',
    ]);
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

  it('mirrors the age ranges the database accepts', () => {
    expect(AGE_RANGES).toEqual(['18-24', '25-34', '35-44', '45-54', '55+']);
  });
});
