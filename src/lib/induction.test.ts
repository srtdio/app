import { describe, expect, it, vi } from 'vitest';
import {
  FAIL_OPEN_STATE,
  approverStageOf,
  backIndex,
  barSide,
  boxRect,
  brandRequestErrorMessage,
  chapterOrder,
  clampToViewport,
  completesByUi,
  formatNeedsMedia,
  guideRadius,
  handPoint,
  onPlace,
  overlaps,
  parseInductionState,
  placeLabel,
  placeRoute,
  presetPrimaryFor,
  progressOf,
  resolveGuide,
  skipTarget,
  stepDataDone,
  storedIdFor,
  titleFromCaption,
  uploadFailedReason,
  withRetries,
  WORKSPACE_STEP,
  type EngineInput,
  type InductionState,
  type Resolution,
  type StepProbe,
} from './induction';
import type { InductionFacts, RouteScript, Step } from './induction-model';
import { ROUTE_SCRIPTS } from './induction-routes';

// ---------- fixtures ----------

function step(id: string, shape: Partial<Step> = {}): Step {
  return {
    id,
    route: 'creator',
    kind: 'teach',
    targets: ['pipeline-create'],
    label: `Tap ${id}`,
    why: '',
    place: 'pipeline',
    dataDone: 'none',
    ...shape,
  };
}

const SCRIPT: RouteScript = {
  route: 'creator',
  entrySteps: 4,
  steps: [
    step('c_ws', { kind: 'setup', dataDone: 'hasWorkspace', phase: 'Step 1', place: 'shell' }),
    step('c_ws_create', { kind: 'setup', dataDone: 'hasWorkspace', phase: 'Step 1' }),
    step('c_chip', { phase: 'Step 2' }),
    step('c_post_create', { dataDone: 'firstPostSent', phase: 'Step 3' }),
    step('c_post_caption', { dataDone: 'firstPostSent', phase: 'Step 3' }),
    step('c_post_send', { kind: 'gate', dataDone: 'firstPostSent', phase: 'Step 3' }),
    step('c_invite', { kind: 'gate', dataDone: 'clientInvited', place: 'members' }),
    step('c_team', { kind: 'optional', dataDone: 'teamInvited', laterLabel: 'Later' }),
    step('c_brief', { chapter: 'ask', place: 'briefs', skipWhen: ['noBrief'] }),
    step('c_comment', { chapter: 'review', place: 'post', skipWhen: ['noOwnPost'] }),
    step('c_group', { chapter: 'talk', place: 'chat', skipWhen: ['noGroup'] }),
    step('c_sample', { chapter: 'talk', sampleOnly: true }),
    step('c_activity', { chapter: 'talk', place: 'shell' }),
  ],
  intro: {
    id: 'c_intro',
    route: 'creator',
    kind: 'intro',
    title: 'Intro',
    body: '',
    button: 'Start',
  },
  closing: {
    id: 'c_closing',
    route: 'creator',
    kind: 'closing',
    title: 'End',
    body: '',
    button: 'Done',
  },
};

const STATE: InductionState = {
  step: null,
  done: false,
  role: 'owner',
  postId: null,
  clientInvited: false,
  teamInvited: false,
};

const FACTS: InductionFacts = {
  hasWorkspace: true,
  hasBrief: true,
  hasPlan: true,
  hasReviewPost: true,
  hasOwnPost: true,
  hasGroup: true,
  hasVoiceNote: true,
  canCreateBrief: true,
};

const SENT = { postId: 'p1' };
const ALL_DATA = { postId: 'p1', clientInvited: true, teamInvited: true };

function input(
  state: Partial<InductionState> = {},
  facts: Partial<InductionFacts> = {},
): EngineInput {
  return { state: { ...STATE, ...state }, facts: { ...FACTS, ...facts } };
}

function shown(r: Resolution): string {
  if (r.kind === 'step') return r.step.id;
  if (r.kind === 'intro') return `intro@${r.steps[r.index]?.id ?? ''}`;
  return r.kind;
}

function resolve(state: Partial<InductionState> = {}, facts: Partial<InductionFacts> = {}): string {
  return shown(resolveGuide(SCRIPT, input(state, facts)));
}

