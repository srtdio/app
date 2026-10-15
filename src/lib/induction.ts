// Pure logic for the induction: the guided first run on the real screens
// (src/components/induction/**). No network, no React. Which step a person is
// on comes from the database (induction_state) plus the stored teach step
// (induction_step_set), so every rule here is a function of that state and is
// unit tested: the steps per role, resume, the two hard gates, where the card
// sits so it never covers the boxed control, and the upload copy of the first
// post.

/** The data-induction attribute values on the real controls. One place, never literals. */
export const INDUCTION_KEYS = {
  topbarWorkspaceSlot: 'topbar-workspace-slot',
  pipelineStageRow: 'pipeline-stage-row',
  pipelineCreate: 'pipeline-create',
  postSheetPrimary: 'post-sheet-primary',
  membersInvite: 'members-invite',
  postCommentComposer: 'post-comment-composer',
  postApprove: 'post-approve',
  assetsAdd: 'assets-add',
  activityList: 'activity-list',
  chatTab: 'chat-tab',
  chatHash: 'chat-hash',
  chatPlus: 'chat-plus',
  chatAttachTray: 'chat-attach-tray',
  chatTasks: 'chat-tasks',
  chatMic: 'chat-mic',
  chatPostCard: 'chat-post-card',
  pipelineDraftChip: 'pipeline-draft-chip',
  briefsNew: 'briefs-new',
} as const;

export type InductionKey = (typeof INDUCTION_KEYS)[keyof typeof INDUCTION_KEYS];

/** The CSS selector for one control. */
export function inductionSelector(key: InductionKey): string {
  return `[data-induction="${key}"]`;
}

/** Success sites dispatch this so the guide refetches induction_state at once. */
export const INDUCTION_REFRESH_EVENT = 'sorted:induction-refresh';

export function dispatchInductionRefresh(): void {
  window.dispatchEvent(new CustomEvent(INDUCTION_REFRESH_EVENT));
}

/** The 4 s poll, only while a gated step is active. */
export const INDUCTION_POLL_MS = 4000;

/**
 * Stored step ids outside the in-app list: the approver who signed up alone
 * (naming their team, then waiting for it) and the Creator's start.
 */
export const APPROVER_BRAND_STEP = 'approver_brand';
export const APPROVER_WAITING_STEP = 'approver_waiting';
export const WORKSPACE_STEP = 'workspace';

/** Where an approver who signed up alone is, from the stored step. */
export type ApproverStage = 'none' | 'brand' | 'waiting';

export function approverStageOf(state: Pick<InductionState, 'step' | 'done'>): ApproverStage {
  if (state.done) return 'none';
  if (state.step === APPROVER_BRAND_STEP) return 'brand';
  if (state.step === APPROVER_WAITING_STEP) return 'waiting';
  return 'none';
}

/** Mirrors the induction_step_set check (^[a-z0-9_]{1,40}$). */
export const STEP_ID_PATTERN = /^[a-z0-9_]{1,40}$/;

// ---------- state ----------

/** induction_state, narrowed. Fields the proc returns as null stay null. */
export interface InductionState {
  step: string | null;
  done: boolean;
  role: string | null;
  postId: string | null;
  clientInvited: boolean;
  teamInvited: boolean;
}

/**
 * The state used when induction_state cannot be read: done, so a failed read
 * never traps anyone in a guide. The next refetch (route change, event) heals it.
 */
export const FAIL_OPEN_STATE: InductionState = {
  step: null,
  done: true,
  role: null,
  postId: null,
  clientInvited: false,
  teamInvited: false,
};

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Narrow the jsonb induction_state returns; anything malformed fails open. */
export function parseInductionState(raw: unknown): InductionState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return FAIL_OPEN_STATE;
  const record = raw as Record<string, unknown>;
  return {
    step: stringField(record, 'step'),
    done: stringField(record, 'done_at') !== null,
    role: stringField(record, 'role'),
    postId: stringField(record, 'post_id'),
    clientInvited: record.client_invited === true,
    teamInvited: record.team_invited === true,
  };
}

// ---------- steps ----------

/** creator: the owner who signed up. approver: an invited client. teammate: an invited admin or agency member. */
export type InductionPath = 'creator' | 'approver' | 'teammate';

/**
 * The path for a workspace role. No workspace yet is the Creator who has to
 * make one. 'none' when the role is unknown (the guide stays off).
 */
