// Every user-facing string of onboarding v13: the guide (labels, why lines,
// cards, bar), the entry screens (check your email, the invited welcome) and
// the invite recovery lines. {placeholders} are filled by fillCopy. No
// em-dashes. The invite email copy is not here: it lives in
// supabase/functions/invite-send/handler.ts (Deno cannot import from src).

import type { CopyContext } from './induction-model';

/** Sign-in and sign-up cards and the enter-the-code step (email code, no link). */
export const CHECK_EMAIL_COPY = {
  subtitle: 'We email you a code. No password.',
  /** Read by the onboarding copy tests only; no screen shows a link line any more. */
  body: 'We sent a link to {email}. Open it on this device to finish signing up.',
  differentEmail: 'Use a different email',
  sendCode: 'Send code',
  sendingCode: 'Sending code',
  codeTitle: 'Enter the code',
  sentTo: 'Sent to {email}',
  /** Followed by the cooldown as m:ss: "Resend in 0:28". */
  resendIn: 'Resend in',
  resendCode: 'Resend code',
  wrongCode: "That code didn't work. Try again.",
  /** Followed by the tappable resendCode action. */
  expiredCode: 'That code has expired.',
  rateLimited: 'Too many tries. Wait a minute and try again.',
  /** Shown under the email field when it loses focus with a malformed address. */
  invalidEmail: 'Enter a valid email, like name@company.com',
  /** Any other refusal from the code request: never the raw provider text. */
  genericError: "Couldn't send the code. Try again.",
} as const;

/** The pre-app screens (OnboardingFlow): only the lines that changed in W11. */
export const ONBOARDING_COPY = {
  sideTitle: "How you'll use Sorted",
  addPhoto: 'Add a photo (optional)',
  changePhoto: 'Change photo',
  photoHint: 'People see it next to your comments.',
  photoUploadFailed: "Couldn't upload your photo. You can add it later in settings.",
  jobTitleLabel: 'Job title (optional)',
  changeRole: 'Wrong role? Change it',
  makePostsAfterAll: 'I make the posts after all',
  differentEmail: 'Use a different email',
  signOut: 'Sign out',
} as const;

/**
 * The make-a-workspace dialog (WorkspaceSwitcher): a self-signed-up Creator who
 * approves posts after all, and the discard ask for a half-filled form.
 */
export const WORKSPACE_CREATE_COPY = {
  approveInstead: 'I approve posts instead',
  switchTitle: 'Switch to Approver?',
  switchMessage: "You'll tell us your brand and invite the team that makes your posts.",
  keepCreator: 'Keep as Creator',
  switchConfirm: 'Switch',
  switching: 'Switching',
  switchFailed: "Couldn't switch. Try again.",
  discardTitle: 'Discard this workspace?',
  discardMessage: 'The brand name and platform you picked will be lost.',
  discardConfirm: 'Discard',
  keepEditing: 'Keep editing',
} as const;

