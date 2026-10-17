// The route scripts of onboarding v13: which steps each route runs, in order,
// which control each step boxes, what finishes it and what drops it. Pure data
// plus three lookups; the engine (src/lib/induction.ts) walks these. Strings
// come from src/lib/induction-copy.ts, ids carry the route prefix.

import { INDUCTION_KEYS as K } from './induction-keys';
import { CARD_COPY, GUIDE_CHROME, STEP_COPY } from './induction-copy';
import {
  ROUTE_PREFIX,
  type Card,
  type Chapter,
  type InductionFacts,
  type Route,
  type RouteScript,
  type SkipWhen,
  type Step,
} from './induction-model';

type StepCopyKey = keyof typeof STEP_COPY;

/** Everything a step needs besides its id, route and copy. */
type StepShape = Omit<Step, 'id' | 'route' | 'label' | 'why' | 'laterLabel'>;

function makeStep(route: Route, copyKey: StepCopyKey, shape: StepShape): Step {
  return { id: `${ROUTE_PREFIX[route]}${copyKey}`, route, ...STEP_COPY[copyKey], ...shape };
}

/** Same as makeStep, but the copy key differs from the short id (route-specific lines). */
function makeStepWithCopy(
  route: Route,
  shortId: string,
  copy: { key: StepCopyKey; shape: StepShape },
): Step {
  return { ...makeStep(route, copy.key, copy.shape), id: `${ROUTE_PREFIX[route]}${shortId}` };
}

function teach(place: Step['place'], target: Step['targets'][number]): StepShape {
  return { kind: 'teach', place, targets: [target], dataDone: 'none' };
}

function inChapter(chapter: Chapter, shape: StepShape, skipWhen?: readonly SkipWhen[]): StepShape {
  return skipWhen === undefined ? { ...shape, chapter } : { ...shape, chapter, skipWhen };
}

// ---------- setup phases ----------

function creatorWorkspaceSteps(): Step[] {
  const phase = 'Step 1';
  return [
    makeStep('creator', 'workspace', {
      phase,
      kind: 'setup',
      place: 'shell',
      targets: [K.topbarWorkspaceSlot],
      dataDone: 'hasWorkspace',
    }),
    makeStep('creator', 'workspace_create', {
      phase,
      kind: 'setup',
      place: 'shell',
      targets: [K.workspaceCreateSubmit],
      dataDone: 'hasWorkspace',
    }),
  ];
}

function approvedChipStep(route: Route, phase: string): Step {
  return makeStep(route, 'approved_chip', { ...teach('pipeline', K.pipelineApprovedChip), phase });
}

/** The first post: open the sheet, caption, format, single image, photo, send. */
function firstPostSteps(route: Route, phase: string): Step[] {
  const sent = { phase, dataDone: 'firstPostSent' } as const;
  const sendCopy: StepCopyKey = route === 'creator' ? 'post_send' : 'post_send_invited';
  return [
    makeStep(route, 'post_create', { ...teach('pipeline', K.pipelineCreate), ...sent }),
    makeStep(route, 'post_caption', { ...teach('pipeline', K.postSheetCaption), ...sent }),
    makeStep(route, 'post_format', { ...teach('pipeline', K.postSheetFormat), ...sent }),
    makeStep(route, 'post_single', { ...teach('pipeline', K.postSheetFormatSingle), ...sent }),
    makeStep(route, 'post_media', { ...teach('pipeline', K.postSheetMedia), ...sent }),
    makeStepWithCopy(route, 'post_send', {
      key: sendCopy,
      shape: { ...teach('pipeline', K.postSheetPrimary), ...sent, kind: 'gate' },
    }),
  ];
}

function creatorInviteSteps(): Step[] {
  const phase = 'Step 4';
  return [
    makeStep('creator', 'approver_invite', {
      phase,
      kind: 'gate',
      place: 'members',
      targets: [K.membersInvite],
      dataDone: 'clientInvited',
    }),
    makeStep('creator', 'team_invite', {
      phase,
      kind: 'optional',
      place: 'members',
      targets: [K.membersInvite],
      dataDone: 'teamInvited',
    }),
  ];
}

// ---------- look-around chapters ----------

function teamAskSteps(route: Route): Step[] {
  return [
    makeStep(
      route,
      'brief_open',
      inChapter('ask', teach('briefs', K.briefsFirstCard), ['noBrief']),
    ),
    makeStep(
      route,
      'plan_open',
      inChapter('ask', teach('group', K.briefOpenPlan), ['noGroup', 'noPlan']),
    ),
  ];
}

/** Comment on one line of a post; the approver's last line differs. */
function reviewCommentSteps(route: Route, skip: SkipWhen): Step[] {
  const review = (target: Step['targets'][number]): StepShape =>
    inChapter('review', teach('post', target), [skip]);
  return [
    makeStep(route, 'line_select', review(K.postCaptionText)),
    makeStep(route, 'comment_button', review(K.postCommentButton)),
    makeStepWithCopy(route, 'comment_post', {
      key: route === 'approver' ? 'comment_post_approver' : 'comment_post',
      shape: review(K.postCommentPost),
    }),
  ];
}

