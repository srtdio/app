import { describe, expect, it } from 'vitest';
import {
  defaultGroupName,
  gettingStartedItems,
  initialsOf,
  inviteRoleFor,
  normalizeUsernameInput,
  peopleLine,
  progressSteps,
  roleGroupsFor,
  stepsFor,
  suggestUsername,
  usernameFormat,
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

describe('stepsFor', () => {
  it('walks a self sign-up through profile, workspace, first post and invites', () => {
    expect(stepsFor({ profileIncomplete: true, hasWorkspace: false })).toEqual([
      'name',
      'role',
      'quick',
      'workspace',
      'firstpost',
      'invite',
    ]);
  });
  it('walks an invitee through password, profile and what is waiting', () => {
    expect(stepsFor({ profileIncomplete: true, hasWorkspace: true })).toEqual([
      'password',
      'name',
      'role',
      'ready',
    ]);
  });
  it('sends a finished profile with no workspace straight to making one', () => {
    expect(stepsFor({ profileIncomplete: false, hasWorkspace: false })).toEqual([
      'workspace',
      'firstpost',
      'invite',
    ]);
  });
  it('shows nothing once profile and workspace both exist', () => {
    expect(stepsFor({ profileIncomplete: false, hasWorkspace: true })).toEqual([]);
  });
  it('keeps the ready screen out of the progress bar', () => {
    expect(progressSteps(['password', 'name', 'role', 'ready'])).toEqual([
      'password',
      'name',
      'role',
    ]);
  });
});

describe('roles and invites', () => {
  it('puts brand-side roles first for clients only', () => {
    expect(roleGroupsFor(true)[0]?.label).toBe('Brand side');
    expect(roleGroupsFor(false)[0]?.label).toBe('Agency');
  });
  it('maps sides to invite roles', () => {
    expect(inviteRoleFor('client')).toBe('client');
    expect(inviteRoleFor('team')).toBe('agency');
  });
});

describe('gettingStartedItems', () => {
  it('opens with the workspace done and marks the rest from facts', () => {
    const items = gettingStartedItems({ postsSent: 1, clientsInvited: 0, assets: 0 });
    expect(items.map((item) => item.done)).toEqual([true, true, false, false]);
  });
});

describe('defaultGroupName', () => {
  it('matches the database rule', () => {
    expect(defaultGroupName('Kite & Co')).toBe('Kite and Co');
    expect(defaultGroupName("Tara's Jewels!")).toBe('Taras Jewels');
    expect(defaultGroupName('&&')).toBe('and and');
    expect(defaultGroupName('!!!')).toBe('Team');
  });
});

describe('ready screen text', () => {
  it('summarises people by first name', () => {
    expect(peopleLine([])).toBe('Your agency team');
    expect(peopleLine(['Arjun Shah'])).toBe('Arjun');
    expect(peopleLine(['Arjun Shah', 'Dev Rao'])).toBe('Arjun and Dev');
    expect(peopleLine(['A B', 'C D', 'E F', 'G H'])).toBe('A, C and 2 more');
  });
  it('makes tile initials, skipping "and"', () => {
    expect(initialsOf('Kite and Co')).toBe('KC');
    expect(initialsOf('Inside Edge')).toBe('IE');
    expect(initialsOf('')).toBe('S');
  });
});