const ids = (list: readonly Step[]): string[] => list.map((s) => s.id);

/** A probe over the fixture: which ids are on screen, which the data finished. */
function probe(visibleIds: string[], doneIds: string[] = []): StepProbe {
  return { visible: (s) => visibleIds.includes(s.id), done: (s) => doneIds.includes(s.id) };
}

const STEPS = SCRIPT.steps.filter((s) => s.sampleOnly !== true);
const at = (id: string): number => STEPS.findIndex((s) => s.id === id);

describe('parseInductionState', () => {
  it('narrows the proc jsonb', () => {
    expect(
      parseInductionState({
        step: 'c_chip',
        done_at: null,
        role: 'owner',
        post_id: 'p1',
        client_invited: true,
        team_invited: false,
      }),
    ).toEqual({
      step: 'c_chip',
      done: false,
      role: 'owner',
      postId: 'p1',
      clientInvited: true,
      teamInvited: false,
    });
  });

  it('reads done_at as done', () => {
    expect(parseInductionState({ done_at: '2026-10-15T00:00:00Z' }).done).toBe(true);
  });

  it('fails open (done) on anything malformed, never trapping anyone', () => {
    for (const raw of [null, undefined, 'x', 3, [], true]) {
      expect(parseInductionState(raw)).toEqual(FAIL_OPEN_STATE);
    }
    expect(FAIL_OPEN_STATE.done).toBe(true);
  });
});

describe('approverStageOf', () => {
  it('reads the approver who signed up alone from the stored step', () => {
    expect(approverStageOf({ step: 'approver_brand', done: false })).toBe('brand');
    expect(approverStageOf({ step: 'approver_waiting', done: false })).toBe('waiting');
    expect(approverStageOf({ step: WORKSPACE_STEP, done: false })).toBe('none');
    expect(approverStageOf({ step: 'approver_waiting', done: true })).toBe('none');
  });

  it('stores the Creator start as the first creator step', () => {
    expect(WORKSPACE_STEP).toBe(ROUTE_SCRIPTS.creator.steps[0]?.id);
  });
});

describe('stepDataDone', () => {
  it('reads each data key, and never finishes a DOM step', () => {
    const i = input({ postId: 'p1', clientInvited: true }, { hasWorkspace: false });
    expect(stepDataDone({ dataDone: 'none' }, i)).toBe(false);
    expect(stepDataDone({ dataDone: 'hasWorkspace' }, i)).toBe(false);
    expect(stepDataDone({ dataDone: 'firstPostSent' }, i)).toBe(true);
    expect(stepDataDone({ dataDone: 'clientInvited' }, i)).toBe(true);
    expect(stepDataDone({ dataDone: 'teamInvited' }, i)).toBe(false);
  });
});

describe('resolveGuide: stored ids', () => {
  it('starts at the workspace before one exists', () => {
    expect(resolve({}, { hasWorkspace: false })).toBe('c_ws');
  });

  it('keeps the second workspace step: same group, not overridden by its own setup', () => {
    expect(resolve({ step: 'c_ws_create' }, { hasWorkspace: false })).toBe('c_ws_create');
  });

  it('resolves a stored step within the route', () => {
    expect(resolve({ step: 'c_post_caption' })).toBe('c_post_caption');
    expect(resolve({ step: 'c_group', ...ALL_DATA })).toBe('c_group');
  });

  it('moves on from a step the data finished, storing nothing by hand', () => {
    expect(resolve({ step: 'c_post_send', ...SENT })).toBe('c_invite');
    expect(resolve({ step: 'c_team', ...ALL_DATA })).toBe('intro@c_brief');
  });

  it('is off once done, and never crashes on a null step', () => {
    expect(resolve({ done: true })).toBe('off');
    expect(resolve({ step: null })).toBe('c_chip');
  });
});