export function pathFor(role: string | null, hasWorkspace: boolean): InductionPath | 'none' {
  if (!hasWorkspace) return 'creator';
  if (role === 'owner') return 'creator';
  if (role === 'admin' || role === 'agency') return 'teammate';
  if (role === 'client') return 'approver';
  return 'none';
}

/**
 * setup: done by the data, no buttons (the workspace). gate: a hard gate, no
 * Next and no Later, and leaving its page brings the person back. teach: Next.
 * optional: Next and Later.
 */
export type StepKind = 'setup' | 'gate' | 'teach' | 'optional';

/** Where a step lives; the route is built from it (see placeRoute). */
export type StepPlace =
  | 'shell'
  | 'pipeline'
  | 'members'
  | 'post'
  | 'assets'
  | 'briefs'
  | 'activity'
  | 'group';

export interface InductionStep {
  id: string;
  kind: StepKind;
  /** The "Step N of M" group: steps on one screen share it. */
  part: number;
  place: StepPlace;
  /** The controls to box, first visible wins (an open sheet's control before the page's). */
  targets: readonly InductionKey[];
  /** One line each. "{workspace}" reads the "<Brand> - <Platform>" label. */
  title: string;
  body: string;
  /** The Later button's words on an optional step. */
  laterLabel?: string;
}

const K = INDUCTION_KEYS;

const CHAT_HASH: Omit<InductionStep, 'id' | 'part'> = {
  kind: 'teach',
  place: 'group',
  targets: [K.chatHash],
  title: 'Type # to bring a post in',
  body: 'The post shows up as a card everyone can open.',
};

const CHAT_PLUS: Omit<InductionStep, 'id' | 'part'> = {
  kind: 'teach',
  place: 'group',
  targets: [K.chatAttachTray, K.chatPlus],
  title: 'Tap + to attach',
  body: 'Photos, files, brand assets, briefs and posts.',
};

const CHAT_TASKS: Omit<InductionStep, 'id' | 'part'> = {
  kind: 'teach',
  place: 'group',
  targets: [K.chatTasks],
  title: 'Tap the tick for tasks',
  body: 'Everything someone owes this group, in one list.',
};

const ACTIVITY: Omit<InductionStep, 'id' | 'part'> = {
  kind: 'teach',
  place: 'activity',
  targets: [K.activityList],
  title: 'Activity',
  body: 'Everything that happens lands here, newest first.',
};

export const CREATOR_STEPS: readonly InductionStep[] = [
  {
    id: WORKSPACE_STEP,
    kind: 'setup',
    part: 1,
    place: 'shell',
    targets: [K.topbarWorkspaceSlot],
    title: 'Create your workspace',
    body: 'Name it after the brand, then pick its platform.',
  },
  {
    id: 'stages',
    kind: 'teach',
    part: 2,
    place: 'pipeline',
    targets: [K.pipelineStageRow],
    title: 'Five stages',
    body: 'Every post lives in one of these. Review is where your approver looks.',
  },
  {
    id: 'first_post',
    kind: 'gate',
    part: 3,
    place: 'pipeline',
    targets: [K.postSheetPrimary, K.pipelineCreate],
    title: 'Send your first post for review',
    body: 'Add the caption and the creative, then send it.',
  },
  {
    id: 'approver_invite',
    kind: 'gate',
    part: 4,
    place: 'members',
    targets: [K.membersInvite],
    title: 'Invite your approver',
    body: 'Add their email with the role Approver. They read and approve here.',
  },
  {
    id: 'team_invite',
    kind: 'optional',
    part: 4,
    place: 'members',
    targets: [K.membersInvite],
    title: 'Add other creators',
    body: 'People who make the posts with you. Pick the role Creator.',
    laterLabel: "It's just me for now",
  },
  {
    id: 'post_comments',
    kind: 'teach',
    part: 5,
    place: 'post',
    targets: [K.postCommentComposer],
    title: 'Comments stay on the post',
    body: 'Your approver reads them here, not on WhatsApp.',
  },
  {
    id: 'post_approve',
    kind: 'teach',
    part: 5,
    place: 'post',
    targets: [K.postApprove],
    title: 'Approve',
    body: 'This one is for your approver.',
  },
  {
    id: 'assets',
    kind: 'teach',
    part: 6,
    place: 'assets',
    targets: [K.assetsAdd],
    title: 'Brand files go here',
    body: 'Logos, fonts and photos, in one place for everyone.',
  },
  { ...ACTIVITY, id: 'activity', part: 7 },
  { ...CHAT_HASH, id: 'chat_hash', part: 8 },
  { ...CHAT_PLUS, id: 'chat_plus', part: 8 },
  { ...CHAT_TASKS, id: 'chat_tasks', part: 8 },
  {
    id: 'chat_mic',
    kind: 'teach',
    part: 8,
    place: 'group',
    targets: [K.chatMic],
    title: 'Tap the mic for a voice note',
    body: 'Quicker than typing when you are on the move.',
  },
];

