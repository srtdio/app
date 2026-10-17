// Every user-facing string of onboarding v13: the guide (labels, why lines,
// cards, bar), the entry screens (check your email, the invited welcome) and
// the invite recovery lines. {placeholders} are filled by fillCopy. No
// em-dashes. The invite emails live in supabase/functions/invite-send (Deno
// cannot import from src) and match the lines here.

/** Sign-up card and the check-your-email state (self sign-up). */
export const CHECK_EMAIL_COPY = {
  signUpSubtitle: 'No card needed.',
  title: 'Check your email',
  body: 'We sent a sign-in link to {email}. Open it on this device to carry on.',
  resend: 'Resend link',
  differentEmail: 'Use a different email',
} as const;

/** The invited welcome screen (replaces the invitee password step). */
export const WELCOME_COPY = {
  heading: 'Welcome to {brand}',
  creatorSubline: '{inviter} invited you to create posts with the team.',
  approverSubline: '{inviter} invited you to review posts for the team.',
  /** Used as {inviter} when the inviter's name is unavailable. */
  fallbackInviter: 'The team',
  joiningAs: 'Joining as {email}',
  continue: 'Continue',
  notYou: 'Not you? Sign in with a different email',
} as const;

/** Invite link recovery. */
export const RECOVERY_COPY = {
  expired: 'This invitation link has expired. Ask the person who invited you to send a new one.',
  signIn: 'Sign in',
  wrongAccount: 'This invitation was sent to a different email. Sign in with that email to join.',
  differentEmail: 'Sign in with a different email',
} as const;