describe('resolveGuide: old and unknown ids resolve by data', () => {
  it('sends an old early creator id to the first open step after the data', () => {
    expect(resolve({ step: 'stages' })).toBe('c_chip');
    expect(resolve({ step: 'first_post' })).toBe('c_chip');
    expect(resolve({ step: 'workspace' }, { hasWorkspace: false })).toBe('c_ws');
  });

  it('never restarts a creator past the first post from zero', () => {
    for (const old of ['post_comments', 'assets', 'activity', 'chat_mic', 't_drafts', 'a_review']) {
      expect(resolve({ step: old, ...SENT })).toBe('c_invite');
      expect(resolve({ step: old, postId: 'p1', clientInvited: true })).toBe('c_team');
      expect(resolve({ step: old, ...ALL_DATA })).toBe('intro@c_brief');
    }
  });

  it('starts a route with no data-finished steps at its first step', () => {
    const noData: RouteScript = { ...SCRIPT, steps: SCRIPT.steps.slice(8) };
    expect(shown(resolveGuide(noData, input({ step: 'a_points' })))).toBe('intro@c_brief');
  });
});

describe('resolveGuide: gates and facts', () => {
  it('an earlier open gate overrides a later stored step, at the start of its group', () => {
    expect(resolve({ step: 'c_activity' })).toBe('c_post_create');
    expect(resolve({ step: 'c_brief', ...SENT })).toBe('c_invite');
  });

  it('drops steps a fact skips and moves on from a stored dropped step', () => {
    // A stored look-around step never brings the intro back.
    expect(resolve({ step: 'c_brief', ...ALL_DATA }, { hasBrief: false })).toBe('c_comment');
    expect(resolve({ step: 'c_group', ...ALL_DATA }, { hasGroup: false })).toBe('c_activity');
  });

  it('ignores sampleOnly steps', () => {
    expect(resolve({ step: 'c_sample', ...ALL_DATA })).toBe('c_activity');
    const r = resolveGuide(SCRIPT, input({ step: 'c_activity', ...ALL_DATA }));
    expect(r.kind === 'step' && ids(r.steps)).not.toContain('c_sample');
  });

  it('shows the closing card when nothing is left', () => {
    expect(resolve({ step: 'c_closing', ...ALL_DATA })).toBe('closing');
    const empty: RouteScript = { ...SCRIPT, steps: [step('c_only', { skipWhen: ['noBrief'] })] };
    expect(shown(resolveGuide(empty, input({}, { hasBrief: false })))).toBe('closing');
  });

  it('a closing id still yields to an open gate', () => {
    expect(resolve({ step: 'c_closing', ...SENT })).toBe('c_invite');
  });
});

describe('resolveGuide: the intro card', () => {
  it('shows before the first look-around step until Start stores it', () => {
    expect(resolve({ step: 'c_intro', ...ALL_DATA })).toBe('intro@c_brief');
    expect(resolve({ step: 'c_brief', ...ALL_DATA })).toBe('c_brief');
  });

  it('does not show on later look-around steps', () => {
    expect(resolve({ step: 'c_comment', ...ALL_DATA })).toBe('c_comment');
  });
});

describe('storedIdFor', () => {
  it('stores the intro id when entering the look-around from setup', () => {
    expect(storedIdFor(SCRIPT, STEPS, { from: at('c_team'), to: at('c_brief') })).toBe('c_intro');
  });

  it('stores the step id otherwise, and the closing id past the end', () => {
    expect(storedIdFor(SCRIPT, STEPS, { from: at('c_comment'), to: at('c_brief') })).toBe(
      'c_brief',
    );
    expect(storedIdFor(SCRIPT, STEPS, { from: 0, to: 1 })).toBe('c_ws_create');
    expect(storedIdFor(SCRIPT, STEPS, { from: STEPS.length - 1, to: STEPS.length })).toBe(
      'c_closing',
    );
  });
});

describe('completesByUi', () => {
  it('lets taps and the DOM finish teach, optional and an inner setup step only', () => {
    expect(completesByUi(STEPS, at('c_ws'))).toBe(true);
    expect(completesByUi(STEPS, at('c_ws_create'))).toBe(false);
    expect(completesByUi(STEPS, at('c_post_send'))).toBe(false);
    expect(completesByUi(STEPS, at('c_post_create'))).toBe(true);
    expect(completesByUi(STEPS, at('c_team'))).toBe(true);
    expect(completesByUi(STEPS, 99)).toBe(false);
  });
});