export const APPROVER_STEPS: readonly InductionStep[] = [
  {
    id: 'a_workspace',
    kind: 'teach',
    part: 1,
    place: 'pipeline',
    targets: [K.topbarWorkspaceSlot],
    title: '{workspace}',
    body: 'Posts waiting for your approval live here.',
  },
  {
    id: 'a_review',
    kind: 'teach',
    part: 2,
    place: 'pipeline',
    targets: [K.pipelineStageRow],
    title: 'Review',
    body: 'Posts waiting on you sit in Review.',
  },
  {
    id: 'a_points',
    kind: 'teach',
    part: 3,
    place: 'post',
    targets: [K.postCommentComposer],
    title: 'Add your points here',
    body: 'Comments stay on the post, so nothing gets lost.',
  },
  {
    id: 'a_approve',
    kind: 'teach',
    part: 3,
    place: 'post',
    targets: [K.postApprove],
    title: 'Approve when it is right',
    body: 'One post at a time. Comments keep it in review.',
  },
  {
    id: 'a_assets',
    kind: 'teach',
    part: 4,
    place: 'assets',
    targets: [K.assetsAdd],
    title: 'Brand files',
    body: 'Logos, fonts and photos your team works from.',
  },
  {
    id: 'a_briefs',
    kind: 'optional',
    part: 5,
    place: 'briefs',
    targets: [K.briefsNew],
    title: 'Write a brief',
    body: 'Tell your team what the next post needs.',
    laterLabel: 'Later',
  },
  { ...ACTIVITY, id: 'a_activity', part: 6 },
  {
    id: 'a_chat_card',
    kind: 'teach',
    part: 7,
    place: 'group',
    targets: [K.chatPostCard],
    title: 'Your post is in the group too',
    body: 'Its card reads Waiting on you until you decide.',
  },
  { ...CHAT_HASH, id: 'a_chat_hash', part: 7 },
  { ...CHAT_TASKS, id: 'a_chat_tasks', part: 7 },
];

export const TEAMMATE_STEPS: readonly InductionStep[] = [
  {
    id: 't_drafts',
    kind: 'teach',
    part: 1,
    place: 'pipeline',
    targets: [K.pipelineDraftChip],
    title: 'Drafts',
    body: 'Drafts are yours until you send them.',
  },
  {
    id: 't_post',
    kind: 'optional',
    part: 2,
    place: 'pipeline',
    targets: [K.postSheetPrimary, K.pipelineCreate],
    title: 'Start a post',
    body: 'Save it as a draft while you work on it.',
    laterLabel: 'Later',
  },
  {
    id: 't_assets',
    kind: 'optional',
    part: 3,
    place: 'assets',
    targets: [K.assetsAdd],
    title: 'Upload brand files',
    body: 'Put the files the team works from here.',
    laterLabel: 'Later',
  },
  { ...ACTIVITY, id: 't_activity', part: 4 },
  { ...CHAT_HASH, id: 't_chat_hash', part: 5 },
  { ...CHAT_PLUS, id: 't_chat_plus', part: 5 },
];

export function stepsForPath(path: InductionPath): readonly InductionStep[] {
  if (path === 'approver') return APPROVER_STEPS;
  if (path === 'teammate') return TEAMMATE_STEPS;
  return CREATOR_STEPS;
}

/** Every hard gate across the three paths (exactly two: first post, approver invite). */
export function hardGates(): InductionStep[] {
  return [...CREATOR_STEPS, ...APPROVER_STEPS, ...TEAMMATE_STEPS].filter((s) => s.kind === 'gate');
}

/** Which buttons a step's card shows. A hard gate and the setup step show none. */
export function stepButtons(step: Pick<InductionStep, 'kind'>): { next: boolean; later: boolean } {
  if (step.kind === 'teach') return { next: true, later: false };
  if (step.kind === 'optional') return { next: true, later: true };
  return { next: false, later: false };
}

