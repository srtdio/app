import { describe, expect, it } from 'vitest';
import {
  ON_BEHALF_OF_CLIENT,
  canDeletePost,
  isAgencySide,
  isClient,
  onBehalfOf,
  onBehalfSuffix,
} from '@/components/pages/pcs/roles';
import { agencyReviewHelper, onBehalfConfirmLine } from '@/components/pages/pcs/stage-actions';

describe('canDeletePost', () => {
  it('owner, admin and agency may delete a post', () => {
    expect(canDeletePost('owner')).toBe(true);
    expect(canDeletePost('admin')).toBe(true);
    expect(canDeletePost('agency')).toBe(true);
  });

  it('client and an unknown role never may', () => {
    expect(canDeletePost('client')).toBe(false);
    expect(canDeletePost(null)).toBe(false);
  });
});

describe('onBehalfSuffix', () => {
  it('suffixes an agency-side role', () => {
    for (const role of ['owner', 'admin', 'agency']) {
      expect(onBehalfSuffix(role, null)).toBe(` ${ON_BEHALF_OF_CLIENT}`);
    }
    expect(ON_BEHALF_OF_CLIENT).toBe('on behalf of the approvers');
  });

  it('adds nothing for the client, a missing role or an old row', () => {
    expect(onBehalfSuffix('client', 'Zomato')).toBe('');
    expect(onBehalfSuffix(null, 'Zomato')).toBe('');
    expect(onBehalfSuffix(undefined, 'Zomato')).toBe('');
    expect(onBehalfSuffix('', 'Zomato')).toBe('');
  });
});

describe('on-behalf label', () => {
  it('names the workspace brand', () => {
    expect(`Chitra${onBehalfSuffix('agency', 'Zomato')}`).toBe('Chitra on behalf of Zomato');
    expect(onBehalfConfirmLine('Zomato')).toBe('You are approving on behalf of Zomato.');
    expect(agencyReviewHelper('Zomato')).toBe(
      "Waiting on Zomato's approvers. You can approve on their behalf.",
    );
  });

  it('falls back to "the approvers" without a brand, never "client"', () => {
    for (const brand of [null, undefined, '', '   ']) {
      expect(onBehalfOf(brand)).toBe('on behalf of the approvers');
      expect(onBehalfSuffix('owner', brand)).toBe(' on behalf of the approvers');
    }
    expect(onBehalfConfirmLine(null)).toBe('You are approving on behalf of the approvers.');
    expect(agencyReviewHelper(null)).toBe('Waiting on approvers. You can approve on their behalf.');
  });
});

describe('isClient / isAgencySide', () => {
  it('splits the four roles', () => {
    expect(isClient('client')).toBe(true);
    expect(isAgencySide('client')).toBe(false);
    expect(isAgencySide('agency')).toBe(true);
    expect(isClient(null) || isAgencySide(null)).toBe(false);
  });
});