describe('Back', () => {
  it('goes to the previous step when its control is on screen', () => {
    expect(backIndex(STEPS, at('c_comment'), probe(['c_brief', 'c_chip']))).toBe(at('c_brief'));
  });

  it('else to the nearest earlier step whose control is', () => {
    expect(backIndex(STEPS, at('c_post_caption'), probe(['c_chip']))).toBe(at('c_chip'));
  });

  it('with no earlier control on screen, still goes to the previous open step (its place opens)', () => {
    expect(backIndex(STEPS, at('c_comment'), probe([]))).toBe(at('c_brief'));
  });

  it('never goes back to a step the data finished, and hides on the first step', () => {
    expect(
      backIndex(STEPS, at('c_chip'), probe(['c_ws', 'c_ws_create'], ['c_ws', 'c_ws_create'])),
    ).toBe(-1);
    expect(backIndex(STEPS, at('c_chip'), probe([], ['c_ws', 'c_ws_create']))).toBe(-1);
    expect(
      backIndex(
        STEPS,
        at('c_invite'),
        probe([], ['c_post_create', 'c_post_caption', 'c_post_send']),
      ),
    ).toBe(at('c_chip'));
    expect(backIndex(STEPS, 0, probe(['c_ws']))).toBe(-1);
  });
});

describe('the 4 s skip', () => {
  const SCREEN = [
    step('x_a', { chapter: 'talk', place: 'chat' }),
    step('x_b', { chapter: 'talk', place: 'chat' }),
    step('x_c', { chapter: 'talk', place: 'chat' }),
    step('x_d', { chapter: 'review', place: 'chat' }),
    step('x_act', { chapter: 'talk', place: 'shell' }),
    step('x_e', { chapter: 'talk', place: 'chat' }),
  ];

  it('moves forward to the next visible step on the same screen and chapter', () => {
    expect(skipTarget(SCREEN, 0, probe(['x_c']))).toBe(2);
  });

  it('never jumps to an always-visible control of a later place: one step on, its place opens', () => {
    expect(skipTarget(SCREEN, 0, probe(['x_act', 'x_e']))).toBe(1);
    expect(skipTarget(STEPS, at('c_brief'), probe(['c_activity', 'c_group']))).toBe(
      at('c_brief') + 1,
    );
  });

  it('never crosses into another chapter on the same screen', () => {
    expect(skipTarget(SCREEN, 2, probe(['x_d']))).toBe(3);
    expect(skipTarget(SCREEN, 1, probe(['x_d']))).toBe(2);
  });

  it('never skips past an open gate; goes back within the group instead', () => {
    expect(skipTarget(STEPS, at('c_post_caption'), probe(['c_post_create', 'c_invite']))).toBe(
      at('c_post_create'),
    );
  });

  it('a gate only goes back within its group, else stays', () => {
    expect(skipTarget(STEPS, at('c_post_send'), probe(['c_post_create']))).toBe(
      at('c_post_create'),
    );
    expect(skipTarget(STEPS, at('c_invite'), probe(['c_activity']))).toBe(at('c_invite'));
  });

  it('with nothing visible, moves to the next step so its place opens', () => {
    expect(skipTarget(STEPS, at('c_brief'), probe([]))).toBe(at('c_brief') + 1);
    expect(skipTarget(STEPS, STEPS.length - 1, probe([]))).toBe(STEPS.length);
  });
});

describe('progress and chapters', () => {
  it('fills (entry + index) over (entry + applicable steps)', () => {
    const r = resolveGuide(SCRIPT, input({ step: 'c_chip' }));
    expect(progressOf(SCRIPT, r)).toBeCloseTo((4 + 2) / (4 + 12));
    const fewer = resolveGuide(SCRIPT, input({ step: 'c_chip' }, { hasBrief: false }));
    expect(progressOf(SCRIPT, fewer)).toBeCloseTo((4 + 2) / (4 + 11));
    expect(progressOf(SCRIPT, { kind: 'closing', card: SCRIPT.closing, steps: STEPS })).toBe(1);
    expect(progressOf(SCRIPT, { kind: 'off' })).toBe(0);
  });

  it('reads the chapter order from the steps', () => {
    expect(chapterOrder(STEPS)).toEqual(['ask', 'review', 'talk']);
    expect(chapterOrder(ROUTE_SCRIPTS.approver.steps)).toEqual(['review', 'ask', 'talk']);
  });
});

