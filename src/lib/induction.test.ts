import { describe, expect, it, vi } from 'vitest';
import {
  APPROVER_STEPS,
  CREATOR_STEPS,
  FAIL_OPEN_STATE,
  INDUCTION_KEYS,
  STEP_ID_PATTERN,
  TEAMMATE_STEPS,
  approverStageOf,
  boxRect,
  boxRadius,
  clampToViewport,
  brandRequestErrorMessage,
  formatNeedsMedia,
  hardGates,
  onPlace,
  overlaps,
  parseInductionState,
  pathFor,
  placeCard,
  placeRoute,
  resolveStep,
  stepButtons,
  stepCopy,
  stripRect,
  titleFromCaption,
  uploadFailedReason,
  withRetries,
  type InductionAvailability,
  type InductionState,
} from './induction';

const FRESH: InductionState = {
  step: null,
  done: false,
  role: 'owner',
  postId: null,
  clientInvited: false,
  teamInvited: false,
};

const EVERYWHERE: InductionAvailability = {
  hasWorkspace: true,
  postId: 'post-1',
  groupChannelId: 'group__ws__g1',
};

function stepOf(r: ReturnType<typeof resolveStep>): string {
  return r.kind === 'step' ? r.step.id : r.kind;
}

describe('parseInductionState', () => {
  it('narrows the proc jsonb', () => {
    expect(
      parseInductionState({
        step: 'stages',
        done_at: null,
        role: 'owner',
        post_id: 'p1',
        client_invited: true,
        team_invited: false,
      }),
    ).toEqual({
      step: 'stages',
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

describe('pathFor', () => {
  it('maps workspace roles to the three paths', () => {
    expect(pathFor('owner', true)).toBe('creator');
    expect(pathFor('admin', true)).toBe('teammate');
    expect(pathFor('agency', true)).toBe('teammate');
    expect(pathFor('client', true)).toBe('approver');
    expect(pathFor(null, true)).toBe('none');
  });

  it('is the Creator making a workspace before one exists', () => {
    expect(pathFor(null, false)).toBe('creator');
  });
});

describe('the steps', () => {
  it('has exactly two hard gates: the first post sent for review and the approver invite', () => {
    expect(hardGates().map((s) => s.id)).toEqual(['first_post', 'approver_invite']);
  });

  it('gives a hard gate no Next and no Later', () => {
    for (const gate of hardGates())
      expect(stepButtons(gate)).toEqual({ next: false, later: false });
  });

  it('gives teach steps Next and optional steps Next and Later', () => {
    expect(stepButtons({ kind: 'teach' })).toEqual({ next: true, later: false });
    expect(stepButtons({ kind: 'optional' })).toEqual({ next: true, later: true });
    expect(stepButtons({ kind: 'setup' })).toEqual({ next: false, later: false });
  });

  it('stores only ids induction_step_set accepts, unique per path', () => {
    for (const steps of [CREATOR_STEPS, APPROVER_STEPS, TEAMMATE_STEPS]) {
      const ids = steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(STEP_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('points every step at known controls', () => {
    const keys = new Set<string>(Object.values(INDUCTION_KEYS));
    for (const step of [...CREATOR_STEPS, ...APPROVER_STEPS, ...TEAMMATE_STEPS]) {
      expect(step.targets.length).toBeGreaterThan(0);
      for (const key of step.targets) expect(keys.has(key)).toBe(true);
    }
  });

  it('keeps the copy free of em-dashes, "trial", and "agency" or "client" for people', () => {
    for (const step of [...CREATOR_STEPS, ...APPROVER_STEPS, ...TEAMMATE_STEPS]) {
      const text = `${step.title} ${step.body} ${step.laterLabel ?? ''}`;
      expect(text).not.toMatch(/\u2014|\btrial\b|\bagency\b|\bclient\b/i);
    }
  });

  it('fills the workspace label into the approver top bar step', () => {
    const first = APPROVER_STEPS[0];
    if (first === undefined) throw new Error('no approver steps');
    expect(stepCopy(first, 'Kite - Instagram').title).toBe('Kite - Instagram');
  });
});

describe('resolveStep: creator', () => {
  it('starts at the workspace slot before a workspace exists', () => {
    const r = resolveStep({
      path: 'creator',
      state: FRESH,
      where: { hasWorkspace: false, postId: null, groupChannelId: null },
    });
    expect(stepOf(r)).toBe('workspace');
    expect(r.kind === 'step' && r.part).toBe(1);
  });

  it('moves past the workspace once it exists, to the stage row', () => {
    const r = resolveStep({ path: 'creator', state: FRESH, where: EVERYWHERE });
    expect(stepOf(r)).toBe('stages');
    expect(r.kind === 'step' ? `${r.part} of ${r.parts}` : '').toBe('2 of 8');
  });

  it('holds on the first post gate until a post reaches review', () => {
    const state = { ...FRESH, step: 'assets' };
    expect(stepOf(resolveStep({ path: 'creator', state, where: EVERYWHERE }))).toBe('first_post');
  });

  it('then holds on the approver invite gate', () => {
    const state = { ...FRESH, step: 'first_post', postId: 'p1' };
    expect(stepOf(resolveStep({ path: 'creator', state, where: EVERYWHERE }))).toBe(
      'approver_invite',
    );
  });

  it('skips Add other creators when a teammate is already invited', () => {
    const state = { ...FRESH, step: 'approver_invite', postId: 'p1', clientInvited: true };
    expect(stepOf(resolveStep({ path: 'creator', state, where: EVERYWHERE }))).toBe('team_invite');
    expect(
      stepOf(
        resolveStep({ path: 'creator', state: { ...state, teamInvited: true }, where: EVERYWHERE }),
      ),
    ).toBe('post_comments');
  });

  it('resumes at the stored teach step on any device once the gates are done', () => {
    const state = { ...FRESH, step: 'activity', postId: 'p1', clientInvited: true };
    expect(stepOf(resolveStep({ path: 'creator', state, where: EVERYWHERE }))).toBe('activity');
  });

  it('starts from the top when the stored step belongs to another path', () => {
    const state = { ...FRESH, step: 'a_briefs' };
    expect(stepOf(resolveStep({ path: 'creator', state, where: EVERYWHERE }))).toBe('stages');
  });

  it('drops the group steps when there is no group and closes up the numbering', () => {
    const state = { ...FRESH, step: 'activity', postId: 'p1', clientInvited: true };
    const r = resolveStep({
      path: 'creator',
      state,
      where: { ...EVERYWHERE, groupChannelId: null },
    });
    expect(r.kind === 'step' && r.nextId).toBe('finish');
    expect(r.kind === 'step' ? r.parts : 0).toBe(7);
  });

  it('finishes past the last step, and is off once done', () => {
    const last = CREATOR_STEPS[CREATOR_STEPS.length - 1];
    const state = { ...FRESH, step: last?.id ?? '', postId: 'p1', clientInvited: true };
    const r = resolveStep({ path: 'creator', state, where: EVERYWHERE });
    expect(r.kind === 'step' && r.nextId).toBe('finish');
    expect(
      resolveStep({ path: 'creator', state: { ...state, done: true }, where: EVERYWHERE }),
    ).toEqual({ kind: 'off' });
  });
});

describe('resolveStep: approver and teammate', () => {
  it('walks an approver from the top bar, with no gate on the way', () => {
    const state = { ...FRESH, role: 'client' };
    expect(stepOf(resolveStep({ path: 'approver', state, where: EVERYWHERE }))).toBe('a_workspace');
    expect(APPROVER_STEPS.some((s) => s.kind === 'gate')).toBe(false);
  });

  it('skips the approver post steps when nothing is in review', () => {
    const state = { ...FRESH, role: 'client', step: 'a_review' };
    const r = resolveStep({ path: 'approver', state, where: { ...EVERYWHERE, postId: null } });
    expect(r.kind === 'step' && r.nextId).toBe('a_assets');
  });

  it('skips the New brief step for a viewer without brief.create', () => {
    const state = { ...FRESH, role: 'client', step: 'a_assets' };
    const kept = resolveStep({ path: 'approver', state, where: EVERYWHERE });
    expect(kept.kind === 'step' && kept.nextId).toBe('a_briefs');
    const unknown = { ...EVERYWHERE, canCreateBrief: null };
    const stillKept = resolveStep({ path: 'approver', state, where: unknown });
    expect(stillKept.kind === 'step' && stillKept.nextId).toBe('a_briefs');
    const without = { ...EVERYWHERE, canCreateBrief: false };
    const skipped = resolveStep({ path: 'approver', state, where: without });
    expect(skipped.kind === 'step' && skipped.nextId).toBe('a_activity');
    // Resuming on the dropped step moves on instead of pointing at a missing "+".
    const resumed = resolveStep({
      path: 'approver',
      state: { ...state, step: 'a_briefs' },
      where: without,
    });
    expect(resumed.kind === 'step' && resumed.step.id).not.toBe('a_briefs');
  });

  it('opens a teammate on the Draft chip', () => {
    const state = { ...FRESH, role: 'agency' };
    expect(stepOf(resolveStep({ path: 'teammate', state, where: EVERYWHERE }))).toBe('t_drafts');
    expect(TEAMMATE_STEPS.some((s) => s.kind === 'gate')).toBe(false);
  });

  it('is off for an unknown role', () => {
    expect(resolveStep({ path: 'none', state: FRESH, where: EVERYWHERE })).toEqual({ kind: 'off' });
  });
});

describe('approverStageOf', () => {
  it('reads the approver who signed up alone from the stored step', () => {
    expect(approverStageOf({ step: 'approver_brand', done: false })).toBe('brand');
    expect(approverStageOf({ step: 'approver_waiting', done: false })).toBe('waiting');
    expect(approverStageOf({ step: 'workspace', done: false })).toBe('none');
    expect(approverStageOf({ step: 'approver_waiting', done: true })).toBe('none');
  });
});

describe('routes', () => {
  const ctx = { postId: 'p1', groupChannelId: 'group__ws__g1' };

  it('builds each place', () => {
    expect(placeRoute('members', ctx)).toBe('/settings?panel=members');
    expect(placeRoute('post', ctx)).toBe('/posts/p1');
    expect(placeRoute('group', ctx)).toBe('/chat?channel=group__ws__g1');
  });

  it('knows when the person is on the step screen', () => {
    expect(onPlace('pipeline', { pathname: '/pipeline', search: '' }, ctx)).toBe(true);
    expect(onPlace('pipeline', { pathname: '/assets', search: '' }, ctx)).toBe(false);
    expect(onPlace('members', { pathname: '/settings', search: '?panel=profile' }, ctx)).toBe(true);
    expect(onPlace('group', { pathname: '/chat', search: '?channel=group__ws__g1' }, ctx)).toBe(
      true,
    );
    expect(onPlace('group', { pathname: '/chat', search: '?channel=other' }, ctx)).toBe(false);
    expect(onPlace('shell', { pathname: '/anything', search: '' }, ctx)).toBe(true);
  });
});

describe('the box', () => {
  it('sits 5px off the control behind a 2px border', () => {
    expect(boxRect({ top: 100, left: 50, width: 44, height: 44 })).toEqual({
      top: 93,
      left: 43,
      width: 58,
      height: 58,
    });
  });

  it('grows the control radius so the corners run parallel', () => {
    expect(boxRadius(8)).toBe(15);
    expect(boxRadius(-1)).toBe(7);
  });
});

describe('placeCard', () => {
  const card = { width: 358, height: 150 };
  const phone = { width: 390, height: 844 };
  const insets = { top: 0, bottom: 56 };

  it('docks bottom above the tab bar on a phone by default', () => {
    const target = { top: 120, left: 16, width: 200, height: 44 };
    const at = placeCard({ target, card, viewport: phone, phone: true, insets });
    expect(at.side).toBe('bottom');
    expect(at.top).toBe(844 - 56 - 8 - 150);
    expect(overlaps({ ...at, ...card }, boxRect(target))).toBe(false);
  });

  it('docks top on a phone when the control is in the lower half', () => {
    const target = { top: 700, left: 300, width: 44, height: 44 };
    const at = placeCard({ target, card, viewport: phone, phone: true, insets });
    expect(at.side).toBe('top');
    expect(overlaps({ ...at, ...card }, boxRect(target))).toBe(false);
  });

  it('docks top when the bottom dock would cover an upper control that runs low', () => {
    const target = { top: 380, left: 16, width: 358, height: 40 };
    const at = placeCard({ target, card, viewport: phone, phone: true, insets });
    expect(overlaps({ ...at, ...card }, boxRect(target))).toBe(false);
  });

  const laptop = { width: 1280, height: 800 };
  const small = { width: 320, height: 140 };
  const noInsets = { top: 0, bottom: 0 };

  it('goes below a control on a laptop when there is room', () => {
    const target = { top: 60, left: 400, width: 44, height: 44 };
    const at = placeCard({ target, card: small, viewport: laptop, phone: false, insets: noInsets });
    expect(at.side).toBe('below');
    expect(at.top).toBeGreaterThan(target.top + target.height);
  });

  it('goes right of a control near the bottom with room on the right', () => {
    const target = { top: 700, left: 300, width: 44, height: 44 };
    const at = placeCard({ target, card: small, viewport: laptop, phone: false, insets: noInsets });
    expect(at.side).toBe('right');
    expect(overlaps({ ...at, ...small }, boxRect(target))).toBe(false);
  });

  it('goes left when the control sits at the bottom right', () => {
    const target = { top: 700, left: 1180, width: 60, height: 44 };
    const at = placeCard({ target, card: small, viewport: laptop, phone: false, insets: noInsets });
    expect(at.side).toBe('left');
    expect(overlaps({ ...at, ...small }, boxRect(target))).toBe(false);
  });

  it('goes above a wide control at the bottom', () => {
    const target = { top: 700, left: 0, width: 1280, height: 60 };
    const at = placeCard({ target, card: small, viewport: laptop, phone: false, insets: noInsets });
    expect(at.side).toBe('above');
    expect(overlaps({ ...at, ...small }, boxRect(target))).toBe(false);
  });
});

describe('stripRect', () => {
  it('sits under the sheet title, short of the close button', () => {
    const title = { top: 27, left: 18, width: 80, height: 20 };
    const dialog = { top: 0, left: 0, width: 540, height: 600 };
    const r = stripRect(title, dialog);
    expect(r.top).toBe(49);
    expect(r.left).toBe(18);
    expect(r.left + r.width).toBeLessThanOrEqual(540 - 44 - 16);
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

describe('placeCard never leaves the screen', () => {
  it('pulls the card inside the viewport when the control is scrolled off the top', () => {
    const target = { top: -400, left: 300, width: 700, height: 200 };
    const at = placeCard({
      target,
      card: { width: 320, height: 140 },
      viewport: { width: 1280, height: 800 },
      phone: false,
      insets: { top: 0, bottom: 0 },
    });
    expect(at.top).toBeGreaterThanOrEqual(16);
    expect(at.top + 140).toBeLessThanOrEqual(800 - 16);
    expect(at.left + 320).toBeLessThanOrEqual(1280 - 16);
  });
});

describe('clampToViewport', () => {
  it('pulls a box for a full-width control inside the screen so all four sides show', () => {
    const r = clampToViewport(
      { top: 100, left: -7, width: 404, height: 58 },
      { width: 390, height: 844 },
    );
    expect(r).toEqual({ top: 100, left: 2, width: 386, height: 58 });
  });

  it('leaves a box that already fits alone', () => {
    const box = { top: 50, left: 20, width: 100, height: 40 };
    expect(clampToViewport(box, { width: 390, height: 844 })).toEqual(box);
  });
});
