import { describe, expect, it } from 'vitest';
import { fillCopy } from './induction-copy';
import { ROUTE_PREFIX, type CopyContext, type InductionFacts, type Step } from './induction-model';
import { ROUTE_SCRIPTS, isApplicable, routeFor, stepById } from './induction-routes';

const CTX: CopyContext = {
  brand: 'Bloom',
  platform: 'Instagram',
  post: 'Launch day',
  creator: 'Asha',
  inviter: 'Ravi',
  email: 'a@b.co',
};

const ALL_FACTS: InductionFacts = {
  hasWorkspace: true,
  hasBrief: true,
  hasPlan: true,
  hasReviewPost: true,
  hasOwnPost: true,
  hasGroup: true,
  hasVoiceNote: true,
  canCreateBrief: true,
};

const SCRIPTS = Object.values(ROUTE_SCRIPTS);
const ALL_STEPS = SCRIPTS.flatMap((script) => script.steps);

function ids(steps: readonly Step[]): string[] {
  return steps.map((step) => step.id);
}

const TEAM_LOOK_AROUND = [
  'brief_open',
  'plan_open',
  'line_select',
  'comment_button',
  'comment_post',
  'group_open',
  'transcript',
  'activity',
];
const FIRST_POST = [
  'post_create',
  'post_caption',
  'post_format',
  'post_single',
  'post_media',
  'post_send',
];

describe('route order', () => {
  it('creator', () => {
    expect(ids(ROUTE_SCRIPTS.creator.steps)).toEqual(
      [
        'workspace',
        'workspace_continue',
        'workspace_create',
        'approved_chip',
        ...FIRST_POST,
        'approver_invite',
        'team_invite',
        ...TEAM_LOOK_AROUND,
      ].map((id) => `c_${id}`),
    );
  });

  it('invited', () => {
    expect(ids(ROUTE_SCRIPTS.invited.steps)).toEqual(
      ['approved_chip', ...FIRST_POST, ...TEAM_LOOK_AROUND].map((id) => `i_${id}`),
    );
  });

  it('approver', () => {
    expect(ids(ROUTE_SCRIPTS.approver.steps)).toEqual(
      [
        'post_open',
        'line_select',
        'comment_button',
        'comment_post',
        'approve',
        'approve_confirm',
        'brief_add',
        'brief_title',
        'brief_objective',
        'brief_create',
        'group_open',
        'transcript',
        'activity',
      ].map((id) => `a_${id}`),
    );
  });

  it('entry steps', () => {
    expect(ROUTE_SCRIPTS.creator.entrySteps).toBe(4);
    expect(ROUTE_SCRIPTS.invited.entrySteps).toBe(3);
    expect(ROUTE_SCRIPTS.approver.entrySteps).toBe(3);
  });

  it('the creator route counts the two Continue taps the hand shows in its entry steps', () => {
    expect(ROUTE_SCRIPTS.creator.entryTargets).toEqual([
      'onboarding-name-continue',
      'onboarding-role-continue',
    ]);
    expect(ROUTE_SCRIPTS.creator.entrySteps).toBeGreaterThanOrEqual(
      ROUTE_SCRIPTS.creator.entryTargets.length,
    );
    expect(ROUTE_SCRIPTS.invited.entryTargets).toEqual([]);
    expect(ROUTE_SCRIPTS.approver.entryTargets).toEqual([]);
  });

  it('chapters run Ask, Review, Talk for the team and Review, Ask, Talk for the approver', () => {
    const chapters = (steps: readonly Step[]): string[] => [
      ...new Set(steps.flatMap((step) => (step.chapter === undefined ? [] : [step.chapter]))),
    ];
    expect(chapters(ROUTE_SCRIPTS.creator.steps)).toEqual(['ask', 'review', 'talk']);
    expect(chapters(ROUTE_SCRIPTS.invited.steps)).toEqual(['ask', 'review', 'talk']);
    expect(chapters(ROUTE_SCRIPTS.approver.steps)).toEqual(['review', 'ask', 'talk']);
    expect(ROUTE_SCRIPTS.approver.intro.pills).toEqual(['Review', 'Ask', 'Talk']);
    expect(ROUTE_SCRIPTS.creator.intro.pills).toEqual(['Ask', 'Review', 'Talk']);
  });
});