describe('presetPrimaryFor', () => {
  it('sends for review on the post sheet steps of the creator and invited routes', () => {
    const creator = ROUTE_SCRIPTS.creator.steps;
    const sheet = creator.filter((s) => presetPrimaryFor(s) !== undefined).map((s) => s.id);
    expect(sheet).toContain('c_post_create');
    expect(sheet).toContain('c_post_send');
    expect(sheet).not.toContain('c_approved_chip');
    expect(ROUTE_SCRIPTS.invited.steps.some((s) => presetPrimaryFor(s) === 'send_for_review')).toBe(
      true,
    );
    expect(ROUTE_SCRIPTS.approver.steps.every((s) => presetPrimaryFor(s) === undefined)).toBe(true);
  });
});

describe('routes', () => {
  const ctx = { postId: 'p1', groupChannelId: 'group__ws__g1' };

  it('builds each place', () => {
    expect(placeRoute('members', ctx)).toBe('/settings?panel=members');
    expect(placeRoute('post', ctx)).toBe('/posts/p1');
    expect(placeRoute('post', { ...ctx, postId: null })).toBe('/pipeline');
    expect(placeRoute('group', ctx)).toBe('/chat?channel=group__ws__g1');
    expect(placeRoute('chat', ctx)).toBe('/chat');
    expect(placeRoute('shell', ctx)).toBe('');
  });

  it('knows when the person is on the step screen', () => {
    expect(onPlace('pipeline', { pathname: '/pipeline', search: '' }, ctx)).toBe(true);
    expect(onPlace('pipeline', { pathname: '/briefs', search: '' }, ctx)).toBe(false);
    expect(onPlace('members', { pathname: '/settings', search: '?panel=profile' }, ctx)).toBe(true);
    expect(onPlace('group', { pathname: '/chat', search: '?channel=group__ws__g1' }, ctx)).toBe(
      true,
    );
    expect(onPlace('group', { pathname: '/chat', search: '?channel=other' }, ctx)).toBe(false);
    expect(onPlace('chat', { pathname: '/chat', search: '' }, ctx)).toBe(true);
    expect(onPlace('chat', { pathname: '/chat', search: '?channel=x' }, ctx)).toBe(false);
    // The Activity steps live on the chat list: /chat with no channel.
    const activity = Object.values(ROUTE_SCRIPTS).flatMap((script) =>
      script.steps.filter((s) => s.targets.includes('activity-tab')),
    );
    for (const s of activity) {
      expect(onPlace(s.place, { pathname: '/chat', search: '' }, ctx)).toBe(true);
    }
    expect(onPlace('shell', { pathname: '/anything', search: '' }, ctx)).toBe(true);
  });
});

describe('the box', () => {
  it('is the control plus 7px (5px gap and 2px of air)', () => {
    expect(boxRect({ top: 100, left: 50, width: 44, height: 44 })).toEqual({
      top: 93,
      left: 43,
      width: 58,
      height: 58,
    });
  });

  it('takes radius 12 for a control up to 12px, else 16', () => {
    expect(guideRadius(0)).toBe(12);
    expect(guideRadius(12)).toBe(12);
    expect(guideRadius(12.5)).toBe(16);
    expect(guideRadius(999)).toBe(16);
  });

  it('pulls a full-width box inside the screen, leaves a fitting one alone', () => {
    expect(
      clampToViewport({ top: 100, left: -7, width: 404, height: 58 }, { width: 390, height: 844 }),
    ).toEqual({ top: 100, left: 2, width: 386, height: 58 });
    const fits = { top: 50, left: 20, width: 100, height: 40 };
    expect(clampToViewport(fits, { width: 390, height: 844 })).toEqual(fits);
  });

  it('puts the fingertip a little below and right of the centre', () => {
    const tip = handPoint({ top: 100, left: 100, width: 44, height: 44 });
    expect(tip.x).toBeGreaterThan(122);
    expect(tip.y).toBeGreaterThan(122);
    expect(tip.x).toBeLessThan(144);
    expect(tip.y).toBeLessThan(144);
  });
});