/** Steps the data finishes; the guide polls while one is active. */
export function isGated(step: Pick<InductionStep, 'kind'>): boolean {
  return step.kind === 'gate' || step.kind === 'setup';
}

// ---------- resolution ----------

/** What the person's workspace can show right now. */
export interface InductionAvailability {
  hasWorkspace: boolean;
  /** A post to open for the post steps (the creator's sent post, the approver's first in review). */
  postId: string | null;
  /** The default group's chat channel id, for the group steps. */
  groupChannelId: string | null;
}

/** Whether the data already finished a step (a setup or gate, or the team invite). */
export function dataDone(
  step: Pick<InductionStep, 'id'>,
  state: InductionState,
  hasWorkspace: boolean,
): boolean {
  switch (step.id) {
    case WORKSPACE_STEP:
      return hasWorkspace;
    case 'first_post':
      return state.postId !== null;
    case 'approver_invite':
      return state.clientInvited;
    case 'team_invite':
      return state.teamInvited;
    default:
      return false;
  }
}

/**
 * Whether a step's screen exists. The Creator's post steps always count: they
 * come after the first post gate, which guarantees the post, so the numbering
 * never shifts once it is sent.
 */
function available(
  step: InductionStep,
  where: InductionAvailability,
  path: InductionPath,
): boolean {
  if (step.place === 'post') return path === 'creator' || where.postId !== null;
  // workspace_create makes the default group, so before a workspace it still counts.
  if (step.place === 'group') return where.groupChannelId !== null || !where.hasWorkspace;
  return true;
}

export type InductionResolution =
  | { kind: 'off' }
  | { kind: 'finish' }
  | {
      kind: 'step';
      step: InductionStep;
      /** The next step's id, or 'finish' after the last one. */
      nextId: string;
      /** "Step part of parts". */
      part: number;
      parts: number;
    };

/**
 * The step to show. Resume rule: the stored step, unless an earlier setup or
 * hard gate is still open (then that gate), skipping forward over anything the
 * data already finished. Steps whose screen is not available (no post to open,
 * no group) drop out and the numbering closes up. Past the end: finish.
 */
export function resolveStep(input: {
  path: InductionPath | 'none';
  state: InductionState;
  where: InductionAvailability;
}): InductionResolution {
  const { path, state, where } = input;
  if (state.done || path === 'none') return { kind: 'off' };
  const steps = stepsForPath(path).filter((step) => available(step, where, path));
  if (!where.hasWorkspace) {
    const setup = steps.find((step) => step.kind === 'setup');
    if (setup === undefined) return { kind: 'off' };
    return describe(steps, steps.indexOf(setup));
  }
  const stored = steps.findIndex((step) => step.id === state.step);
  const openGate = steps.findIndex(
    (step) => isGated(step) && !dataDone(step, state, where.hasWorkspace),
  );
  let at = stored < 0 ? 0 : stored;
  if (openGate >= 0 && openGate < at) at = openGate;
  while (at < steps.length) {
    const step = steps[at];
    if (step === undefined || !finishedByData(step, state, where.hasWorkspace)) break;
    at += 1;
  }
  if (at >= steps.length) return { kind: 'finish' };
  return describe(steps, at);
}

function finishedByData(
  step: InductionStep,
  state: InductionState,
  hasWorkspace: boolean,
): boolean {
  return (isGated(step) || step.id === 'team_invite') && dataDone(step, state, hasWorkspace);
}

function describe(steps: readonly InductionStep[], at: number): InductionResolution {
  const step = steps[at];
  if (step === undefined) return { kind: 'finish' };
  const parts = [...new Set(steps.map((s) => s.part))].sort((a, b) => a - b);
  return {
    kind: 'step',
    step,
    nextId: steps[at + 1]?.id ?? 'finish',
    part: parts.indexOf(step.part) + 1,
    parts: parts.length,
  };
}

/** The card's title and body with the workspace label filled in. */
export function stepCopy(
  step: Pick<InductionStep, 'title' | 'body'>,
  workspaceLabel: string,
): { title: string; body: string } {
  const fill = (text: string) => text.replace('{workspace}', workspaceLabel);
  return { title: fill(step.title), body: fill(step.body) };
}

export function stepCountLabel(part: number, parts: number): string {
  return `Step ${part} of ${parts}`;
}

// ---------- routes ----------

export interface PlaceContext {
  postId: string | null;
  groupChannelId: string | null;
}