describe('step shape', () => {
  it('every id carries its route prefix, matches the pattern and is unique', () => {
    for (const step of ALL_STEPS) {
      expect(step.id.startsWith(ROUTE_PREFIX[step.route])).toBe(true);
      expect(step.id).toMatch(/^[a-z0-9_]{1,40}$/);
    }
    expect(new Set(ids(ALL_STEPS)).size).toBe(ALL_STEPS.length);
  });

  it('card ids carry the route prefix', () => {
    for (const script of SCRIPTS) {
      const prefix = ROUTE_PREFIX[script.route];
      expect(script.intro.id).toBe(`${prefix}intro`);
      expect(script.closing.id).toBe(`${prefix}closing`);
    }
  });

  it('every step sits in its script route, has a target and a label', () => {
    for (const script of SCRIPTS) {
      for (const step of script.steps) {
        expect(step.route).toBe(script.route);
        expect(step.targets.length).toBeGreaterThan(0);
        expect(step.label.trim()).not.toBe('');
      }
    }
  });

  it('a step has a phase or a chapter, never both', () => {
    for (const step of ALL_STEPS) {
      expect(step.phase === undefined).not.toBe(step.chapter === undefined);
    }
  });

  it('label and why together stay under 66 characters once filled', () => {
    for (const step of ALL_STEPS) {
      const filled = fillCopy(step.label, CTX) + fillCopy(step.why, CTX);
      expect(filled.length, step.id).toBeLessThan(66);
    }
  });

  it('the first post steps finish once the post is sent; send is a gate', () => {
    for (const route of ['creator', 'invited'] as const) {
      for (const id of FIRST_POST) {
        expect(stepById(`${ROUTE_PREFIX[route]}${id}`)?.dataDone).toBe('firstPostSent');
      }
      expect(stepById(`${ROUTE_PREFIX[route]}post_send`)?.kind).toBe('gate');
    }
  });

  it('Activity runs from the chat list, where the tab bar shows', () => {
    for (const id of ['c_activity', 'i_activity', 'a_activity']) {
      expect(stepById(id)).toMatchObject({ place: 'chat', chapter: 'talk' });
    }
  });

  it('route-specific lines', () => {
    expect(stepById('c_post_send')?.why).toBe('Next, you invite your approver.');
    expect(stepById('i_post_send')?.why).toBe('The approvers get it.');
    expect(stepById('a_comment_post')?.why).toBe('The team sees it on the post.');
    expect(stepById('c_comment_post')?.why).toBe('It stays on the post, not on WhatsApp.');
    expect(stepById('c_team_invite')).toMatchObject({
      kind: 'optional',
      dataDone: 'teamInvited',
      laterLabel: "It's just me for now",
    });
    expect(stepById('c_approver_invite')).toMatchObject({
      kind: 'gate',
      dataDone: 'clientInvited',
    });
    expect(stepById('c_workspace')).toMatchObject({ kind: 'setup', dataDone: 'hasWorkspace' });
  });
});

describe('routeFor', () => {
  it('no workspace means creator, whatever the role', () => {
    expect(routeFor({ role: null, hasWorkspace: false })).toBe('creator');
    expect(routeFor({ role: 'client', hasWorkspace: false })).toBe('creator');
  });

  it('maps roles', () => {
    expect(routeFor({ role: 'owner', hasWorkspace: true })).toBe('creator');
    expect(routeFor({ role: 'admin', hasWorkspace: true })).toBe('invited');
    expect(routeFor({ role: 'agency', hasWorkspace: true })).toBe('invited');
    expect(routeFor({ role: 'client', hasWorkspace: true })).toBe('approver');
    expect(routeFor({ role: 'viewer', hasWorkspace: true })).toBe('none');
    expect(routeFor({ role: null, hasWorkspace: true })).toBe('none');
  });
});

describe('stepById', () => {
  it('finds steps across routes', () => {
    expect(stepById('a_approve')?.route).toBe('approver');
    expect(stepById('i_activity')?.route).toBe('invited');
    expect(stepById('nope')).toBeUndefined();
  });
});

describe('isApplicable', () => {
  const plan = stepById('c_plan_open') as Step;

  it('the plan step lives on the chat PlanCard, not in a brief', () => {
    for (const id of ['c_plan_open', 'i_plan_open']) {
      expect(stepById(id)).toMatchObject({
        place: 'group',
        chapter: 'ask',
        skipWhen: ['noGroup', 'noPlan'],
      });
    }
    expect(isApplicable(plan, { ...ALL_FACTS, hasBrief: false })).toBe(true);
  });

  it('keeps a step when no skip fact holds', () => {
    expect(isApplicable(plan, ALL_FACTS)).toBe(true);
    expect(isApplicable(stepById('c_activity') as Step, ALL_FACTS)).toBe(true);
  });

  it('drops a step when any skip fact holds', () => {
    expect(isApplicable(plan, { ...ALL_FACTS, hasGroup: false })).toBe(false);
    expect(isApplicable(plan, { ...ALL_FACTS, hasPlan: false })).toBe(false);
    expect(isApplicable(stepById('c_brief_open') as Step, { ...ALL_FACTS, hasBrief: false })).toBe(
      false,
    );
    expect(
      isApplicable(stepById('c_line_select') as Step, { ...ALL_FACTS, hasOwnPost: false }),
    ).toBe(false);
    expect(
      isApplicable(stepById('a_transcript') as Step, { ...ALL_FACTS, hasVoiceNote: false }),
    ).toBe(false);
  });

  it('cannotCreateBrief drops only on false, not while unknown', () => {
    const add = stepById('a_brief_add') as Step;
    expect(isApplicable(add, { ...ALL_FACTS, canCreateBrief: null })).toBe(true);
    expect(isApplicable(add, { ...ALL_FACTS, canCreateBrief: false })).toBe(false);
  });

  it('drops sampleOnly steps', () => {
    expect(isApplicable({ ...plan, sampleOnly: true }, ALL_FACTS)).toBe(false);
    expect(isApplicable({ ...plan, sampleOnly: false }, ALL_FACTS)).toBe(true);
  });
});