describe('resolveGuide: the intro never returns mid-route', () => {
  it('stays away once a look-around step was stored, even when data drops earlier ones', () => {
    // After approval the Review steps drop: the stored step is gone, the next is now first.
    const dropped = { step: 'c_comment', ...ALL_DATA };
    expect(resolve(dropped, { hasBrief: false, hasOwnPost: false })).toBe('c_group');
    expect(resolve({ step: 'c_closing', ...ALL_DATA })).toBe('closing');
  });

  it('shows for a setup step, an unknown id, nothing stored, or the intro id', () => {
    expect(resolve({ step: 'c_team', ...ALL_DATA })).toBe('intro@c_brief');
    expect(resolve({ step: 'a_review', ...ALL_DATA })).toBe('intro@c_brief');
    expect(resolve({ step: 'c_intro', ...ALL_DATA })).toBe('intro@c_brief');
    const lookAroundOnly: RouteScript = { ...SCRIPT, steps: SCRIPT.steps.slice(8) };
    expect(shown(resolveGuide(lookAroundOnly, input({ step: null })))).toBe('intro@c_brief');
  });
});

describe('placeLabel', () => {
  const label = { width: 180, height: 32 };
  const area = { top: 0, bottom: 760, width: 390, viewportHeight: 844 };
  const inside = (p: { top: number; left: number }): boolean =>
    p.left >= 0 && p.top >= 0 && p.left + label.width <= 390 && p.top + label.height <= 844;

  it('goes below the box', () => {
    const box = boxRect({ top: 120, left: 16, width: 300, height: 44 });
    const p = placeLabel({ box, label, area });
    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThanOrEqual(box.top + box.height);
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
    expect(inside(p)).toBe(true);
  });

  it('goes above when there is no room below', () => {
    const box = boxRect({ top: 700, left: 100, width: 200, height: 44 });
    const p = placeLabel({ box, label, area });
    expect(p.side).toBe('above');
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
    expect(inside(p)).toBe(true);
  });

  it('takes the left side in the same row for a short control at the right edge', () => {
    const box = boxRect({ top: 12, left: 334, width: 44, height: 44 });
    const p = placeLabel({ box, label, area });
    expect(p.side).toBe('left');
    expect(p.left + label.width).toBeLessThanOrEqual(box.left);
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
    expect(inside(p)).toBe(true);
  });

  it('goes over the bar, never over the box, when a tall box leaves the free band no room', () => {
    const box = boxRect({ top: 20, left: 0, width: 390, height: 640 });
    const p = placeLabel({
      box,
      label,
      area: { top: 0, bottom: 700, width: 390, viewportHeight: 844 },
    });
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
    expect(p.top + label.height).toBeLessThanOrEqual(844);
    expect(p.top).toBeGreaterThan(700 - label.height);
  });

  it('puts the label inside the bottom edge of a box spanning the viewport, clear of its centre', () => {
    const box = boxRect({ top: 4, left: 0, width: 390, height: 830 });
    const p = placeLabel({
      box,
      label,
      area: { top: 0, bottom: 760, width: 390, viewportHeight: 844 },
    });
    expect(p.side).toBe('inside');
    expect(p.top).toBeGreaterThan(box.top + box.height / 2);
    expect(p.top + label.height).toBeLessThanOrEqual(844);
  });

  it('a box under 60% of the viewport with no room takes the side with most room', () => {
    const box = boxRect({ top: 300, left: 0, width: 390, height: 400 });
    const p = placeLabel({
      box,
      label: { width: 180, height: 320 },
      area: { top: 0, bottom: 760, width: 390, viewportHeight: 844 },
    });
    expect(p.side).not.toBe('inside');
  });

  it('never lands on the laptop bottom-right guide card; falls back to the next side', () => {
    const laptop = { top: 0, bottom: 800, width: 1280, viewportHeight: 800 };
    const card = { top: 640, left: 924, width: 340, height: 144 };
    const box = boxRect({ top: 600, left: 1000, width: 200, height: 44 });
    const free = placeLabel({ box, label, area: laptop });
    expect(overlaps({ ...free, ...label }, card)).toBe(true);
    const p = placeLabel({ box, label, area: { ...laptop, obstacle: card } });
    expect(p.side).toBe('above');
    expect(overlaps({ ...p, ...label }, card)).toBe(false);
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
  });

  it('stays inside the viewport for a control at the left edge', () => {
    const box = boxRect({ top: 300, left: 0, width: 40, height: 40 });
    const p = placeLabel({ box, label, area });
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(overlaps({ ...p, ...label }, box)).toBe(false);
  });
});