/** The route that shows a step's screen ('' for the shell step, which lives anywhere). */
export function placeRoute(place: StepPlace, ctx: PlaceContext): string {
  switch (place) {
    case 'shell':
      return '';
    case 'pipeline':
      return '/pipeline';
    case 'members':
      return '/settings?panel=members';
    case 'post':
      return ctx.postId !== null ? `/posts/${ctx.postId}` : '/pipeline';
    case 'assets':
      return '/assets';
    case 'briefs':
      return '/briefs';
    case 'activity':
      return '/activity';
    case 'group':
      return ctx.groupChannelId !== null
        ? `/chat?channel=${encodeURIComponent(ctx.groupChannelId)}`
        : '/chat';
  }
}

/** Whether the current location already shows a step's screen. */
export function onPlace(
  place: StepPlace,
  location: { pathname: string; search: string },
  ctx: PlaceContext,
): boolean {
  if (place === 'shell') return true;
  if (place === 'members') return location.pathname === '/settings';
  if (place === 'group') {
    return (
      location.pathname === '/chat' &&
      new URLSearchParams(location.search).get('channel') === ctx.groupChannelId
    );
  }
  return location.pathname === placeRoute(place, ctx);
}

// ---------- geometry ----------

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 5px breathing room plus the 2px border: the box's outer edge sits 7px off the control. */
export const BOX_GAP = 5;
export const BOX_BORDER = 2;
const BOX_OUTSET = BOX_GAP + BOX_BORDER;

/** The accent box around a control's live rect. */
export function boxRect(target: Rect): Rect {
  return {
    top: target.top - BOX_OUTSET,
    left: target.left - BOX_OUTSET,
    width: target.width + BOX_OUTSET * 2,
    height: target.height + BOX_OUTSET * 2,
  };
}

/** How far inside the screen edge the box stays, so all four sides always show. */
export const BOX_SCREEN_EDGE = 2;

/**
 * The box kept inside the viewport. A control that runs to the screen edge (a
 * full-width row) gets its box pulled in rather than cut off.
 */