/** The email link's landing page when the link confirms a new account (type signup or email). */
export const SIGNUP_CALLBACK_COPY = {
  title: 'Confirm your email',
  subtitle: 'Tap the button to finish creating your account.',
  button: 'Continue',
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

// ---------- placeholders ----------

const PLACEHOLDER = /\{(brand|BRAND|platform|post|creator|inviter|email)\}/g;
const ANY_PLACEHOLDER = /\{[A-Za-z]+\}/;

type PlaceholderName = 'brand' | 'BRAND' | 'platform' | 'post' | 'creator' | 'inviter' | 'email';

/** What an empty field reads as, mid-sentence. Sentence starts are capitalised. */
const FALLBACK: Readonly<Record<PlaceholderName, string>> = {
  brand: 'your workspace',
  BRAND: 'YOUR WORKSPACE',
  platform: 'Instagram',
  post: 'your post',
  creator: 'your team',
  inviter: 'the team',
  email: '',
};

function contextValue(name: PlaceholderName, ctx: CopyContext): string {
  return name === 'BRAND' ? ctx.brand.toUpperCase() : ctx[name];
}

function startsSentence(text: string, offset: number): boolean {
  const before = text.slice(0, offset).trimEnd();
  return before === '' || /[.!?]$/.test(before);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Replaces every {placeholder} from the context; an empty field falls back. */
export function fillCopy(text: string, ctx: CopyContext): string {
  return text.replace(PLACEHOLDER, (_match: string, name: PlaceholderName, offset: number) => {
    const value = contextValue(name, ctx);
    if (value !== '') return value;
    const fallback = FALLBACK[name];
    return startsSentence(text, offset) ? capitalise(fallback) : fallback;
  });
}

/** True while any {placeholder} is left in the text. */
export function hasUnfilledPlaceholder(text: string): boolean {
  return ANY_PLACEHOLDER.test(text);
}

// ---------- guide bar ----------

export const GUIDE_CHROME = {
  back: 'Back',
  next: 'Next',
  chapters: { ask: 'Ask', review: 'Review', talk: 'Talk' },
  barAria: 'Guide',
  progressAria: 'Tour progress',
  backAria: 'Go one step back',
  /** On every step bar and the intro card: ends the tour. */
  skip: 'Skip tour',
  /** The avatar menu row that runs the tour again. */
  restart: 'Restart tour',
} as const;

// ---------- the first post ----------

/** What a tap fills on the first post (the sheet's fill on tap). The photo ships in public/. */
export const FIRST_POST_SAMPLE = {
  caption: 'Launch day\nThe new range is here.',
  photoPath: '/induction/first-post.jpg',
  photoName: 'first-post.jpg',
} as const;

// ---------- steps ----------

interface StepCopy {
  label: string;
  why: string;
  laterLabel?: string;
  pauseWhy?: string;
  fieldLabel?: string;
}

/** The pill and the why line per step, keyed by the step id without its route prefix. */
export const STEP_COPY = {
  workspace: { label: 'Your brand first', why: '' },
  workspace_continue: { label: 'Tap Continue', why: '' },
  workspace_create: { label: 'Tap Create', why: '' },
  approved_chip: { label: 'Tap Approved to filter', why: 'Every post sits in one of five stages.' },
  post_create: { label: 'Tap to create a post', why: 'Your first post starts here.' },
  post_caption: { label: 'Tap to write the caption', why: 'The first line becomes the title.' },
  post_format: { label: 'Tap to pick a format', why: 'Reel, carousel, story or one image.' },
  post_single: { label: 'Pick Single image', why: 'One photo for this post.' },
  post_media: { label: 'Tap to add a photo', why: 'It shows how {platform} will crop it.' },
  post_send: { label: 'Tap to send for review', why: 'Next, you invite your approver.' },
  post_send_invited: { label: 'Tap to send for review', why: 'The approvers get it.' },
  approver_invite: {
    label: 'Tap Send invite',
    why: '',
    laterLabel: 'Invite later',
    fieldLabel: "Type your approver's email",
  },
  team_invite: { label: 'Tap Send invite', why: '', laterLabel: "It's just me for now" },
  brief_open: { label: 'Tap to open the brief', why: 'This is what the client asked for.' },
  plan_open: { label: 'Tap to open the plan', why: 'Plan the content together.' },
  line_select: { label: 'Select text to comment', why: 'Comment on exactly that line.' },
  comment_button: { label: 'Tap Comment', why: 'Your note sticks to that line.' },
  comment_post: { label: 'Tap to post the comment', why: 'It stays on the post, not on WhatsApp.' },
  comment_post_approver: { label: 'Tap to post the comment', why: 'The team sees it on the post.' },
  group_open: { label: 'Tap to open the group', why: 'Team and client, in one place.' },
  highlight_tap: {
    label: 'Tap the highlighted text',
    why: 'Each highlight is a comment on that line.',
  },
  reply_button: { label: 'Tap Reply', why: 'Answer right under that comment.' },
  reply_post: { label: 'Tap to post your reply', why: 'It stays on the post, not on WhatsApp.' },
  group_open_after_reply: {
    label: 'Tap to open the group',
    why: 'Team and client, in one place.',
    pauseWhy: 'Your reply is on the post. Tap Next.',
  },
  group_open_after_comment: {
    label: 'Tap to open the group',
    why: 'Team and client, in one place.',
    pauseWhy: 'Your comment is on the post. Tap Next.',
  },
  transcript: { label: 'Tap to show the transcript', why: 'Voice notes come written out.' },
  activity: { label: 'Tap to open Activity', why: 'Everything lands here, newest first.' },
  post_open: { label: 'Tap to open {post}', why: '{creator} sent it for your review.' },
  approve: { label: 'Tap to approve the post', why: 'You decide, one post at a time.' },
  approve_confirm: { label: 'Tap to confirm', why: 'Who, what and when, on record.' },
  brief_add: { label: 'Tap to add a brief', why: 'Tell the team what you want.' },
  brief_title: { label: 'Tap to name the brief', why: 'Say what it is.' },
  brief_objective: { label: 'Tap to write the objective', why: 'What should it achieve?' },
  brief_create: { label: 'Tap to create the brief', why: 'The team sees it at once.' },
} as const satisfies Record<string, StepCopy>;

// ---------- cards ----------

/** The card after the creator's look-around, before the closing card: the sample week clears. */
export const CLEAR_CARD_COPY = {
  eyebrow: 'ALL THREE CHAPTERS DONE',
  title: "That was Kestrel & Rowe's week",
  body: 'Clearing it now. Your post stays.',
  button: 'Clear it',
  thingsDone: 'things you did',
  timeTaken: 'to see it all',
  clearing: 'Clearing',
} as const;

/** Intro and closing cards per route. Pills come from GUIDE_CHROME.chapters. */
export const CARD_COPY = {
  creatorIntro: {
    eyebrow: 'KESTREL & ROWE · SAMPLE WEEK',
    title: 'Have a look around',
    body: "About a minute, all taps. It clears when you're done.",
    button: 'Start',
  },
  invitedIntro: {
    eyebrow: '{BRAND}',
    title: 'Have a look around',
    body: "The team's briefs, comments and chat. About a minute, all taps.",
    button: 'Start',
  },
  approverIntro: {
    eyebrow: '{BRAND}',
    title: '{post} is waiting for you',
    body: '{creator} sent a post for review. About half a minute, all taps.',
    button: 'Start',
  },
  creatorClosing: {
    title: 'Your space, your post',
    body: '{post} is waiting for your approver.',
    button: 'Done',
  },
  invitedClosing: {
    title: 'Your first post is in review',
    body: "{brand}'s approvers have it.",
    button: 'Done',
  },
  approverClosing: {
    title: 'Your first approval is on record',
    body: '{post} is approved and your brief is with the team.',
    button: 'Done',
  },
} as const;