describe('barSide', () => {
  const frame = { viewportHeight: 844, insets: { top: 0, bottom: 56 }, barHeight: 80 };
  const bottomBarTop = 844 - 56 - 8 - 80;
  const topBarBottom = 8 + 80;
  const box = (top: number, height = 40) => ({ top, left: 0, width: 40, height });

  it('docks bottom by default and whenever the bottom bar clears the box', () => {
    expect(barSide(undefined, frame)).toBe('bottom');
    expect(barSide(box(100), frame)).toBe('bottom');
    expect(barSide(box(bottomBarTop - 40), frame)).toBe('bottom');
  });

  it('docks top when the bottom bar would cover the box, and the top bar clears it', () => {
    const low = box(bottomBarTop - 20);
    expect(barSide(low, frame)).toBe('top');
    expect(low.top).toBeGreaterThanOrEqual(topBarBottom);
  });

  it('takes the side with more room when both bars would cover a tall box', () => {
    expect(barSide(box(40, 700), frame)).toBe('bottom');
    expect(barSide(box(60, 760), frame)).toBe('top');
  });
});

describe('the first post', () => {
  it('needs media for visual formats only', () => {
    for (const f of ['reel', 'story', 'carousel', 'single_image', 'video', 'short']) {
      expect(formatNeedsMedia(f)).toBe(true);
    }
    for (const f of ['text', 'link', 'thread', '']) expect(formatNeedsMedia(f)).toBe(false);
  });

  it('takes the title from the caption first line, cut at a word', () => {
    expect(titleFromCaption('  Diwali drop\nSecond line')).toBe('Diwali drop');
    const long = 'word '.repeat(30).trim();
    const title = titleFromCaption(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('word')).toBe(true);
  });

  it('retries three times, then gives a plain reason', async () => {
    const attempt = vi.fn(async () => ({ ok: false as const }));
    const onRetry = vi.fn();
    const out = await withRetries(attempt, 3, onRetry);
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(onRetry.mock.calls.map((c) => c[0])).toEqual([2, 3, 4]);
    expect(out).toEqual({ ok: false, failures: 4 });
    expect(uploadFailedReason(2)).toBe(
      'The file did not reach us. Your connection dropped twice. Try again or pick a smaller file.',
    );
    expect(uploadFailedReason(4)).toContain('dropped 4 times');
  });

  it('stops retrying on the first success, and counts a throw as a failure', async () => {
    let n = 0;
    const out = await withRetries(
      async () => {
        n += 1;
        if (n === 1) throw new Error('network');
        return { ok: true as const, value: 'v1' };
      },
      3,
      () => undefined,
    );
    expect(out).toEqual({ ok: true, value: 'v1' });
    expect(n).toBe(2);
  });
});

describe('brandRequestErrorMessage', () => {
  it('maps too_many_requests to the five-sends line', () => {
    expect(brandRequestErrorMessage('too_many_requests')).toBe(
      'You have sent this 5 times. Ask them to check spam, or write to us.',
    );
    expect(brandRequestErrorMessage('invalid_payload')).toContain('email');
    expect(brandRequestErrorMessage('boom')).toBe("We couldn't send that. Try again.");
  });
});