export function clampToViewport(rect: Rect, viewport: { width: number; height: number }): Rect {
  const left = Math.max(rect.left, BOX_SCREEN_EDGE);
  const top = Math.max(rect.top, BOX_SCREEN_EDGE);
  const right = Math.min(rect.left + rect.width, viewport.width - BOX_SCREEN_EDGE);
  const bottom = Math.min(rect.top + rect.height, viewport.height - BOX_SCREEN_EDGE);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** The box radius: the control's own radius grown by the outset, so the corners run parallel. */
export function boxRadius(controlRadiusPx: number): number {
  return Math.max(0, controlRadiusPx) + BOX_OUTSET;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

export type CardSide = 'bottom' | 'top' | 'below' | 'right' | 'left' | 'above';

const EDGE = 16;
const CARD_GAP = 8;

/**
 * Where the card goes so it never covers the boxed control. Phone: docked
 * bottom (above the tab bar) by default, docked top when the control sits in
 * the lower half or the bottom dock would cover it. Laptop: below, right, left
 * or above the box, whichever side has room, clamped inside the viewport.
 */
export function placeCard(input: {
  target: Rect;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  phone: boolean;
  /** Space the docks keep clear: the safe area top, and the tab bar plus safe area bottom. */
  insets: { top: number; bottom: number };
}): { side: CardSide; top: number; left: number } {
  const box = boxRect(input.target);
  const { card, viewport, insets } = input;
  if (input.phone) {
    const left = EDGE;
    const bottom = {
      side: 'bottom' as const,
      top: viewport.height - insets.bottom - CARD_GAP - card.height,
      left,
    };
    const top = { side: 'top' as const, top: insets.top + CARD_GAP, left };
    const lowerHalf = box.top + box.height / 2 > viewport.height / 2;
    const first = lowerHalf ? top : bottom;
    const second = lowerHalf ? bottom : top;
    return covers(first, card, box) && !covers(second, card, box) ? second : first;
  }
  const clampLeft = (x: number) => clamp(x, EDGE, viewport.width - EDGE - card.width);
  const clampTop = (y: number) => clamp(y, EDGE, viewport.height - EDGE - card.height);
  const options: { side: CardSide; top: number; left: number; fits: boolean }[] = [
    {
      side: 'below',
      top: box.top + box.height + CARD_GAP,
      left: clampLeft(box.left),
      fits:
        box.top + box.height + CARD_GAP >= EDGE &&
        box.top + box.height + CARD_GAP + card.height <= viewport.height - EDGE,
    },
    {
      side: 'right',
      top: clampTop(box.top),
      left: box.left + box.width + CARD_GAP,
      fits: box.left + box.width + CARD_GAP + card.width <= viewport.width - EDGE,
    },
    {
      side: 'left',
      top: clampTop(box.top),
      left: box.left - CARD_GAP - card.width,
      fits: box.left - CARD_GAP - card.width >= EDGE,
    },
    {
      side: 'above',
      top: box.top - CARD_GAP - card.height,
      left: clampLeft(box.left),
      fits:
        box.top - CARD_GAP - card.height >= EDGE && box.top - CARD_GAP <= viewport.height - EDGE,
    },
  ];
  // Never off screen: a side that does not fit is pulled inside the viewport,
  // and is taken only if it still keeps clear of the box.
  const inside = options.map((o) => ({ ...o, top: clampTop(o.top), left: clampLeft(o.left) }));
  const pick =
    options.find((o) => o.fits && !covers(o, card, box)) ??
    inside.find((o) => !covers(o, card, box)) ??
    inside[0];
  return { side: pick?.side ?? 'below', top: pick?.top ?? EDGE, left: pick?.left ?? EDGE };
}

function covers(
  at: { top: number; left: number },
  card: { width: number; height: number },
  box: Rect,
): boolean {
  return overlaps({ top: at.top, left: at.left, width: card.width, height: card.height }, box);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The one-line strip inside an open sheet or dialog: under its title, inside
 * the header's lower padding, stopping short of the close button.
 */
export function stripRect(title: Rect, dialog: Rect): Rect {
  const closeRoom = 44 + EDGE + CARD_GAP;
  return {
    top: title.top + title.height + 2,
    left: title.left,
    width: Math.max(120, dialog.left + dialog.width - closeRoom - title.left),
    height: 24,
  };
}

// ---------- the first post ----------

/**
 * How the post sheet opens on a post step. The sheet hides owner, bucket,
 * origin and brief, takes the title from the caption and asks for media when
 * the format needs it. `share` is the default group to post the card into, or
 * 'no_group' when the workspace has none (the sheet says so instead).
 */
export interface PostSheetPreset {
  primary: 'send_for_review' | 'save_draft';
  share: { channelId: string; groupName: string } | 'no_group';
}

/** Formats a post can go out without media. Everything else needs a photo or a video. */
const MEDIA_OPTIONAL_FORMATS: readonly string[] = ['text', 'link', 'thread'];

export function formatNeedsMedia(format: string): boolean {
  return format !== '' && !MEDIA_OPTIONAL_FORMATS.includes(format);
}

/** The post title the preset derives from the caption: its first line, cut at a word, 80 chars max. */
export function titleFromCaption(caption: string): string {
  const line = (caption.trim().split('\n')[0] ?? '').trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trimEnd();
}

/** Automatic retries after the first failed upload attempt. */
export const UPLOAD_RETRIES = 3;

function timesWord(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

/** The plain reason after the automatic retries ran out. */
export function uploadFailedReason(failedAttempts: number): string {
  return `The file did not reach us. Your connection dropped ${timesWord(failedAttempts)}. Try again or pick a smaller file.`;
}

export type RetryOutcome<T> = { ok: true; value: T } | { ok: false; failures: number };

/**
 * Run an attempt, then up to `retries` more while it fails. `onRetry` hears the
 * attempt number before each retry. Never throws: a throw counts as a failure.
 */
export async function withRetries<T>(
  attempt: () => Promise<{ ok: true; value: T } | { ok: false }>,
  retries: number,
  onRetry: (nextAttempt: number) => void,
): Promise<RetryOutcome<T>> {
  let failures = 0;
  for (let n = 0; n <= retries; n += 1) {
    if (n > 0) onRetry(n + 1);
    try {
      const result = await attempt();
      if (result.ok) return { ok: true, value: result.value };
    } catch {
      // A transport throw is one more failed attempt.
    }
    failures += 1;
  }
  return { ok: false, failures };
}

// ---------- the approver who signed up alone ----------

/** brand_agency_request failures as people read them. */
export function brandRequestErrorMessage(message: string): string {
  if (message.includes('too_many_requests')) {
    return 'You have sent this 5 times. Ask them to check spam, or write to us.';
  }
  if (message.includes('invalid_payload')) return 'Check the email address and try again.';
  return "We couldn't send that. Try again.";
}
