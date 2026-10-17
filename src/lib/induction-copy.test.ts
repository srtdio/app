import { describe, expect, it } from 'vitest';
import * as copy from './induction-copy';
import * as routes from './induction-routes';
import type { CopyContext } from './induction-model';

const { CHECK_EMAIL_COPY, RECOVERY_COPY, WELCOME_COPY, fillCopy, hasUnfilledPlaceholder } = copy;

const FULL: CopyContext = {
  brand: 'Bloom',
  platform: 'Instagram',
  post: 'Launch day',
  creator: 'Asha',
  inviter: 'Ravi',
  email: 'a@b.co',
};

const EMPTY: CopyContext = {
  brand: '',
  platform: '',
  post: '',
  creator: '',
  inviter: '',
  email: '',
};

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

const ALL_STRINGS = [...stringsIn({ ...copy }), ...stringsIn({ ...routes })];

describe('fillCopy', () => {
  it('fills every placeholder from a full context', () => {
    expect(fillCopy('{BRAND}: {brand} on {platform}', FULL)).toBe('BLOOM: Bloom on Instagram');
    expect(fillCopy('Tap to open {post}', FULL)).toBe('Tap to open Launch day');
    expect(fillCopy('{creator} and {inviter}, {email}', FULL)).toBe('Asha and Ravi, a@b.co');
  });

  it('falls back on empty fields, capitalised at a sentence start', () => {
    expect(fillCopy('{BRAND}', EMPTY)).toBe('YOUR WORKSPACE');
    expect(fillCopy('Welcome to {brand}', EMPTY)).toBe('Welcome to your workspace');
    expect(fillCopy("{brand}'s approvers have it.", EMPTY)).toBe(
      "Your workspace's approvers have it.",
    );
    expect(fillCopy('{post} is waiting. Open {post}', EMPTY)).toBe(
      'Your post is waiting. Open your post',
    );
    expect(fillCopy('{creator} sent it.', EMPTY)).toBe('Your team sent it.');
    expect(fillCopy('{inviter} invited you.', EMPTY)).toBe('The team invited you.');
    expect(fillCopy('How {platform} crops', EMPTY)).toBe('How Instagram crops');
    expect(fillCopy('Joining as {email}', EMPTY)).toBe('Joining as ');
  });

  it('leaves no placeholder in any exported string, full or empty context', () => {
    for (const text of ALL_STRINGS) {
      expect(hasUnfilledPlaceholder(fillCopy(text, FULL)), text).toBe(false);
      expect(hasUnfilledPlaceholder(fillCopy(text, EMPTY)), text).toBe(false);
    }
  });

  it('hasUnfilledPlaceholder spots a brace token', () => {
    expect(hasUnfilledPlaceholder('Hi {brand}')).toBe(true);
    expect(hasUnfilledPlaceholder('Hi Bloom')).toBe(false);
  });
});

describe('copy hygiene', () => {
  it('no em-dash or en-dash in any exported string', () => {
    expect(ALL_STRINGS.length).toBeGreaterThan(50);
    for (const text of ALL_STRINGS) {
      expect(text, text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('guide chrome', () => {
    expect(copy.GUIDE_LEGEND).toBe(
      'When the hand taps a control, it is your turn. Back goes one step back.',
    );
    expect('skip' in copy.GUIDE_CHROME).toBe(false);
    expect(copy.GUIDE_CHROME).toMatchObject({
      back: 'Back',
      chapters: { ask: 'Ask', review: 'Review', talk: 'Talk' },
    });
  });
});

describe('entry screen copy is unchanged', () => {
  it('CHECK_EMAIL_COPY', () => {
    expect(CHECK_EMAIL_COPY).toEqual({
      signUpSubtitle: 'No card needed.',
      title: 'Check your email',
      body: 'We sent a sign-in link to {email}. Open it on this device to carry on.',
      resend: 'Resend link',
      differentEmail: 'Use a different email',
      createAccount: 'Create account',
      sending: 'Sending link',
      rateLimited: 'Too many links asked for. Wait a few minutes, then try again.',
    });
  });

  it('the sign-up button lines carry no dash', () => {
    for (const text of [
      CHECK_EMAIL_COPY.createAccount,
      CHECK_EMAIL_COPY.sending,
      CHECK_EMAIL_COPY.rateLimited,
    ]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('WELCOME_COPY', () => {
    expect(WELCOME_COPY).toEqual({
      heading: 'Welcome to {brand}',
      creatorSubline: '{inviter} invited you to create posts with the team.',
      approverSubline: '{inviter} invited you to review posts for the team.',
      fallbackInviter: 'The team',
      joiningAs: 'Joining as {email}',
      continue: 'Continue',
      notYou: 'Not you? Sign in with a different email',
    });
  });

  it('RECOVERY_COPY', () => {
    expect(RECOVERY_COPY).toEqual({
      expired:
        'This invitation link has expired. Ask the person who invited you to send a new one.',
      signIn: 'Sign in',
      wrongAccount:
        'This invitation was sent to a different email. Sign in with that email to join.',
      differentEmail: 'Sign in with a different email',
    });
  });
});

describe('cards', () => {
  it('fill to the expected lines', () => {
    const { creator, invited, approver } = routes.ROUTE_SCRIPTS;
    expect(fillCopy(creator.intro.eyebrow ?? '', FULL)).toBe('KESTREL & ROWE · SAMPLE WEEK');
    expect(fillCopy(approver.intro.title, FULL)).toBe('Launch day is waiting for you');
    expect(fillCopy(invited.closing.body, FULL)).toBe("Bloom's approvers have it.");
    expect(creator.intro.button).toBe('Start');
    expect(approver.closing.button).toBe('Done');
  });
});