function talkSteps(route: Route): Step[] {
  return [
    makeStep(
      route,
      'group_open',
      inChapter('talk', teach('chat', K.chatDefaultGroupRow), ['noGroup']),
    ),
    makeStep(
      route,
      'transcript',
      inChapter('talk', teach('group', K.chatTranscript), ['noGroup', 'noVoiceNote']),
    ),
    makeStep(route, 'activity', inChapter('talk', teach('chat', K.activityTab))),
  ];
}

function teamLookAround(route: Route): Step[] {
  return [...teamAskSteps(route), ...reviewCommentSteps(route, 'noOwnPost'), ...talkSteps(route)];
}

function approverReviewSteps(): Step[] {
  const review = (target: Step['targets'][number], place: Step['place']): StepShape =>
    inChapter('review', teach(place, target), ['noReviewPost']);
  return [
    makeStep('approver', 'post_open', review(K.pipelinePostRow, 'pipeline')),
    ...reviewCommentSteps('approver', 'noReviewPost'),
    makeStep('approver', 'approve', review(K.postApprove, 'post')),
    makeStep('approver', 'approve_confirm', review(K.postApproveConfirm, 'post')),
  ];
}

function approverAskSteps(): Step[] {
  const ask = (target: Step['targets'][number]): StepShape =>
    inChapter('ask', teach('briefs', target), ['cannotCreateBrief']);
  return [
    makeStep('approver', 'brief_add', ask(K.briefsNew)),
    makeStep('approver', 'brief_title', ask(K.briefSheetTitle)),
    makeStep('approver', 'brief_objective', ask(K.briefSheetObjective)),
    makeStep('approver', 'brief_create', ask(K.briefSheetCreate)),
  ];
}

// ---------- cards ----------

type CardCopy = Omit<Card, 'id' | 'route' | 'kind' | 'pills'>;

function introCard(route: Route, copy: CardCopy, chapters: readonly Chapter[]): Card {
  const pills = chapters.map((chapter) => GUIDE_CHROME.chapters[chapter]);
  return { id: `${ROUTE_PREFIX[route]}intro`, route, kind: 'intro', ...copy, pills };
}

function closingCard(route: Route, copy: CardCopy): Card {
  return { id: `${ROUTE_PREFIX[route]}closing`, route, kind: 'closing', ...copy };
}

const TEAM_CHAPTERS: readonly Chapter[] = ['ask', 'review', 'talk'];
const APPROVER_CHAPTERS: readonly Chapter[] = ['review', 'ask', 'talk'];

// ---------- scripts ----------

export const ROUTE_SCRIPTS: Readonly<Record<Route, RouteScript>> = {
  creator: {
    route: 'creator',
    entrySteps: 4,
    steps: [
      ...creatorWorkspaceSteps(),
      approvedChipStep('creator', 'Step 2'),
      ...firstPostSteps('creator', 'Step 3'),
      ...creatorInviteSteps(),
      ...teamLookAround('creator'),
    ],
    intro: introCard('creator', CARD_COPY.creatorIntro, TEAM_CHAPTERS),
    closing: closingCard('creator', CARD_COPY.creatorClosing),
  },
  invited: {
    route: 'invited',
    entrySteps: 3,
    steps: [
      approvedChipStep('invited', 'First post'),
      ...firstPostSteps('invited', 'First post'),
      ...teamLookAround('invited'),
    ],
    intro: introCard('invited', CARD_COPY.invitedIntro, TEAM_CHAPTERS),
    closing: closingCard('invited', CARD_COPY.invitedClosing),
  },
  approver: {
    route: 'approver',
    entrySteps: 3,
    steps: [...approverReviewSteps(), ...approverAskSteps(), ...talkSteps('approver')],
    intro: introCard('approver', CARD_COPY.approverIntro, APPROVER_CHAPTERS),
    closing: closingCard('approver', CARD_COPY.approverClosing),
  },
};

// ---------- lookups ----------

/** Which route a person runs. No workspace yet means they are creating one. */
export function routeFor(input: { role: string | null; hasWorkspace: boolean }): Route | 'none' {
  if (!input.hasWorkspace) return 'creator';
  if (input.role === 'owner') return 'creator';
  if (input.role === 'admin' || input.role === 'agency') return 'invited';
  if (input.role === 'client') return 'approver';
  return 'none';
}

const ALL_STEPS: readonly Step[] = Object.values(ROUTE_SCRIPTS).flatMap((script) => script.steps);

export function stepById(id: string): Step | undefined {
  return ALL_STEPS.find((step) => step.id === id);
}

const SKIP_HOLDS: Readonly<Record<SkipWhen, (facts: InductionFacts) => boolean>> = {
  noBrief: (facts) => !facts.hasBrief,
  noPlan: (facts) => !facts.hasPlan,
  noReviewPost: (facts) => !facts.hasReviewPost,
  noOwnPost: (facts) => !facts.hasOwnPost,
  noGroup: (facts) => !facts.hasGroup,
  noVoiceNote: (facts) => !facts.hasVoiceNote,
  cannotCreateBrief: (facts) => facts.canCreateBrief === false,
};

/** False when a skip fact holds or the step belongs to the later sample week. */
export function isApplicable(step: Step, facts: InductionFacts): boolean {
  if (step.sampleOnly === true) return false;
  return !(step.skipWhen ?? []).some((skip) => SKIP_HOLDS[skip](facts));
}
